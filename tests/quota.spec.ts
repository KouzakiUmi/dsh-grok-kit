//

// Part of dsh-grok-kit, Apache-2.0.

//

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_QUOTA_TIMEOUT_MS,
  GROK_BILLING_URL,
  GROK_SETTINGS_URL,
  MAX_QUOTA_RESPONSE_BYTES,
  QuotaResponseError,
  SuperGrokQuotaClient,
  normalizeSuperGrokQuota,
  type QuotaSnapshot,
} from '../src/quota.ts'
import { GROK_GRPC_CREDITS_URL, GROK_GRPC_EMPTY_FRAME } from '../src/grok-credits.ts'
import type { XaiOAuthTokenSource } from '../src/token-source.ts'
import { encodeCreditsGrpcWeb } from './grok-credits-frame.ts'

function jsonBody(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const BILLING_SUCCESS = {
  config: {
    creditUsagePercent: 42.5,
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-19T00:00:00Z' },
    prepaidBalance: { val: 500 },
  },
}
const SETTINGS_SUCCESS = { subscription_tier_display: 'SuperGrok' }

interface FetchCall {
  url: string
  init: RequestInit
}

type BillingStub = () => Response | Promise<Response>
type SettingsStub = (() => Response | Promise<Response>) | undefined

function makeFetch(billing: BillingStub, settings: SettingsStub = () => jsonBody(SETTINGS_SUCCESS)) {
  const calls: FetchCall[] = []
  const fetcher = vi.fn(async (input: unknown, init?: unknown): Promise<Response> => {
    const url = String(input)
    calls.push({ url, init: init as RequestInit })
    return await (url === GROK_SETTINGS_URL ? settings() : billing())
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

/** gRPC-web credits response for the fallback probe (GROK-QUOTA-CREDITS-001). */
function grpcCreditsBody(options: { percent?: number; start?: string; end?: string }): Response {
  return new Response(encodeCreditsGrpcWeb(options), {
    status: 200,
    headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': '0' },
  })
}

/** Three-way fetch stub: REST billing, optional settings, and the gRPC-web credits fallback. */
function makeFetchWithGrpc(
  billing: BillingStub,
  settings: SettingsStub = () => jsonBody(SETTINGS_SUCCESS),
  grpc: BillingStub = () => new Response('', { status: 502 }),
) {
  const calls: FetchCall[] = []
  const fetcher = vi.fn(async (input: unknown, init?: unknown): Promise<Response> => {
    const url = String(input)
    calls.push({ url, init: init as RequestInit })
    return await (url === GROK_GRPC_CREDITS_URL ? grpc() : url === GROK_SETTINGS_URL ? settings() : billing())
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

interface TokenStubs {
  available?: () => boolean
  identity?: () => Promise<string | undefined>
  resolve?: (signal?: AbortSignal) => Promise<string | undefined>
  refresh?: (rejected: string, signal?: AbortSignal) => Promise<string | undefined>
}

function makeTokens(stubs: TokenStubs = {}): XaiOAuthTokenSource {
  return {
    available: () => true,
    identity: async () => 'identity-a',
    resolve: async () => 'token-1',
    refresh: async () => 'token-2',
    ...stubs,
  }
}

/** A promise that only settles when the given signal aborts. */
function hangUntil(signal: AbortSignal | undefined, outcome: 'reject' | 'resolve' = 'reject'): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      if (outcome === 'reject') reject(signal.reason)
    }, { once: true })
  })
}

function makeClient(overrides: {
  tokens?: XaiOAuthTokenSource
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
} = {}): SuperGrokQuotaClient {
  return new SuperGrokQuotaClient({
    tokens: overrides.tokens ?? makeTokens(),
    fetch: overrides.fetch,
    now: overrides.now,
    timeoutMs: overrides.timeoutMs,
  })
}

/** A real stream whose cancellation hook never settles, like a broken transport. */
function hangingResponse(status = 200) {
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"config":')) },
    cancel,
  }), { status })
  return { response, cancel }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('normalizeSuperGrokQuota', () => {
  it('maps creditUsagePercent, weekly period, plan, and prepaid cents', () => {
    expect(normalizeSuperGrokQuota(BILLING_SUCCESS, SETTINGS_SUCCESS)).toEqual({
      usedPercent: 42.5,
      remainingPercent: 57.5,
      period: 'week',
      resetAt: '2026-10-19T00:00:00.000Z',
      plan: 'SuperGrok',
      prepaidBalanceUsd: 5,
    })
  })

  it('keeps unified subscription details without fabricating an omitted percentage', () => {
    const snapshot = normalizeSuperGrokQuota({ config: {
      isUnifiedBillingUser: true,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-19T00:00:00Z' },
      prepaidBalance: {},
    } }, { subscription_tier_display: 'Ultra' })
    expect(snapshot).toEqual({ period: 'week', resetAt: '2026-10-19T00:00:00.000Z', plan: 'Ultra', prepaidBalanceUsd: 0, unifiedBilling: true })
    expect(snapshot).not.toHaveProperty('usedPercent')
    expect(snapshot).not.toHaveProperty('remainingPercent')
  })

  it.each([null, '0', NaN, -1, 101])('does not treat malformed reported usage %s as a partial success', creditUsagePercent => {
    expect(() => normalizeSuperGrokQuota({ config: {
      creditUsagePercent,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-19T00:00:00Z' },
    } }, undefined)).toThrow(QuotaResponseError)
  })

  it('retains a genuine zero percentage and the authoritative unified flag', () => {
    expect(normalizeSuperGrokQuota({ config: { creditUsagePercent: 0, isUnifiedBillingUser: true, prepaidBalance: {} } }, undefined))
      .toMatchObject({ usedPercent: 0, remainingPercent: 100, prepaidBalanceUsd: 0, unifiedBilling: true })
    expect(normalizeSuperGrokQuota({ config: { creditUsagePercent: 5, isUnifiedBillingUser: 'true' } }, undefined))
      .not.toHaveProperty('unifiedBilling')
  })

  it('requires a valid reported period for percentage-free subscription details', () => {
    for (const currentPeriod of [
      { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: 'bad' },
      { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '0' },
      { type: 'unexpected', end: '2026-10-19T00:00:00Z' },
    ]) {
      expect(() => normalizeSuperGrokQuota({ config: { currentPeriod, prepaidBalance: {} } }, SETTINGS_SUCCESS)).toThrow(QuotaResponseError)
    }
  })

  it('rejects Date.parse-lenient reset strings instead of inventing a date', () => {
    expect(() => normalizeSuperGrokQuota({ config: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '0' },
    } }, undefined)).toThrow(QuotaResponseError)
    const withPercent = normalizeSuperGrokQuota({ config: {
      creditUsagePercent: 1,
      billingPeriodEnd: '0',
    } }, undefined)
    expect('resetAt' in withPercent).toBe(false)
    // Present-but-unparseable bounds must not be labelled a monthly period.
    expect(withPercent.period).toBe('subscription')
  })

  it('accepts RFC 3339 datetimes that omit the seconds field', () => {
    const fromPeriod = normalizeSuperGrokQuota({ config: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-19T00:00Z' },
    } }, undefined)
    expect(fromPeriod.resetAt).toBe('2026-10-19T00:00:00.000Z')
    const withOffset = normalizeSuperGrokQuota({ config: {
      creditUsagePercent: 1,
      billingPeriodEnd: '2026-11-01T08:00+08:00',
    } }, undefined)
    expect(withOffset.resetAt).toBe('2026-11-01T00:00:00.000Z')
    // A fractional part without seconds is not RFC 3339.
    expect('resetAt' in normalizeSuperGrokQuota({ config: {
      creditUsagePercent: 1,
      billingPeriodEnd: '2026-10-19T00:00.5Z',
    } }, undefined)).toBe(false)
  })

  it('rejects calendar-invalid timestamps that Date.parse would roll forward', () => {
    for (const end of [
      '2026-02-30T00:00Z', // Feb 30 does not exist; V8 rolls it to March 2
      '2026-10-19T24:00Z', // hour 24 is forbidden (RFC 3339)
      '2026-10-19T00:00+25:00', // offset hour out of range
      '2027-02-29T00:00Z', // not a leap year
    ]) {
      const withPercent = normalizeSuperGrokQuota({ config: { creditUsagePercent: 1, billingPeriodEnd: end } }, undefined)
      expect('resetAt' in withPercent, end).toBe(false)
      // A percentage-free body with a bogus period end must not cache as partial.
      expect(() => normalizeSuperGrokQuota({ config: {
        currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end },
      } }, undefined), end).toThrow(QuotaResponseError)
    }
    // Real calendar dates keep working, including leap days.
    expect(normalizeSuperGrokQuota({ config: {
      creditUsagePercent: 1, billingPeriodEnd: '2028-02-29T12:00Z',
    } }, undefined).resetAt).toBe('2028-02-29T12:00:00.000Z')
    expect(normalizeSuperGrokQuota({ config: {
      creditUsagePercent: 1, billingPeriodEnd: '2026-02-28T00:00Z',
    } }, undefined).resetAt).toBe('2026-02-28T00:00:00.000Z')
  })

  it('only infers a legacy monthly period from parseable billing bounds', () => {
    expect(normalizeSuperGrokQuota({ config: {
      creditUsagePercent: 1,
      billingPeriodStart: 'garbage',
      billingPeriodEnd: '0',
    } }, undefined).period).toBe('subscription')
    // One real bound still evidences a billing period, though an unparseable
    // end means no reset date is reported.
    const oneBound = normalizeSuperGrokQuota({ config: {
      creditUsagePercent: 1,
      billingPeriodStart: '2026-10-01T00:00Z',
      billingPeriodEnd: 'garbage',
    } }, undefined)
    expect(oneBound.period).toBe('month')
    expect('resetAt' in oneBound).toBe(false)
  })

  it('falls back to legacy cents (used/limit) with a month period from billing bounds', () => {
    const snapshot = normalizeSuperGrokQuota({
      config: {
        monthlyLimit: { val: 5000 },
        used: { val: 1250 },
        billingPeriodStart: '2026-10-01T00:00:00Z',
        billingPeriodEnd: '2026-11-01T00:00:00Z',
      },
      subscription_tier: 'SuperGrok Heavy',
    }, undefined)
    expect(snapshot).toEqual({
      usedPercent: 25,
      remainingPercent: 75,
      period: 'month',
      resetAt: '2026-11-01T00:00:00.000Z',
      plan: 'SuperGrok Heavy',
    })
  })

  it('treats a missing or proto-zero {} used value as a genuine zero', () => {
    expect(normalizeSuperGrokQuota({ config: { monthlyLimit: { val: 1000 } } }, undefined))
      .toMatchObject({ usedPercent: 0, remainingPercent: 100 })
    expect(normalizeSuperGrokQuota({ config: { monthlyLimit: { val: 1000 }, used: {} } }, undefined))
      .toMatchObject({ usedPercent: 0 })
  })

  it('rejects an abnormal used value instead of masquerading as zero usage', () => {
    expect(() => normalizeSuperGrokQuota({ config: { monthlyLimit: { val: 1000 }, used: { val: 'abc' } } }, undefined))
      .toThrow(QuotaResponseError)
    expect(() => normalizeSuperGrokQuota({ config: { monthlyLimit: { val: 1000 }, used: { val: -5 } } }, undefined))
      .toThrow(QuotaResponseError)
  })

  it('rejects percentages outside 0–100 and responses without a usable percentage', () => {
    expect(() => normalizeSuperGrokQuota({ config: { creditUsagePercent: 150 } }, undefined)).toThrow(QuotaResponseError)
    expect(() => normalizeSuperGrokQuota({ config: { creditUsagePercent: -3 } }, undefined)).toThrow(QuotaResponseError)
    expect(() => normalizeSuperGrokQuota({ config: {} }, undefined)).toThrow(QuotaResponseError)
    expect(() => normalizeSuperGrokQuota({}, undefined)).toThrow(QuotaResponseError)
    // used > limit in the legacy shape is an anomaly, not a >100% quota.
    expect(() => normalizeSuperGrokQuota({ config: { monthlyLimit: { val: 100 }, used: { val: 200 } } }, undefined))
      .toThrow(QuotaResponseError)
  })

  it('maps unknown period types to subscription and omits unusable reset times', () => {
    const snapshot = normalizeSuperGrokQuota({
      config: { creditUsagePercent: 10, currentPeriod: { type: 'USAGE_PERIOD_TYPE_SOMETHING_NEW' } },
    }, undefined)
    expect(snapshot.period).toBe('subscription')
    expect('resetAt' in snapshot).toBe(false)
  })

  it('prefers the settings plan display name and falls back to the billing tier', () => {
    const body = { config: { creditUsagePercent: 1 }, subscription_tier: 'Billing Tier' }
    expect(normalizeSuperGrokQuota(body, { subscription_tier_display: 'Display Name' }).plan).toBe('Display Name')
    expect(normalizeSuperGrokQuota(body, { subscription_tier_display: '  ' }).plan).toBe('Billing Tier')
    expect(normalizeSuperGrokQuota(body, undefined).plan).toBe('Billing Tier')
  })

  it('sanitizes the plan text and caps its length', () => {
    const body = { config: { creditUsagePercent: 1 }, subscription_tier: 'Bearer eyJaaa.bbb.ccc plan' }
    const sanitized = normalizeSuperGrokQuota(body, undefined)
    expect(sanitized.plan).toBeDefined()
    expect(sanitized.plan).not.toContain('eyJaaa')
    const long = 'x'.repeat(300)
    expect(normalizeSuperGrokQuota({ config: { creditUsagePercent: 1 }, subscription_tier: long }, undefined).plan)
      .toHaveLength(100)
  })

  it('omits a negative prepaid balance instead of reporting it as credits', () => {
    const snapshot = normalizeSuperGrokQuota({ config: { creditUsagePercent: 1, prepaidBalance: { val: -1 } } }, undefined)
    expect('prepaidBalanceUsd' in snapshot).toBe(false)
  })

  it('accepts epoch seconds, milliseconds, and rejects unparseable reset values', () => {
    const base = { config: { creditUsagePercent: 1 } } as { config: Record<string, unknown> }
    expect(normalizeSuperGrokQuota({ ...base, config: { ...base.config, billingPeriodEnd: 1760000000 } }, undefined).resetAt)
      .toBe(new Date(1_760_000_000 * 1000).toISOString())
    expect(normalizeSuperGrokQuota({ ...base, config: { ...base.config, billingPeriodEnd: 1.76e15 } }, undefined).resetAt)
      .toBe(new Date(1.76e15).toISOString())
    expect('resetAt' in normalizeSuperGrokQuota({ ...base, config: { ...base.config, billingPeriodEnd: 'not-a-date' } }, undefined))
      .toBe(false)
  })
})

