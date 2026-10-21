// Part of dsh-grok-kit, Apache-2.0.

import { describe, expect, it, vi } from 'vitest'
import { GROK_BILLING_URL, GROK_SETTINGS_URL, SuperGrokQuotaClient } from '../src/quota.ts'
import { encodeCreditsGrpcWeb } from './grok-credits-frame.ts'

const NOW = Date.parse('2026-10-21T04:00:00Z')
const WINDOW = { start: '2026-10-20T00:00:00Z', end: '2026-10-27T00:00:00Z' }
const OLD_WINDOW = { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' }

function partial(window = WINDOW) {
  return { config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', ...window },
    prepaidBalance: { val: 500 }, isUnifiedBillingUser: true,
  } }
}

function fixture(options: {
  body?: unknown
  billing?: () => Promise<Response>
  grpc: (signal: AbortSignal) => Response | Promise<Response>
  timeoutMs?: number
  identity?: () => Promise<string>
  now?: () => number
}) {
  let wholeSignal: AbortSignal | null | undefined
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === GROK_SETTINGS_URL) return new Response(JSON.stringify({ subscription_tier_display: 'SuperGrok' }))
    if (String(input) === GROK_BILLING_URL) {
      wholeSignal = init?.signal
      return options.billing?.() ?? new Response(JSON.stringify(options.body ?? partial()))
    }
    if (!init?.signal) throw new Error('verification must be abortable')
    return options.grpc(init.signal)
  })
  const client = new SuperGrokQuotaClient({
    tokens: { available: () => true, resolve: async () => 'synthetic-bearer', identity: options.identity ?? (async () => 'account') },
    now: options.now ?? (() => NOW), timeoutMs: options.timeoutMs ?? 1000, fetch: fetcher,
  })
  return { client, fetcher, wholeSignal: () => wholeSignal }
}

const hang = (signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

describe('PR #13 review: optional verification budget', () => {
  it('preserves and caches REST partial details when only the verification fetch times out', async () => {
    let probeSignal: AbortSignal | undefined
    const { client, fetcher, wholeSignal } = fixture({ timeoutMs: 200, grpc: signal => { probeSignal = signal; return hang(signal) } })
    try {
      const snapshot = await client.get()
      expect(snapshot).toMatchObject({ state: 'partial', period: 'week', prepaidBalanceUsd: 5, unifiedBilling: true, plan: 'SuperGrok' })
      expect(snapshot).not.toHaveProperty('usedPercent')
      expect(probeSignal?.aborted).toBe(true)
      expect(wholeSignal()?.aborted).toBe(false)
      expect(await client.get()).toBe(snapshot)
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally { client.dispose() }
  })

  it('shrinks the optional budget when REST already consumed most of the whole-get deadline', async () => {
    const { client, wholeSignal } = fixture({
      timeoutMs: 1000,
      billing: async () => { await new Promise(resolve => setTimeout(resolve, 600)); return new Response(JSON.stringify(partial())) },
      grpc: hang,
    })
    try {
      expect(await client.get()).toMatchObject({ state: 'partial', period: 'week' })
      expect(wholeSignal()?.aborted).toBe(false)
    } finally { client.dispose() }
  })

  it('cancels and unlocks a stalled verification body while retaining REST metadata', async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0])) }, cancel }))
    const { client } = fixture({ timeoutMs: 200, grpc: () => response })
    try {
      expect(await client.get()).toMatchObject({ state: 'partial', prepaidBalanceUsd: 5 })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(response.body?.locked).toBe(false)
    } finally { client.dispose() }
  })

  it('discards a late verification response after its isolated budget expires', async () => {
    let resolveLate!: (response: Response) => void
    const cancel = vi.fn()
    const { client } = fixture({ timeoutMs: 200, grpc: () => new Promise(resolve => { resolveLate = resolve }) })
    try {
      expect(await client.get()).toMatchObject({ state: 'partial' })
      resolveLate(new Response(new ReadableStream<Uint8Array>({ cancel })))
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    } finally { client.dispose() }
  })

  it('still enforces the whole-get deadline on an identity check after optional verification fails', async () => {
    let identityReads = 0
    const { client } = fixture({
      timeoutMs: 200, grpc: hang,
      identity: () => ++identityReads === 1 ? Promise.resolve('account') : new Promise(() => undefined),
    })
    try { expect(await client.get()).toEqual({ state: 'error', reason: 'temporary' }) }
    finally { client.dispose() }
  })
})

