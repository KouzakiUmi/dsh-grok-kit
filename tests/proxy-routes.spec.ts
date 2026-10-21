// Part of dsh-grok-kit, Apache-2.0.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { registerXaiOAuthAuthRoutes, XAI_OAUTH_AUTH_PROXY_PATH } from '../src/auth-routes.ts'
import { applyXaiProxy, fetchGrokQuota, installXaiFetchHook, readXaiProxySettings, setQuotaCompatibilityMode, setXaiProxyUrl } from '../src/proxy.ts'

const control = vi.hoisted(() => ({ fail: false, hold: undefined as Promise<void> | undefined, commits: 0 }))
vi.mock('@deepseek-ai/dsh-atomic-write', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(async (...args: Parameters<typeof actual.writeFileAtomic>) => {
    await control.hold
    if (control.fail) throw new Error('synthetic write failure')
    await actual.writeFileAtomic(...args)
    control.commits += 1
  }) }
})
vi.mock('undici', async importOriginal => ({
  ...await importOriginal<typeof import('undici')>(),
  fetch: vi.fn(async () => new Response('owned')),
}))

let release: () => void
beforeEach(() => {
  vi.stubEnv('DSH_HOME', mkdtempSync(join(tmpdir(), 'dsh-grok-proxy-routes-')))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('legacy')))
  control.fail = false
  control.hold = undefined
  control.commits = 0
  vi.mocked(writeFileAtomic).mockClear()
  release = installXaiFetchHook()
  setXaiProxyUrl('')
  setQuotaCompatibilityMode(false)
})
afterEach(() => { release(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown
function fixture(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>()
  const changed = vi.fn()
  let teardown: () => Promise<void> = async () => undefined
  const ctx = {
    effect: (setup: () => () => Promise<void>) => { teardown = setup() },
    webServer: { register: (route: { path: string; handler: Handler }) => { handlers.set(route.path, route.handler); return () => undefined } },
  }
  registerXaiOAuthAuthRoutes(ctx as never, {} as never, config, undefined, changed)
  const handler = handlers.get(XAI_OAUTH_AUTH_PROXY_PATH)
  if (handler === undefined) throw new Error('missing proxy route')
  let bodyReads = 0
  const invoke = async (method: string, body?: unknown, origin = 'http://localhost', bodyGate?: Promise<void>) => {
    const req = {
      method, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost', origin, 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { await bodyGate; if (body !== undefined) yield Buffer.from(JSON.stringify(body)); bodyReads += 1 },
    }
    const res = { writeHead: vi.fn(), end: vi.fn() }
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    return { status: res.writeHead.mock.calls[0]?.[0] as number, body: JSON.parse(String(res.end.mock.calls[0]?.[0])) as Record<string, unknown> }
  }
  return { invoke, changed, bodyReads: () => bodyReads, dispose: () => teardown() }
}

describe('proxy settings compatibility mode route', () => {
  it('returns the effective config proxy and defaults compatibility off without touching runtime', async () => {
    const { invoke } = fixture({ proxyUrl: 'http://127.0.0.1:9' })
    expect(await invoke('GET')).toEqual({ status: 200, body: { proxyUrl: 'http://127.0.0.1:9', quotaCompatibilityMode: false } })
    expect(writeFileAtomic).not.toHaveBeenCalled()
  })

  it('persists both settings, applies them immediately and restores them on startup', async () => {
    const { invoke, changed } = fixture()
    expect(await invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true }))
      .toEqual({ status: 200, body: { proxyUrl: '', quotaCompatibilityMode: true } })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(await (await fetchGrokQuota('https://cli-chat-proxy.grok.com/v1/settings')).text()).toBe('owned')
    setQuotaCompatibilityMode(false)
    expect(await (await fetchGrokQuota('https://cli-chat-proxy.grok.com/v1/settings')).text()).toBe('legacy')
    applyXaiProxy()
    expect(await (await fetchGrokQuota('https://cli-chat-proxy.grok.com/v1/settings')).text()).toBe('owned')
    expect((await invoke('GET')).body).toEqual({ proxyUrl: '', quotaCompatibilityMode: true })
  })

  it('preserves compatibility mode for old clients that only submit a URL', async () => {
    const { invoke } = fixture()
    await invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true })
    expect((await invoke('POST', { proxyUrl: 'http://127.0.0.1:9' })).body)
      .toEqual({ proxyUrl: 'http://127.0.0.1:9', quotaCompatibilityMode: true })
    expect(readXaiProxySettings()).toEqual({ proxyUrl: 'http://127.0.0.1:9', quotaCompatibilityMode: true })
  })

  it.each(['true', 1, null, {}])('rejects a non-boolean mode without applying or writing it: %j', async mode => {
    const { invoke, changed } = fixture()
    expect((await invoke('POST', { proxyUrl: '', quotaCompatibilityMode: mode })).status).toBe(400)
    expect(writeFileAtomic).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(await (await fetchGrokQuota('https://cli-chat-proxy.grok.com/v1/settings')).text()).toBe('legacy')
  })

  it('keeps disk, runtime and cache unchanged on write failure, then allows a later successful save', async () => {
    const { invoke, changed } = fixture()
    control.fail = true
    expect((await invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true })).status).toBe(500)
    expect(readXaiProxySettings()).toEqual({ proxyUrl: '', quotaCompatibilityMode: false })
    expect(await (await fetchGrokQuota('https://cli-chat-proxy.grok.com/v1/settings')).text()).toBe('legacy')
    expect(changed).not.toHaveBeenCalled()
    control.fail = false
    expect((await invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true })).status).toBe(200)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent URL-only and mode writes instead of resetting a pending mode choice', async () => {
    let unblock!: () => void
    control.hold = new Promise(resolve => { unblock = resolve })
    const { invoke, changed, bodyReads } = fixture()
    const first = invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true })
    const second = invoke('POST', { proxyUrl: 'http://127.0.0.1:10' })
    try {
      await vi.waitFor(() => expect(bodyReads()).toBe(2))
      expect(writeFileAtomic).toHaveBeenCalledTimes(1)
      unblock()
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)
      expect(readXaiProxySettings()).toEqual({ proxyUrl: 'http://127.0.0.1:10', quotaCompatibilityMode: true })
      expect(changed).toHaveBeenCalledTimes(2)
    } finally { unblock(); await Promise.allSettled([first, second]) }
  })

  it('does not reactivate runtime transport when a pending save completes after unload', async () => {
    let unblock!: () => void
    control.hold = new Promise(resolve => { unblock = resolve })
    const { invoke, changed, dispose } = fixture()
    const pending = invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true })
    let releaseNew: () => void = () => undefined
    let commitsAtDisposal: number | undefined
    let draining: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(writeFileAtomic).toHaveBeenCalledTimes(1))
      draining = dispose().then(() => { commitsAtDisposal = control.commits })
      unblock()
      await draining
      // Disposal must join disk completion, not merely suppress live updates.
      expect(commitsAtDisposal).toBe(1)
      release()
      releaseNew = installXaiFetchHook()
      expect((await pending).status).toBe(200)
      expect(changed).not.toHaveBeenCalled()
      expect(await (await fetchGrokQuota('https://cli-chat-proxy.grok.com/v1/settings')).text()).toBe('legacy')
      expect(readXaiProxySettings().quotaCompatibilityMode).toBe(true)
    } finally { unblock(); await Promise.allSettled([pending, draining]); releaseNew() }
  })

  it('finishes an old write before a replacement owner saves compatibility off', async () => {
    let unblock!: () => void
    control.hold = new Promise(resolve => { unblock = resolve })
    const old = fixture()
    const first = old.invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true })
    let draining: Promise<void> | undefined
    let replacement: ReturnType<typeof fixture> | undefined
    let newer: Promise<{ status: number; body: Record<string, unknown> }> | undefined
    let commitsBeforeReplacement: number | undefined
    try {
      await vi.waitFor(() => expect(writeFileAtomic).toHaveBeenCalledTimes(1))
      draining = old.dispose()
      newer = draining.then(() => {
        commitsBeforeReplacement = control.commits
        replacement = fixture()
        return replacement.invoke('POST', { proxyUrl: '', quotaCompatibilityMode: false })
      })
      // Future writes are free to proceed; only the already-started old one
      // retains this gate, which models an atomic rename delayed by I/O.
      control.hold = undefined
      unblock()
      expect((await first).status).toBe(200)
      expect((await newer).status).toBe(200)
      expect(commitsBeforeReplacement).toBe(1)
      expect(readXaiProxySettings()).toEqual({ proxyUrl: '', quotaCompatibilityMode: false })
      expect(old.changed).not.toHaveBeenCalled()
      expect(replacement?.changed).toHaveBeenCalledTimes(1)
      applyXaiProxy()
      expect(await (await fetchGrokQuota('https://cli-chat-proxy.grok.com/v1/settings')).text()).toBe('legacy')
    } finally { unblock(); await Promise.allSettled([first, draining, newer]); await replacement?.dispose() }
  })

  it('joins a rejected in-flight write without poisoning teardown or the replacement owner', async () => {
    let unblock!: () => void
    control.hold = new Promise(resolve => { unblock = resolve })
    const old = fixture()
    const first = old.invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true })
    let draining: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(writeFileAtomic).toHaveBeenCalledTimes(1))
      draining = old.dispose()
      control.fail = true
      unblock()
      expect((await first).status).toBe(500)
      await expect(draining).resolves.toBeUndefined()
      expect(control.commits).toBe(0)
      expect(old.changed).not.toHaveBeenCalled()
      control.fail = false
      control.hold = undefined
      const replacement = fixture()
      try {
        expect((await replacement.invoke('POST', { proxyUrl: '', quotaCompatibilityMode: false })).status).toBe(200)
        expect(readXaiProxySettings().quotaCompatibilityMode).toBe(false)
      } finally { await replacement.dispose() }
    } finally { unblock(); await Promise.allSettled([first, draining]) }
  })

  it('drains the queue tail while rejecting a queued write that has not started before unload', async () => {
    let unblock!: () => void
    control.hold = new Promise(resolve => { unblock = resolve })
    const old = fixture()
    const first = old.invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true })
    const queued = old.invoke('POST', { proxyUrl: '', quotaCompatibilityMode: false })
    let draining: Promise<void> | undefined
    let commitsAtDisposal: number | undefined
    try {
      await vi.waitFor(() => expect(old.bodyReads()).toBe(2))
      expect(writeFileAtomic).toHaveBeenCalledTimes(1)
      draining = old.dispose().then(() => { commitsAtDisposal = control.commits })
      unblock()
      expect((await first).status).toBe(200)
      expect((await queued).status).toBe(500)
      await draining
      expect(commitsAtDisposal).toBe(1)
      expect(writeFileAtomic).toHaveBeenCalledTimes(1)
      expect(old.changed).not.toHaveBeenCalled()
    } finally { unblock(); await Promise.allSettled([first, queued, draining]) }
  })

  it('rejects an old request whose body finishes after disposal without overwriting its replacement', async () => {
    let unblockBody!: () => void
    const bodyGate = new Promise<void>(resolve => { unblockBody = resolve })
    const old = fixture()
    const late = old.invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true }, 'http://localhost', bodyGate)
    let replacement: ReturnType<typeof fixture> | undefined
    try {
      await old.dispose()
      expect(writeFileAtomic).not.toHaveBeenCalled()
      replacement = fixture()
      expect((await replacement.invoke('POST', { proxyUrl: '', quotaCompatibilityMode: false })).status).toBe(200)
      unblockBody()
      expect((await late).status).toBe(500)
      expect(writeFileAtomic).toHaveBeenCalledTimes(1)
      expect(readXaiProxySettings()).toEqual({ proxyUrl: '', quotaCompatibilityMode: false })
      expect(old.changed).not.toHaveBeenCalled()
      expect(replacement.changed).toHaveBeenCalledTimes(1)
    } finally { unblockBody(); await late; await replacement?.dispose() }
  })

  it('retains the same-origin write gate', async () => {
    const { invoke, changed } = fixture()
    expect((await invoke('POST', { proxyUrl: '', quotaCompatibilityMode: true }, 'http://evil.example')).status).toBe(403)
    expect(writeFileAtomic).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })
})
