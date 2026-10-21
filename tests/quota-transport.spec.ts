// Part of dsh-grok-kit, Apache-2.0.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { SuperGrokQuotaClient, GROK_BILLING_URL, GROK_SETTINGS_URL } from '../src/quota.ts'
import { GROK_GRPC_CREDITS_URL } from '../src/grok-credits.ts'
import { fetchWithBearer } from '../src/bearer-guard.ts'
import { encodeCreditsGrpcWeb } from './grok-credits-frame.ts'
import { fetchGrokQuota, installXaiFetchHook, setQuotaCompatibilityMode, setXaiProxyUrl } from '../src/proxy.ts'

const probe = vi.hoisted(() => ({
  reply: (_input: unknown, _init?: { signal?: AbortSignal | null }): Promise<Response> => Promise.resolve(new Response('{}')),
}))
vi.mock('undici', async importOriginal => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: vi.fn((input: unknown, init?: { signal?: AbortSignal | null }) => probe.reply(input, init)),
}))

let release: () => void
const legacy = vi.fn(async () => new Response('legacy'))
beforeEach(() => {
  vi.stubGlobal('fetch', legacy)
  release = installXaiFetchHook()
  legacy.mockClear()
  vi.mocked(undiciFetch).mockClear()
  setXaiProxyUrl('')
  setQuotaCompatibilityMode(false)
  probe.reply = async () => new Response('{}')
})
afterEach(() => { release(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// Widen the spy's overloaded tuple type: runtime records both close() and
// close(callback), although TS selects only the last declared overload.
function outerCloseCalls(calls: ReadonlyArray<ReadonlyArray<unknown>>) {
  return calls.filter(args => args.length === 0)
}

function client(timeoutMs = 1000) {
  return new SuperGrokQuotaClient({
    tokens: { available: () => true, identity: async () => 'synthetic-account', resolve: async () => 'synthetic-bearer' },
    fetch: fetchGrokQuota, timeoutMs,
  })
}

describe('quota-owned transport compatibility mode', () => {
  it('defaults off and reads the latest global wrapper instead of capturing one', async () => {
    const later = vi.fn(async () => new Response('later'))
    vi.stubGlobal('fetch', later)
    expect(await (await fetchGrokQuota(GROK_BILLING_URL)).text()).toBe('later')
    expect(later).toHaveBeenCalledTimes(1)
    expect(undiciFetch).not.toHaveBeenCalled()
  })

  it('bypasses a replaced global fetch for REST billing and settings without changing chat', async () => {
    const later = vi.fn(async () => { throw new Error('foreign wrapper must not receive quota') })
    vi.stubGlobal('fetch', later)
    setXaiProxyUrl('http://127.0.0.1:9')
    probe.reply = async input => new Response(JSON.stringify(String(input) === GROK_BILLING_URL
      ? { config: { creditUsagePercent: 42 } } : { subscription_tier_display: 'SuperGrok' }))
    const quota = client()
    try {
      // The same configured proxy is bypassed by the foreign global wrapper
      // when compatibility is off. Enabling only the switch recovers the read.
      expect(await quota.get()).toEqual({ state: 'error', reason: 'temporary' })
      expect(later).toHaveBeenCalled()
      later.mockClear()
      setQuotaCompatibilityMode(true)
      expect(await quota.get()).toMatchObject({ state: 'available', usedPercent: 42, plan: 'SuperGrok' })
      expect(later).not.toHaveBeenCalled()
      expect(vi.mocked(undiciFetch).mock.calls.map(([url]) => String(url))).toEqual([GROK_BILLING_URL, GROK_SETTINGS_URL])
      for (const [, init] of vi.mocked(undiciFetch).mock.calls) {
        expect(init?.dispatcher).toBeInstanceOf(ProxyAgent)
        expect(init?.headers).toMatchObject({ authorization: 'Bearer synthetic-bearer' })
        expect(init?.redirect).toBe('error')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
      }
      expect(globalThis.fetch).toBe(later)
    } finally { quota.dispose() }
  })

  it('preserves gRPC request bytes, response headers and streaming body through the adapter', async () => {
    setQuotaCompatibilityMode(true)
    probe.reply = async input => String(input) === GROK_BILLING_URL
      ? new Response('', { status: 500 })
      : String(input) === GROK_SETTINGS_URL ? new Response('{}')
        : new Response(encodeCreditsGrpcWeb({ percent: 37.5 }), { headers: { 'grpc-status': '0', 'content-type': 'application/grpc-web+proto' } })
    const quota = client()
    try {
      expect(await quota.get()).toMatchObject({ state: 'available', usedPercent: 37.5, remainingPercent: 62.5 })
      const call = vi.mocked(undiciFetch).mock.calls.find(([url]) => String(url) === GROK_GRPC_CREDITS_URL)
      expect(call?.[1]?.body).toEqual(new Uint8Array([0, 0, 0, 0, 0]))
      expect(call?.[1]?.headers).toMatchObject({ authorization: 'Bearer synthetic-bearer', 'x-grpc-web': '1' })
      expect(legacy).not.toHaveBeenCalled()
    } finally { quota.dispose() }
  })

  it('reads a new proxy agent on every call, closes retired agents and explicitly goes direct on clear', async () => {
    setQuotaCompatibilityMode(true)
    setXaiProxyUrl('http://127.0.0.1:9')
    await fetchGrokQuota(GROK_BILLING_URL)
    const first = vi.mocked(undiciFetch).mock.calls[0]?.[1]?.dispatcher
    if (first === undefined) throw new Error('missing first dispatcher')
    const closeFirst = vi.spyOn(first, 'close')
    setXaiProxyUrl('http://127.0.0.1:10')
    await fetchGrokQuota(GROK_SETTINGS_URL)
    const second = vi.mocked(undiciFetch).mock.calls[1]?.[1]?.dispatcher
    if (second === undefined) throw new Error('missing second dispatcher')
    const closeSecond = vi.spyOn(second, 'close')
    expect(second).not.toBe(first)
    // Undici's promise overload internally re-enters close(callback).
    expect(outerCloseCalls(closeFirst.mock.calls)).toHaveLength(1)
    setXaiProxyUrl('')
    await fetchGrokQuota(GROK_BILLING_URL)
    const direct = vi.mocked(undiciFetch).mock.calls[2]?.[1]?.dispatcher
    expect(direct).toBeInstanceOf(Agent)
    expect(direct).not.toBeInstanceOf(ProxyAgent)
    expect(outerCloseCalls(closeSecond.mock.calls)).toHaveLength(1)
    expect(legacy).not.toHaveBeenCalled()
    setQuotaCompatibilityMode(false)
    expect(await (await fetchGrokQuota(GROK_SETTINGS_URL)).text()).toBe('legacy')
    expect(undiciFetch).toHaveBeenCalledTimes(3)
  })

  it('closes its direct agent only after the last owner releases and preserves a later global wrapper', async () => {
    const releaseOther = installXaiFetchHook()
    try {
      setQuotaCompatibilityMode(true)
      await fetchGrokQuota(GROK_BILLING_URL)
      const dispatcher = vi.mocked(undiciFetch).mock.calls[0]?.[1]?.dispatcher
      if (dispatcher === undefined) throw new Error('missing direct dispatcher')
      const close = vi.spyOn(dispatcher, 'close')
      const later = vi.fn(async () => new Response('later'))
      vi.stubGlobal('fetch', later)
      release()
      expect(close).not.toHaveBeenCalled()
      releaseOther()
      releaseOther()
      expect(outerCloseCalls(close.mock.calls)).toHaveLength(1)
      expect(globalThis.fetch).toBe(later)
      expect(await (await fetchGrokQuota(GROK_BILLING_URL)).text()).toBe('later')
    } finally { releaseOther() }
  })

  it('still refuses bearer destinations before any transport or proxy is invoked', () => {
    setQuotaCompatibilityMode(true)
    expect(() => fetchWithBearer(fetchGrokQuota, 'https://evil.example/', 'synthetic-bearer', {})).toThrow()
    expect(undiciFetch).not.toHaveBeenCalled()
    expect(legacy).not.toHaveBeenCalled()
  })

  it('retains the whole-get deadline and cancels an uncompleted adapted response body', async () => {
    setQuotaCompatibilityMode(true)
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([123])) }, cancel })
    probe.reply = async input => String(input) === GROK_SETTINGS_URL ? new Response('{}') : new Response(body)
    const quota = client(40)
    try {
      expect(await quota.get()).toEqual({ state: 'error', reason: 'temporary' })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(body.locked).toBe(false)
      expect(vi.mocked(undiciFetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    } finally { quota.dispose() }
  })
})