describe('SuperGrokQuotaClient.get', () => {
  it('caches partial unified details without creating any usage numbers', async () => {
    const { fetcher, calls } = makeFetch(() => jsonBody({ config: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-19T00:00:00Z' },
      isUnifiedBillingUser: true, prepaidBalance: {},
    } }))
    const client = makeClient({ fetch: fetcher })
    const first = await client.get()
    expect(first).toMatchObject({ state: 'partial', period: 'week', prepaidBalanceUsd: 0, unifiedBilling: true })
    expect(first).not.toHaveProperty('usedPercent')
    expect(first).not.toHaveProperty('remainingPercent')
    expect(await client.get()).toBe(first)
    expect(calls).toHaveLength(2)
    client.dispose()
  })

  it('serves one upstream read from the 60s cache and keeps the original checkedAt', async () => {
    let tick = 1_000_000
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({ fetch: fetcher, now: () => tick })
    const first = await client.get()
    tick += 1000
    const second = await client.get()
    expect(second).toBe(first)
    expect(first).toMatchObject({
      state: 'available',
      usedPercent: 42.5,
      remainingPercent: 57.5,
      period: 'week',
      plan: 'SuperGrok',
      prepaidBalanceUsd: 5,
    })
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(1)
  })

  it('refetches after the TTL expires', async () => {
    let tick = 1_000_000
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({ fetch: fetcher, now: () => tick })
    await client.get()
    tick += 60_000
    await client.get()
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(2)
  })

  it('reports signed-out without any upstream call, and drops the cache', async () => {
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    let signedIn = true
    const client = makeClient({
      fetch: fetcher,
      tokens: makeTokens({ available: () => signedIn }),
    })
    await client.get()
    signedIn = false
    expect(await client.get()).toEqual({ state: 'signed-out' })
    expect(calls).toHaveLength(2) // only the signed-in round; nothing new while signed out
    signedIn = true
    // The signed-out get dropped the slot: the next read is a fresh upstream round.
    await client.get()
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(2)
  })

  it('fails closed on an unknown identity with no upstream call and no cache', async () => {
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    let giveIdentity = false
    const client = makeClient({
      fetch: fetcher,
      tokens: makeTokens({ identity: async () => giveIdentity ? 'identity-a' : undefined }),
    })
    expect(await client.get()).toEqual({ state: 'unavailable', reason: 'auth' })
    expect(calls).toHaveLength(0)
    giveIdentity = true
    await client.get()
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(1)
  })

  it('drops a previous account’s cache entry so A→B→A cannot re-serve stale numbers', async () => {
    let tick = 1_000_000
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    let identity = 'identity-a'
    const client = makeClient({
      fetch: fetcher,
      now: () => tick,
      tokens: makeTokens({ identity: async () => identity }),
    })
    const first = await client.get()
    expect(first.state).toBe('available')
    tick += 1000
    identity = 'identity-b'
    const second = await client.get()
    expect(second.state).toBe('available')
    expect(second).not.toBe(first)
    if (second.state === 'available') expect(second.checkedAt).not.toBe(first.state === 'available' ? first.checkedAt : '')
    identity = 'identity-a'
    tick += 1000
    // Back on A: the old entry was dropped at the B read, so this is a fresh round.
    const third = await client.get()
    expect(third).not.toBe(first)
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(3)
  })

  it('re-checks the identity before serving a cache hit', async () => {
    const identities = ['identity-a', 'identity-a', 'identity-a', 'identity-b', 'identity-b']
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({
      fetch: fetcher,
      tokens: makeTokens({ identity: async () => identities.shift() ?? 'identity-b' }),
    })
    await client.get()
    // The cached entry exists, but the account changed between reads: the
    // stale entry is dropped and the hit is refused.
    expect(await client.get()).toEqual({ state: 'unavailable' })
    const next = await client.get()
    expect(next).toMatchObject({ state: 'available' })
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(2)
  })

  it('does not let a mid-flight identity change return or cache the previous account’s data', async () => {
    const identities = ['identity-a', 'identity-b', 'identity-b']
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({
      fetch: fetcher,
      tokens: makeTokens({ identity: async () => identities.shift() ?? 'identity-b' }),
    })
    expect(await client.get()).toEqual({ state: 'unavailable' })
    // Nothing was cached: the next read for identity-b performs a fresh round.
    const next = await client.get()
    expect(next).toMatchObject({ state: 'available' })
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(2)
  })

  it('refreshes at most once on 401 and retries with the rotated bearer', async () => {
    const refresh = vi.fn(async () => 'token-2')
    let round = 0
    const { fetcher, calls } = makeFetch(() => {
      round += 1
      return round === 1 ? jsonBody({ error: 'expired' }, 401) : jsonBody(BILLING_SUCCESS)
    })
    const client = makeClient({ fetch: fetcher, tokens: makeTokens({ refresh }) })
    expect(await client.get()).toMatchObject({ state: 'available' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('token-1', expect.any(AbortSignal))
    // Second billing round carried the rotated bearer.
    const retry = calls.filter(call => call.url === GROK_BILLING_URL)[1]
    expect((retry!.init.headers as Record<string, string>).authorization).toBe('Bearer token-2')
  })

  it('maps a second 401 to a fixed auth error without another refresh', async () => {
    const refresh = vi.fn(async () => 'token-2')
    const responses = [jsonBody({}, 401), jsonBody({}, 401)]
    const cancellations = responses.map(response => vi.spyOn(response.body!, 'cancel'))
    const { fetcher, calls } = makeFetch(() => responses.shift()!)
    const client = makeClient({ fetch: fetcher, tokens: makeTokens({ refresh }) })
    expect(await client.get()).toEqual({ state: 'error', reason: 'auth' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(2)
    for (const cancel of cancellations) expect(cancel).toHaveBeenCalledOnce()
  })

  it('maps a refresh that returns nothing new to a fixed auth error', async () => {
    const refresh = vi.fn(async () => 'token-1')
    const { fetcher, calls } = makeFetch(() => jsonBody({}, 401))
    const client = makeClient({ fetch: fetcher, tokens: makeTokens({ refresh }) })
    expect(await client.get()).toEqual({ state: 'error', reason: 'auth' })
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(1)
    const noRefresh = makeClient({ fetch: fetcher, tokens: makeTokens({ refresh: undefined }) })
    expect(await noRefresh.get()).toEqual({ state: 'error', reason: 'auth' })
  })

  it('maps 403 to restricted and 429 to temporary without refreshing', async () => {
    for (const [status, reason] of [[403, 'restricted'], [429, 'temporary'], [500, 'temporary']] as const) {
      const refresh = vi.fn(async () => 'token-2')
      const { fetcher } = makeFetch(() => jsonBody({}, status))
      const client = makeClient({ fetch: fetcher, tokens: makeTokens({ refresh }) })
      expect(await client.get()).toEqual({ state: 'error', reason })
      expect(refresh).not.toHaveBeenCalled()
    }
  })

  it('maps an unusable billing body to a fixed invalid state without echoing it', async () => {
    const secret = 'secret-upstream-body-eyJaaa.bbb.ccc'
    const { fetcher } = makeFetch(() => jsonBody({ message: secret }))
    const client = makeClient({ fetch: fetcher })
    const snapshot = await client.get()
    expect(snapshot).toEqual({ state: 'error', reason: 'invalid' })
    expect(JSON.stringify(snapshot)).not.toContain('secret-upstream-body')
  })

  it('maps an oversized billing body to invalid (bounded read)', async () => {
    const { fetcher } = makeFetch(() => new Response('x'.repeat(MAX_QUOTA_RESPONSE_BYTES + 1)))
    const client = makeClient({ fetch: fetcher })
    expect(await client.get()).toEqual({ state: 'error', reason: 'invalid' })
  })

  it('degrades to the billing tier when settings fails, without blocking the quota read', async () => {
    const { fetcher } = makeFetch(
      () => jsonBody(BILLING_SUCCESS),
      () => jsonBody({}, 500),
    )
    const client = makeClient({ fetch: fetcher })
    expect(await client.get()).toEqual({
      state: 'available',
      usedPercent: 42.5,
      remainingPercent: 57.5,
      period: 'week',
      checkedAt: expect.any(String),
      resetAt: '2026-10-19T00:00:00.000Z',
      prepaidBalanceUsd: 5,
    })
  })

  it('succeeds from billing while settings never settles (independent settings budget)', async () => {
    const { fetcher, calls } = makeFetch(
      () => jsonBody(BILLING_SUCCESS),
      () => new Promise<Response>(() => {}), // never settles, ignores signals
    )
    const client = makeClient({ fetch: fetcher, timeoutMs: 60 })
    const snapshot = await client.get()
    expect(snapshot).toMatchObject({ state: 'available', usedPercent: 42.5 })
    // The settings read was attempted once under its own budget, and the
    // whole-get deadline (60ms) was not consumed by the hung settings call.
    expect(calls.filter(call => call.url === GROK_SETTINGS_URL)).toHaveLength(1)
  }, 2000)

  it('sends the official billing headers with redirect:error and an abortable signal', async () => {
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({ fetch: fetcher })
    await client.get()
    const billing = calls.find(call => call.url === GROK_BILLING_URL)
    expect(billing).toBeDefined()
    expect(billing!.init.method).toBe('GET')
    expect(billing!.init.redirect).toBe('error')
    expect(billing!.init.signal).toBeInstanceOf(AbortSignal)
    const headers = billing!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-1')
    expect(headers['x-xai-token-auth']).toBe('xai-grok-cli')
    expect(headers['x-grok-client-version']).toBe('1.0.13')
  })

  it('ends a hung token resolve at the deadline and reports temporary (real blocking, not just signal passing)', async () => {
    const resolve = vi.fn((signal?: AbortSignal) => hangUntil(signal))
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({ fetch: fetcher, tokens: makeTokens({ resolve }), timeoutMs: 20 })
    expect(await client.get()).toEqual({ state: 'error', reason: 'temporary' })
    expect(calls).toHaveLength(0)
  }, DEFAULT_QUOTA_TIMEOUT_MS)

  it('ends a hung identity read at the deadline (identity has no signal parameter, so the race is the budget)', async () => {
    const { fetcher } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({
      fetch: fetcher,
      // The identity stub receives no signal at all and never settles; only
      // the client's own race against the deadline can end this get.
      tokens: makeTokens({ identity: () => new Promise(() => {}) }),
      timeoutMs: 20,
    })
    expect(await client.get()).toEqual({ state: 'error', reason: 'temporary' })
  })

  it('ends a hung refresh at the deadline and reports temporary', async () => {
    const refresh = vi.fn((_rejected: string, signal?: AbortSignal) => hangUntil(signal))
    const { fetcher } = makeFetch(() => jsonBody({}, 401))
    const client = makeClient({ fetch: fetcher, tokens: makeTokens({ refresh }), timeoutMs: 20 })
    expect(await client.get()).toEqual({ state: 'error', reason: 'temporary' })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('ends a hung response body at the deadline and reports temporary', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"config":'))
        // Never closes.
      },
    })
    const { fetcher } = makeFetch(() => new Response(stream))
    const client = makeClient({ fetch: fetcher, timeoutMs: 20 })
    expect(await client.get()).toEqual({ state: 'error', reason: 'temporary' })
  })

  it('rethrows caller cancellation and resolves it via the combined signal (hung resolve included)', async () => {
    const controller = new AbortController()
    const resolve = vi.fn((signal?: AbortSignal) => hangUntil(signal))
    const { fetcher } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({ fetch: fetcher, tokens: makeTokens({ resolve }) })
    const pending = client.get(controller.signal)
    controller.abort(new Error('client disconnected'))
    await expect(pending).rejects.toThrow('client disconnected')
  })

  it('observes a late identity rejection after dispose instead of leaving it unhandled', async () => {
    let rejectIdentity!: (error: Error) => void
    const identity = () => new Promise<string>((_, reject) => { rejectIdentity = reject })
    const client = makeClient({ tokens: makeTokens({ identity }) })
    client.dispose()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      expect(await client.get()).toEqual({ state: 'error', reason: 'temporary' })
      rejectIdentity(new Error('identity failed after dispose'))
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('immediately ends in-flight gets on dispose (hung resolve, real termination)', async () => {
    const resolve = vi.fn((_signal?: AbortSignal) => new Promise<string>(() => {})) // never settles, ignores signals
    const { fetcher } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({ fetch: fetcher, tokens: makeTokens({ resolve }) })
    const pending = client.get()
    client.dispose()
    // The hung resolve cannot be cancelled by any signal, but dispose must
    // still finish the get right away with a fixed state.
    expect(await pending).toEqual({ state: 'error', reason: 'temporary' })
    expect(await client.get()).toEqual({ state: 'error', reason: 'temporary' })
  })

  it('lets reset() win over an in-flight get: the stale result is returned but never cached', async () => {
    let tick = 1_000_000
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS))
    const client = makeClient({ fetch: fetcher, now: () => tick })
    const pending = client.get()
    client.reset()
    const snapshot = await pending
    expect(snapshot).toMatchObject({ state: 'available' })
    tick += 1000
    const next = await client.get()
    expect(next).not.toBe(snapshot)
    expect(calls.filter(call => call.url === GROK_BILLING_URL)).toHaveLength(2)
  })

  it('reads the global fetch lazily when no fetch seam is injected', async () => {
    const original = globalThis.fetch
    const calls: FetchCall[] = []
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      calls.push({ url: String(input), init: init as RequestInit })
      return jsonBody(BILLING_SUCCESS)
    }) as typeof fetch
    try {
      const client = makeClient()
      expect(await client.get()).toMatchObject({ state: 'available' })
      expect(calls).toHaveLength(2)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('SuperGrokQuotaClient gRPC-web credits fallback (GROK-QUOTA-CREDITS-001)', () => {
  it('recovers the weekly pool from GetGrokCreditsConfig when the REST credits shape answers 500', async () => {
    const { fetcher, calls } = makeFetchWithGrpc(
      () => new Response('Failed to serialize billing response', { status: 500 }),
      () => jsonBody(SETTINGS_SUCCESS),
      () => grpcCreditsBody({ percent: 40, start: '2026-10-14T03:32:51Z', end: '2026-10-21T03:32:51Z' }),
    )
    const client = makeClient({ fetch: fetcher })
    expect(await client.get()).toEqual({
      state: 'available',
      usedPercent: 40,
      remainingPercent: 60,
      period: 'week',
      checkedAt: expect.any(String),
      resetAt: '2026-10-21T03:32:51.000Z',
      plan: 'SuperGrok',
    })
    const grpcCall = calls.find(call => call.url === GROK_GRPC_CREDITS_URL)
    expect(grpcCall).toBeDefined()
    expect(grpcCall!.init.method).toBe('POST')
    expect(grpcCall!.init.redirect).toBe('error')
    const headers = grpcCall!.init.headers as Record<string, string>
    expect(headers.accept).toBe('application/grpc-web+proto')
    expect(headers['content-type']).toBe('application/grpc-web+proto')
    expect(headers['x-grpc-web']).toBe('1')
    expect(headers.origin).toBe('https://grok.com')
    expect(headers.referer).toBe('https://grok.com/?_s=usage')
    expect(headers.authorization).toBe('Bearer token-1')
    expect(headers['x-xai-token-auth']).toBe('xai-grok-cli')
    expect(grpcCall!.init.body).toEqual(GROK_GRPC_EMPTY_FRAME)
    client.dispose()
  })

  it('falls back with the rotated bearer after a 401 refresh when the retry still fails', async () => {
    const refresh = vi.fn(async () => 'token-2')
    let round = 0
    const { fetcher, calls } = makeFetchWithGrpc(() => {
      round += 1
      return round === 1
        ? jsonBody({}, 401)
        : new Response('Failed to serialize billing response', { status: 500 })
    }, undefined, () => grpcCreditsBody({ percent: 30, start: '2026-10-07T11:18:57Z', end: '2026-10-14T11:18:57Z' }))
    const client = makeClient({ fetch: fetcher, tokens: makeTokens({ refresh }) })
    expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 30, remainingPercent: 70 })
    expect(refresh).toHaveBeenCalledTimes(1)
    const grpcCall = calls.find(call => call.url === GROK_GRPC_CREDITS_URL)
    expect((grpcCall!.init.headers as Record<string, string>).authorization).toBe('Bearer token-2')
    client.dispose()
  })

  it('reports temporary when both the REST shape and the gRPC fallback fail', async () => {
    const { fetcher, calls } = makeFetchWithGrpc(
      () => new Response('Failed to serialize billing response', { status: 500 }),
      undefined,
      () => new Response('', { status: 502 }),
    )
    const client = makeClient({ fetch: fetcher })
    expect(await client.get()).toEqual({ state: 'error', reason: 'temporary' })
    expect(calls.map(call => call.url)).toEqual([GROK_BILLING_URL, GROK_SETTINGS_URL, GROK_GRPC_CREDITS_URL])
    client.dispose()
  })

  it('falls back when the REST probe never answers and keeps the original error when the fallback is dead too', async () => {
    const networkError = () => Promise.reject(new TypeError('fetch failed'))
    const recovered = makeFetchWithGrpc(
      networkError,
      networkError,
      () => grpcCreditsBody({ percent: 12.5, start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }),
    )
    expect(await makeClient({ fetch: recovered.fetcher }).get()).toEqual({
      state: 'available',
      usedPercent: 12.5,
      remainingPercent: 87.5,
      period: 'month',
      checkedAt: expect.any(String),
      resetAt: '2026-11-01T00:00:00.000Z',
    })
    const dead = makeFetchWithGrpc(networkError, networkError, networkError)
    expect(await makeClient({ fetch: dead.fetcher }).get()).toEqual({ state: 'error', reason: 'temporary' })
  })

  it('never masks auth failures as usage data: 403 and 401 skip the fallback', async () => {
    const restricted = makeFetchWithGrpc(() => jsonBody({}, 403))
    const restrictedClient = makeClient({ fetch: restricted.fetcher })
    expect(await restrictedClient.get()).toEqual({ state: 'error', reason: 'restricted' })
    expect(restricted.calls.map(call => call.url)).not.toContain(GROK_GRPC_CREDITS_URL)
    restrictedClient.dispose()
    const auth = makeFetchWithGrpc(() => jsonBody({}, 401))
    const authClient = makeClient({ fetch: auth.fetcher, tokens: makeTokens({ refresh: async () => 'token-1' }) })
    expect(await authClient.get()).toEqual({ state: 'error', reason: 'auth' })
    expect(auth.calls.map(call => call.url)).not.toContain(GROK_GRPC_CREDITS_URL)
    authClient.dispose()
  })

  it('surfaces a percentage-free gRPC window as partial details, never as 0%', async () => {
    const { fetcher } = makeFetchWithGrpc(
      () => new Response('Failed to serialize billing response', { status: 500 }),
      undefined,
      () => grpcCreditsBody({ start: '2026-10-07T11:18:57Z', end: '2026-10-14T11:18:57Z' }),
    )
    const client = makeClient({ fetch: fetcher })
    const snapshot = await client.get()
    expect(snapshot).toMatchObject({ state: 'partial', period: 'week', resetAt: '2026-10-14T11:18:57.000Z' })
    expect(snapshot).not.toHaveProperty('usedPercent')
    client.dispose()
  })
})

describe('quota response cleanup', () => {
  it.each(['deadline', 'caller', 'dispose'] as const)('cancels and unlocks a hanging billing reader on %s without awaiting cancel', async stop => {
    const { response, cancel } = hangingResponse()
    const { fetcher, calls } = makeFetch(() => response)
    const controller = new AbortController()
    const client = makeClient({ fetch: fetcher, timeoutMs: stop === 'deadline' ? 40 : 1000 })
    const reason = new Error('caller cancelled')
    const result = client.get(controller.signal).catch(error => error as Error)
    await vi.waitFor(() => expect(response.body!.locked).toBe(true), { interval: 1 })
    if (stop === 'caller') controller.abort(reason)
    if (stop === 'dispose') client.dispose()
    expect(await result).toEqual(stop === 'caller' ? reason : { state: 'error', reason: 'temporary' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body!.locked).toBe(false)
    expect(calls.map(call => call.url).sort()).toEqual([GROK_BILLING_URL, GROK_SETTINGS_URL].sort())
    client.dispose()
  }, 2000)

  it.each(['caller', 'dispose'] as const)('cancels billing received while waiting for settings on %s', async stop => {
    const { response, cancel } = hangingResponse()
    const settings = deferred<Response>()
    const { fetcher, calls } = makeFetch(() => response, () => settings.promise)
    const controller = new AbortController()
    const client = makeClient({ fetch: fetcher, timeoutMs: 1000 })
    const reason = new Error('caller cancelled')
    const result = client.get(controller.signal).catch(error => error as Error)
    await vi.waitFor(() => expect(calls).toHaveLength(2), { interval: 1 })
    // Billing is still waiting in Promise.all; no reader owns it yet.
    expect(response.body!.locked).toBe(false)
    if (stop === 'caller') controller.abort(reason)
    else client.dispose()
    expect(await result).toEqual(stop === 'caller' ? reason : { state: 'error', reason: 'temporary' })
    expect(cancel).toHaveBeenCalledOnce()
    const late = hangingResponse()
    settings.resolve(late.response)
    await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledOnce(), { interval: 1 })
    expect(calls).toHaveLength(2)
    client.dispose()
  }, 2000)

  it.each(['deadline', 'caller', 'dispose'] as const)('discards a billing response that arrives after %s', async stop => {
    const billing = deferred<Response>()
    const { fetcher, calls } = makeFetch(() => billing.promise)
    const controller = new AbortController()
    const client = makeClient({ fetch: fetcher, timeoutMs: stop === 'deadline' ? 40 : 1000 })
    const reason = new Error('caller cancelled')
    const result = client.get(controller.signal).catch(error => error as Error)
    await vi.waitFor(() => expect(calls).toHaveLength(2), { interval: 1 })
    if (stop === 'caller') controller.abort(reason)
    if (stop === 'dispose') client.dispose()
    expect(await result).toEqual(stop === 'caller' ? reason : { state: 'error', reason: 'temporary' })
    const late = hangingResponse()
    const reader = vi.spyOn(late.response.body!, 'getReader')
    billing.resolve(late.response)
    await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledOnce(), { interval: 1 })
    expect(reader).not.toHaveBeenCalled()
    expect(calls).toHaveLength(2)
    client.dispose()
  }, 2000)

  it.each(['caller', 'dispose'] as const)('cancels both billing and an active settings reader on %s', async stop => {
    const billing = hangingResponse()
    const settings = hangingResponse()
    const { fetcher, calls } = makeFetch(() => billing.response, () => settings.response)
    const controller = new AbortController()
    const client = makeClient({ fetch: fetcher, timeoutMs: 1000 })
    const reason = new Error('caller cancelled')
    const result = client.get(controller.signal).catch(error => error as Error)
    await vi.waitFor(() => expect(settings.response.body!.locked).toBe(true), { interval: 1 })
    if (stop === 'caller') controller.abort(reason)
    else client.dispose()
    expect(await result).toEqual(stop === 'caller' ? reason : { state: 'error', reason: 'temporary' })
    expect(billing.cancel).toHaveBeenCalledOnce()
    expect(settings.cancel).toHaveBeenCalledOnce()
    expect(settings.response.body!.locked).toBe(false)
    expect(calls).toHaveLength(2)
    client.dispose()
  }, 2000)

  it('cancels a hanging settings reader at its own budget while retaining billing', async () => {
    const { response, cancel } = hangingResponse()
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS), () => response)
    const client = makeClient({ fetch: fetcher, timeoutMs: 80 })
    expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 42.5 })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body!.locked).toBe(false)
    expect(calls).toHaveLength(2)
    client.dispose()
  }, 2000)

  it('discards settings arriving after its optional budget and keeps the cached billing result', async () => {
    const settings = deferred<Response>()
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS), () => settings.promise)
    const client = makeClient({ fetch: fetcher, timeoutMs: 80 })
    const snapshot = await client.get()
    expect(snapshot).toMatchObject({ state: 'available', usedPercent: 42.5 })
    const late = hangingResponse()
    const reader = vi.spyOn(late.response.body!, 'getReader')
    settings.resolve(late.response)
    await vi.waitFor(() => expect(late.cancel).toHaveBeenCalledOnce(), { interval: 1 })
    expect(reader).not.toHaveBeenCalled()
    expect(await client.get()).toBe(snapshot)
    expect(calls).toHaveLength(2)
    client.dispose()
  }, 2000)

  it('cancels a rejected settings status without waiting for its transport cleanup', async () => {
    const { response, cancel } = hangingResponse(500)
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS), () => response)
    const client = makeClient({ fetch: fetcher })
    expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 42.5 })
    expect(cancel).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(2)
    client.dispose()
  }, 2000)

  it('cancels an oversized settings reader and degrades to billing without another request', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_QUOTA_RESPONSE_BYTES + 1)) },
      cancel,
    }))
    const { fetcher, calls } = makeFetch(() => jsonBody(BILLING_SUCCESS), () => response)
    const client = makeClient({ fetch: fetcher })
    expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 42.5 })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body!.locked).toBe(false)
    expect(calls).toHaveLength(2)
    client.dispose()
  }, 2000)

  it('stops an active settings reader when the billing fetch fails', async () => {
    const billing = deferred<Response>()
    const { response, cancel } = hangingResponse()
    const { fetcher, calls } = makeFetch(() => billing.promise, () => response)
    const client = makeClient({ fetch: fetcher })
    const pending = client.get()
    await vi.waitFor(() => expect(response.body!.locked).toBe(true), { interval: 1 })
    billing.reject(new Error('synthetic billing failure'))
    expect(await pending).toEqual({ state: 'error', reason: 'temporary' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body!.locked).toBe(false)
    // The transport failure now also probes the gRPC-web fallback (the stub
    // answers it with the same rejected promise) before the original error
    // maps to temporary (GROK-QUOTA-CREDITS-001).
    expect(calls.map(call => call.url)).toEqual([GROK_BILLING_URL, GROK_SETTINGS_URL, GROK_GRPC_CREDITS_URL])
    client.dispose()
  }, 2000)
})

describe('quota snapshot shape', () => {
  it('error states never carry message or diagnostic fields', async () => {
    const { fetcher } = makeFetch(() => jsonBody({}, 403))
    const client = makeClient({ fetch: fetcher })
    const snapshot: QuotaSnapshot = await client.get()
    expect(Object.keys(snapshot).sort()).toEqual(['reason', 'state'])
  })
})
