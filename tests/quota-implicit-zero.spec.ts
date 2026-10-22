// Part of dsh-grok-kit, Apache-2.0.

import { describe, expect, it, vi } from 'vitest'
import { GROK_GRPC_CREDITS_URL, parseGrokCreditsGrpcWeb } from '../src/grok-credits.ts'
import { GROK_BILLING_URL, GROK_SETTINGS_URL, SuperGrokQuotaClient } from '../src/quota.ts'
import { encodeCreditsGrpcWeb, encodeGrpcStatusTrailer } from './grok-credits-frame.ts'

const NOW = Date.parse('2026-10-21T04:00:00Z')
const WINDOW = { start: '2026-10-20T00:00:00Z', end: '2026-10-27T00:00:00Z' }
const PARTIAL = {
  subscription_tier: 'SuperGrok',
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', ...WINDOW },
    prepaidBalance: { val: 500 },
    isUnifiedBillingUser: true,
  },
}

function frame(message: Uint8Array): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32BE(message.length, 1)
  return Buffer.concat([header, message, encodeGrpcStatusTrailer(0)])
}

function mutateMessage(bytes: Buffer, mutate: (message: Buffer) => Buffer): Buffer {
  return frame(mutate(bytes.subarray(5, 5 + bytes.readUInt32BE(1))))
}

function mutateConfig(bytes: Buffer, mutate: (config: Buffer) => Buffer): Buffer {
  // This fixture has a one-byte config tag and length (less than 128 bytes).
  return mutateMessage(bytes, message => {
    const config = mutate(message.subarray(2))
    return Buffer.concat([Buffer.from([0x0a, config.length]), config])
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function fixture(options: {
  body?: unknown
  status?: number
  bytes?: Buffer
  grpc?: (signal?: AbortSignal | null) => Response | Promise<Response>
  timeoutMs?: number
  tokens?: { refresh?: () => Promise<string>; identity?: () => Promise<string> }
} = {}) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === GROK_SETTINGS_URL) return json({ subscription_tier_display: 'SuperGrok' })
    if (String(input) === GROK_BILLING_URL) return json(options.body ?? PARTIAL, options.status)
    if (options.grpc !== undefined) return options.grpc(init?.signal)
    return new Response(options.bytes ?? encodeCreditsGrpcWeb(WINDOW))
  })
  const client = new SuperGrokQuotaClient({
    tokens: {
      available: () => true,
      resolve: async () => 'synthetic-bearer',
      identity: async () => 'synthetic-account',
      ...options.tokens,
    },
    now: () => NOW,
    timeoutMs: options.timeoutMs,
    fetch: fetcher,
  })
  return { client, fetcher }
}

const parse = (bytes: Buffer) => parseGrokCreditsGrpcWeb(bytes, { now: NOW })