describe('PR #13 review: final delivery and cache freshness', () => {
  it.each([200, 500, 'transport'] as const)('does not deliver an implicit zero if final identity checking crosses the period end: %s', async status => {
    const end = Date.parse(WINDOW.end)
    let now = end - 1
    let reads = 0
    const { client, fetcher } = fixture({
      now: () => now,
      identity: async () => { if (++reads === 2) now = end + 1; return 'account' },
      billing: status === 200 ? undefined : async () => {
        if (status === 'transport') throw new TypeError('synthetic transport failure')
        return new Response('', { status })
      },
      grpc: () => new Response(encodeCreditsGrpcWeb(WINDOW)),
    })
    try {
      const snapshot = await client.get()
      expect(snapshot).toMatchObject({ state: 'partial', period: 'week', resetAt: new Date(end).toISOString(), checkedAt: new Date(now).toISOString() })
      expect(snapshot).not.toHaveProperty('usedPercent')
      expect(snapshot).not.toHaveProperty('remainingPercent')
      expect(snapshot).not.toHaveProperty('implicitUsagePercent')
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally { client.dispose() }
  })

  it('also rechecks an explicitly verified REST-200 percentage after final identity checking', async () => {
    const end = Date.parse(WINDOW.end)
    let now = end - 1
    let reads = 0
    const { client } = fixture({
      now: () => now, identity: async () => { if (++reads === 2) now = end + 1; return 'account' },
      grpc: () => new Response(encodeCreditsGrpcWeb({ ...WINDOW, percent: 37.5 })),
    })
    try {
      const snapshot = await client.get()
      expect(snapshot).toMatchObject({ state: 'partial', period: 'week' })
      expect(snapshot).not.toHaveProperty('usedPercent')
      expect(snapshot).not.toHaveProperty('remainingPercent')
    } finally { client.dispose() }
  })

  it.each(['before-cache-read', 'during-cache-identity-check', 'clock-before-period'] as const)(
    'does not serve a cached verified zero outside its period: %s', async change => {
      const end = Date.parse(WINDOW.end)
      let now = end - 1
      let reads = 0
      const { client, fetcher } = fixture({
        now: () => now,
        identity: async () => { if (++reads === 4 && change === 'during-cache-identity-check') now = end + 1; return 'account' },
        grpc: () => new Response(encodeCreditsGrpcWeb(WINDOW)),
      })
      try {
        const first = await client.get()
        expect(first).toMatchObject({ state: 'available', usedPercent: 0, remainingPercent: 100 })
        expect(first).not.toHaveProperty('implicitUsagePercent')
        if (change === 'before-cache-read') now = end + 1
        if (change === 'clock-before-period') now = Date.parse(WINDOW.start) - 1
        const snapshot = await client.get()
        expect(snapshot).not.toBe(first)
        expect(snapshot).toMatchObject({ state: 'partial', period: 'week' })
        expect(snapshot).not.toHaveProperty('usedPercent')
        expect(snapshot).not.toHaveProperty('remainingPercent')
        expect(fetcher).toHaveBeenCalledTimes(6)
      } finally { client.dispose() }
    },
  )
})

describe('PR #13 review: period provenance and freshness', () => {
  it.each([
    {}, { start: WINDOW.start }, { end: WINDOW.end },
  ])('keeps the complete REST period for a compatible partial gRPC period: %j', window => {
    const { client } = fixture({ grpc: () => new Response(encodeCreditsGrpcWeb({ percent: 37.5, ...window })) })
    return client.get().then(snapshot => {
      expect(snapshot).toMatchObject({ state: 'available', usedPercent: 37.5, remainingPercent: 62.5, period: 'week', resetAt: '2026-10-27T00:00:00.000Z' })
    }).finally(() => client.dispose())
  })

  it('retains the REST type when identical active gRPC bounds have no inferred type', async () => {
    const window = { start: '2026-10-10T00:00:00Z', end: '2026-10-25T00:00:00Z' }
    const { client } = fixture({ body: partial(window), grpc: () => new Response(encodeCreditsGrpcWeb({ percent: 37.5, ...window })) })
    try { expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 37.5, period: 'week', resetAt: '2026-10-25T00:00:00.000Z' }) }
    finally { client.dispose() }
  })

  it.each([
    { rest: WINDOW, grpc: OLD_WINDOW },
    { rest: WINDOW, grpc: { start: '2026-10-22T00:00:00Z', end: '2026-10-29T00:00:00Z' } },
    { rest: OLD_WINDOW, grpc: {} },
    { rest: WINDOW, grpc: { start: '2026-10-19T00:00:00Z' } },
    { rest: WINDOW, grpc: { end: '2026-10-28T00:00:00Z' } },
  ])('does not promote an expired, future or incompatible period to available: %j', async ({ rest, grpc }) => {
    const { client } = fixture({ body: partial(rest), grpc: () => new Response(encodeCreditsGrpcWeb({ percent: 37.5, ...grpc })) })
    try {
      const snapshot = await client.get()
      expect(snapshot).toMatchObject({ state: 'partial', period: 'week', resetAt: new Date(rest.end).toISOString() })
      expect(snapshot).not.toHaveProperty('usedPercent')
    } finally { client.dispose() }
  })

  it('allows a complete active typed gRPC period to replace stale REST metadata', async () => {
    const { client } = fixture({ body: partial(OLD_WINDOW), grpc: () => new Response(encodeCreditsGrpcWeb({ percent: 37.5, ...WINDOW })) })
    try { expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 37.5, period: 'week', resetAt: '2026-10-27T00:00:00.000Z' }) }
    finally { client.dispose() }
  })
})