describe('verified proto3 implicit zero', () => {
  it.each([
    WINDOW,
    { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
  ])('decodes an omitted scalar in a complete active period as zero: %j', window => {
    expect(parse(encodeCreditsGrpcWeb(window))?.config.creditUsagePercent).toBe(0)
    // Unknown multi-byte fields must not prevent a valid zero reading.
    expect(parse(encodeCreditsGrpcWeb({ ...window, leadingHighField: true }))?.config.creditUsagePercent).toBe(0)
  })

  it.each([
    {},
    { start: WINDOW.start },
    { end: WINDOW.end },
    { start: WINDOW.end, end: WINDOW.start },
    { start: WINDOW.start, end: WINDOW.start },
    { start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' },
    { start: '2026-10-22T00:00:00Z', end: '2026-10-29T00:00:00Z' },
    { start: '2026-10-20T00:00:00Z', end: '2026-10-22T00:00:00Z' },
  ])('does not turn an absent or unverified window into zero: %j', window => {
    expect(parse(encodeCreditsGrpcWeb(window))?.config.creditUsagePercent).toBeUndefined()
  })

  it('uses a half-open active period, including start but excluding end', () => {
    const bytes = encodeCreditsGrpcWeb(WINDOW)
    expect(parseGrokCreditsGrpcWeb(bytes, { now: Date.parse(WINDOW.start) })?.config.creditUsagePercent).toBe(0)
    expect(parseGrokCreditsGrpcWeb(bytes, { now: Date.parse(WINDOW.end) })?.config.creditUsagePercent).toBeUndefined()
  })

  it('does not round a start one nanosecond in the future down to now', () => {
    const bytes = mutateConfig(encodeCreditsGrpcWeb(WINDOW), config => {
      const startEnd = 2 + config[1]
      return Buffer.concat([
        Buffer.from([config[0], config[1] + 2]), config.subarray(2, startEnd),
        Buffer.from([0x10, 1]), config.subarray(startEnd),
      ])
    })
    const start = Date.parse(WINDOW.start)
    expect(parseGrokCreditsGrpcWeb(bytes, { now: start })?.config.creditUsagePercent).toBeUndefined()
    const parsed = parseGrokCreditsGrpcWeb(bytes, { now: start + 1 })
    expect(parsed?.config.creditUsagePercent).toBe(0)
    expect(parsed?.config.currentPeriod?.start).toBe(new Date(start + 1).toISOString())
  })

  it('rounds a fractional end conservatively instead of extending the current period', () => {
    const bytes = mutateConfig(encodeCreditsGrpcWeb(WINDOW), config => {
      const endOffset = 2 + config[1]
      return Buffer.concat([
        config.subarray(0, endOffset), Buffer.from([config[endOffset], config[endOffset + 1] + 2]),
        config.subarray(endOffset + 2), Buffer.from([0x10, 1]),
      ])
    })
    expect(parseGrokCreditsGrpcWeb(bytes, { now: Date.parse(WINDOW.end) })?.config.creditUsagePercent).toBeUndefined()
  })

  it('requires a config envelope, a success status and an unambiguous data frame', () => {
    const bytes = encodeCreditsGrpcWeb(WINDOW)
    expect(parse(mutateMessage(bytes, message => message.subarray(2)))?.config.creditUsagePercent).toBeUndefined()
    expect(parse(encodeCreditsGrpcWeb({ ...WINDOW, trailerStatus: 13 }))).toBeUndefined()
    const withoutTrailer = encodeCreditsGrpcWeb({ ...WINDOW, trailerStatus: 'omit' })
    expect(parse(withoutTrailer)).toBeUndefined()
    expect(parseGrokCreditsGrpcWeb(withoutTrailer, { now: NOW, headerStatus: '0' })?.config.creditUsagePercent).toBe(0)
    expect(parse(Buffer.concat([withoutTrailer, bytes]))?.config.creditUsagePercent).toBeUndefined()
    expect(parse(Buffer.concat([Buffer.from([1, 0, 0, 0, 1, 0]), bytes]))?.config.creditUsagePercent).toBeUndefined()
  })

  it.each([
    Buffer.from([0]), // invalid field number zero
    Buffer.from([0x12, 10, 0]), // truncated unknown length-delimited field
    Buffer.from([0x08, 1]), // percent with the wrong wire type
    Buffer.from([0x0d, 0, 0]), // truncated float
    Buffer.from([0x22, 0]), // duplicate start
    Buffer.from([0x80]), // unfinished tag
    Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 1]), // overflowing tag
  ])('rejects a malformed suffix after otherwise valid period fields: %j', suffix => {
    const bytes = encodeCreditsGrpcWeb(WINDOW)
    expect(parse(mutateConfig(bytes, config => Buffer.concat([config, suffix])))).toBeUndefined()
    const outerSuffix = suffix[0] === 0x22 ? Buffer.from([0x0a, 0]) : suffix
    expect(parse(mutateMessage(bytes, message => Buffer.concat([message, outerSuffix])))).toBeUndefined()
  })

  it('does not infer zero from a truncated nested timestamp', () => {
    const bytes = encodeCreditsGrpcWeb(WINDOW)
    // Extend Timestamp.start by an unfinished tag while keeping config/frame lengths complete.
    const malformed = mutateConfig(bytes, config => {
      const startEnd = 2 + config[1]
      return Buffer.concat([
        Buffer.from([config[0], config[1] + 1]), config.subarray(2, startEnd),
        Buffer.from([0x80]), config.subarray(startEnd),
      ])
    })
    expect(parse(malformed)?.config.creditUsagePercent).toBeUndefined()
  })

  it('skips a full-width unknown varint without hiding invalid timestamp fields after it', () => {
    const bytes = encodeCreditsGrpcWeb(WINDOW)
    const unknown = Buffer.from([0x80, 0x01, ...Array<number>(9).fill(0xff), 0x01])
    const withTimestampSuffix = (suffix: Buffer) => mutateConfig(bytes, config => {
      const startEnd = 2 + config[1]
      return Buffer.concat([
        Buffer.from([config[0], config[1] + suffix.length]),
        config.subarray(2, startEnd), suffix, config.subarray(startEnd),
      ])
    })
    expect(parse(withTimestampSuffix(unknown))?.config.creditUsagePercent).toBe(0)
    // nanos=1,000,000,000 is out of range, even after an unknown uint64 field.
    const invalidNanos = Buffer.from([0x10, 0x80, 0x94, 0xeb, 0xdc, 0x03])
    expect(parse(withTimestampSuffix(Buffer.concat([unknown, invalidNanos])))?.config.creditUsagePercent).toBeUndefined()
    // A known field outside the safe integer range must not be mistaken for
    // the end of an otherwise valid timestamp (uint64 max is not valid nanos).
    const unsafeNanos = Buffer.from([0x10, ...Array<number>(9).fill(0xff), 0x01])
    expect(parse(withTimestampSuffix(unsafeNanos))?.config.creditUsagePercent).toBeUndefined()
  })

  it.each([0, 12.5, 100, 150])('does not replace an explicit percentage: %s', percent => {
    expect(parse(encodeCreditsGrpcWeb({ ...WINDOW, percent }))?.config.creditUsagePercent).toBe(percent)
  })
})

describe('REST 200 partial quota verification', () => {
  it('verifies missing REST usage, retains metadata, and caches the available 0/100 snapshot', async () => {
    const { client, fetcher } = fixture()
    try {
      const snapshot = await client.get()
      expect(snapshot).toMatchObject({
        state: 'available', usedPercent: 0, remainingPercent: 100, period: 'week',
        resetAt: '2026-10-27T00:00:00.000Z', plan: 'SuperGrok',
        prepaidBalanceUsd: 5, unifiedBilling: true,
      })
      expect(await client.get()).toBe(snapshot)
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        GROK_BILLING_URL, GROK_SETTINGS_URL, GROK_GRPC_CREDITS_URL,
      ])
    } finally { client.dispose() }
  })

  it.each([{}, { config: {} }, { config: { currentPeriod: { end: 'invalid' } } }])(
    'verifies missing REST usage even without readable period metadata: %j', async body => {
      const { client, fetcher } = fixture({ body })
      try {
        expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 0, remainingPercent: 100 })
        expect(fetcher.mock.calls).toHaveLength(3)
      } finally { client.dispose() }
    },
  )

  it('accepts an explicit nonzero gRPC percentage instead of assuming missing REST means zero', async () => {
    const { client } = fixture({ bytes: encodeCreditsGrpcWeb({ ...WINDOW, percent: 37.5 }) })
    try { expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 37.5, remainingPercent: 62.5 }) }
    finally { client.dispose() }
  })

  it('also decodes the implicit zero after a REST 500', async () => {
    const { client } = fixture({ status: 500 })
    try { expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 0, remainingPercent: 100 }) }
    finally { client.dispose() }
  })

  it.each([
    () => new Response('', { status: 503 }),
    () => Promise.reject(new TypeError('synthetic transport failure')),
    () => new Response(encodeCreditsGrpcWeb({ ...WINDOW, trailerStatus: 13 })),
    () => new Response(encodeCreditsGrpcWeb({ ...WINDOW, percent: 150 })),
    () => new Response(encodeCreditsGrpcWeb({ ...WINDOW, percent: Number.NaN })),
    () => new Response(encodeCreditsGrpcWeb({ start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' })),
  ])('preserves partial REST metadata when gRPC cannot confirm usable usage: %#', async grpc => {
    const { client } = fixture({ grpc })
    try {
      const snapshot = await client.get()
      expect(snapshot).toMatchObject({ state: 'partial', period: 'week', prepaidBalanceUsd: 5, unifiedBilling: true })
      expect(snapshot).not.toHaveProperty('usedPercent')
    } finally { client.dispose() }
  })

  it.each([
    { config: { creditUsagePercent: 0 } },
    { config: { monthlyLimit: { val: 1000 }, used: { val: 100 } } },
    { config: { ...PARTIAL.config, creditUsagePercent: null } },
    { config: { ...PARTIAL.config, creditUsagePercent: 150 } },
    { config: { monthlyLimit: { val: 1000 }, used: { val: -1 } } },
    { config: 'invalid' },
  ])('does not re-probe explicit, legacy or malformed REST usage: %j', async body => {
    const { client, fetcher } = fixture({ body })
    try {
      await client.get()
      expect(fetcher.mock.calls).toHaveLength(2)
    } finally { client.dispose() }
  })

  it('uses the refreshed bearer when a 401 retry returns partial REST data', async () => {
    let round = 0
    const refresh = vi.fn(async () => 'rotated-bearer')
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === GROK_SETTINGS_URL) return json({})
      if (String(input) === GROK_BILLING_URL) return json(PARTIAL, ++round === 1 ? 401 : 200)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer rotated-bearer')
      return new Response(encodeCreditsGrpcWeb(WINDOW))
    })
    const client = new SuperGrokQuotaClient({
      tokens: { available: () => true, resolve: async () => 'old-bearer', identity: async () => 'account', refresh },
      fetch: fetcher, now: () => NOW,
    })
    try {
      expect(await client.get()).toMatchObject({ state: 'available', usedPercent: 0, remainingPercent: 100 })
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(fetcher.mock.calls.filter(([url]) => String(url) === GROK_GRPC_CREDITS_URL)).toHaveLength(1)
    } finally { client.dispose() }
  })

  it.each(['caller', 'dispose'] as const)('stops a hanging partial-REST verification on %s', async stop => {
    const grpc = vi.fn((signal?: AbortSignal | null) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const { client } = fixture({ grpc, timeoutMs: 1000 })
    const controller = new AbortController()
    const reason = new Error('synthetic caller cancellation')
    try {
      const pending = client.get(controller.signal).catch(error => error as Error)
      await vi.waitFor(() => expect(grpc).toHaveBeenCalledTimes(1), { interval: 1 })
      if (stop === 'caller') controller.abort(reason)
      if (stop === 'dispose') client.dispose()
      expect(await pending).toEqual(stop === 'caller' ? reason : { state: 'error', reason: 'temporary' })
    } finally { client.dispose() }
  })

  it('discards the verified result if the account changes during gRPC', async () => {
    let identity = 'synthetic-account'
    const { client } = fixture({
      tokens: { identity: async () => identity },
      grpc: () => {
        identity = 'other-account'
        return new Response(encodeCreditsGrpcWeb(WINDOW))
      },
    })
    try { expect(await client.get()).toEqual({ state: 'unavailable' }) }
    finally { client.dispose() }
  })
})
