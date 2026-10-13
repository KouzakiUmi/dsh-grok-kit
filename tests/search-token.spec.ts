import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createXaiOAuthSearchTokenSource } from '../src/index.ts'
import type { XaiOAuthSession } from '../src/session.ts'
import { oauthIdentityOf } from '../src/token-source.ts'
import { XaiOAuthSearchProvider } from '../src/search.ts'

type OAuthCredential = Extract<Awaited<ReturnType<XaiOAuthSession['store']['read']>>, { type: 'oauth' }> & { accountId?: string }

function fakeSession(options: {
  credential?: OAuthCredential
  auth?: { source?: string; auth: { apiKey?: string } }
  refresh?: (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>
}) {
  let current = options.credential
  const getAuth = vi.fn(async () => options.auth)
  const refresh = vi.fn(options.refresh ?? (async (credential: OAuthCredential) => credential))
  const modify = vi.fn(async (_providerId: string, fn: (credential: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>) => {
    const candidate = await fn(current)
    if (candidate !== undefined) current = candidate
    return current
  })
  const session = {
    store: {
      // available() is a cheap existence check; this spec file exists.
      filename: fileURLToPath(import.meta.url),
      exists: vi.fn(() => true),
      read: vi.fn(async () => current),
      modify,
    },
    models: {
      getAuth,
      getProvider: vi.fn(() => options.refresh === undefined ? { auth: {} } : { auth: { oauth: { refresh } } }),
    },
  } as unknown as XaiOAuthSession
  return { session, getAuth, refresh, modify, current: () => current }
}

describe('durable OAuth account identity', () => {
  it('hashes the stable account id, not the rotating token', () => {
    const first = oauthIdentityOf({ type: 'oauth', accountId: 'account-a', access: 'old' })
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(oauthIdentityOf({ type: 'oauth', accountId: 'account-a', access: 'new' })).toBe(first)
    expect(oauthIdentityOf({ type: 'oauth', accountId: 'account-b', access: 'old' })).not.toBe(first)
    expect(first).not.toContain('account-a')
  })

  it('uses an xAI JWT subject only as a local partition and rejects foreign/opaque tokens', () => {
    const jwt = (claims: unknown) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
    const identified = oauthIdentityOf({ type: 'oauth', access: jwt({ iss: 'https://auth.x.ai', sub: 'account-a' }) })
    expect(identified).toBe(oauthIdentityOf({ type: 'oauth', accountId: 'account-a' }))
    expect(oauthIdentityOf({ type: 'oauth', access: jwt({ iss: 'https://foreign.example', sub: 'account-a' }) })).toBeUndefined()
    expect(oauthIdentityOf({ type: 'oauth', access: jwt({ iss: 'https://auth.x.ai' }) })).toBeUndefined()
    expect(oauthIdentityOf({ type: 'oauth', access: 'opaque' })).toBeUndefined()
    expect(oauthIdentityOf({ type: 'api_key', accountId: 'account-a' })).toBeUndefined()
    expect(oauthIdentityOf({ type: 'oauth', accountId: ' ' })).toBeUndefined()
    expect(oauthIdentityOf({ type: 'oauth', access: 'x'.repeat(32_769) })).toBeUndefined()
  })

  it('does not refresh or contact the network for an identity lookup', async () => {
    const fixture = fakeSession({ credential: { type: 'oauth', access: 'opaque', refresh: 'r', expires: 1 } })
    await expect(createXaiOAuthSearchTokenSource(fixture.session).identity!()).resolves.toBeUndefined()
    expect(fixture.getAuth).not.toHaveBeenCalled()
    expect(fixture.refresh).not.toHaveBeenCalled()
  })
})

describe('createXaiOAuthSearchTokenSource', () => {
  it('stops a cancelled caller while getAuth is still pending', async () => {
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1 }
    const fixture = fakeSession({ credential })
    let release!: (value: { source: string; auth: { apiKey: string } }) => void
    const gate = new Promise<{ source: string; auth: { apiKey: string } }>(resolve => { release = resolve })
    fixture.getAuth.mockImplementation(() => gate)
    const caller = new AbortController()
    const reason = new Error('cancelled credential waiter')
    let failure: unknown
    const pending = createXaiOAuthSearchTokenSource(fixture.session).resolve(caller.signal)
    const observed = pending.catch(error => { failure = error })
    await vi.waitFor(() => expect(fixture.getAuth).toHaveBeenCalledOnce())
    caller.abort(reason)
    try {
      await vi.waitFor(() => expect(failure).toBe(reason), { timeout: 100 })
    } finally {
      release({ source: 'OAuth', auth: { apiKey: 'late-token' } })
      await observed
    }
  })

  it('stops a cancelled credential read without starting getAuth', async () => {
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1 }
    const fixture = fakeSession({ credential })
    let release!: (value: OAuthCredential) => void
    const gate = new Promise<OAuthCredential>(resolve => { release = resolve })
    vi.spyOn(fixture.session.store, 'read').mockImplementation(() => gate)
    const caller = new AbortController()
    const reason = new Error('cancelled store waiter')
    let failure: unknown
    const observed = createXaiOAuthSearchTokenSource(fixture.session).resolve(caller.signal).catch(error => { failure = error })
    caller.abort(reason)
    try {
      await vi.waitFor(() => expect(failure).toBe(reason), { timeout: 100 })
      expect(fixture.getAuth).not.toHaveBeenCalled()
    } finally {
      release(credential)
      await observed
    }
  })

  it('cancels one auth waiter without cancelling another caller or leaking its listener', async () => {
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1 }
    const fixture = fakeSession({ credential })
    let release!: (value: { source: string; auth: { apiKey: string } }) => void
    const gate = new Promise<{ source: string; auth: { apiKey: string } }>(resolve => { release = resolve })
    fixture.getAuth.mockImplementation(() => gate)
    const caller = new AbortController()
    const cleanup = vi.spyOn(caller.signal, 'removeEventListener')
    const source = createXaiOAuthSearchTokenSource(fixture.session)
    const cancelled = source.resolve(caller.signal)
    const rejected = expect(cancelled).rejects.toThrow('cancelled auth waiter')
    const other = source.resolve()
    await vi.waitFor(() => expect(fixture.getAuth).toHaveBeenCalledTimes(2))
    caller.abort(new Error('cancelled auth waiter'))
    await rejected
    expect(cleanup.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(2)
    release({ source: 'OAuth', auth: { apiKey: 'current-token' } })
    await expect(other).resolves.toBe('current-token')
  })

  it('observes a late rejection when getAuth aborts its caller before returning', async () => {
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1 }
    const fixture = fakeSession({ credential })
    const caller = new AbortController()
    const reason = new Error('cancelled during auth call')
    fixture.getAuth.mockImplementation(() => {
      caller.abort(reason)
      return Promise.reject(new Error('late auth failure'))
    })
    await expect(createXaiOAuthSearchTokenSource(fixture.session).resolve(caller.signal)).rejects.toBe(reason)
    // Vitest also fails the suite if the late operation becomes unhandled.
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it.each(['web_search', 'x_search'] as const)('returns WEB_ABORTED during credential resolution for %s without starting a search', async tool => {
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1 }
    const fixture = fakeSession({ credential })
    fixture.getAuth.mockImplementation(() => new Promise<never>(() => undefined))
    const fetch = vi.fn()
    const caller = new AbortController()
    const provider = new XaiOAuthSearchProvider(createXaiOAuthSearchTokenSource(fixture.session), tool, { fetch })
    const result = provider.search({ query: 'synthetic query' }, caller.signal)
    const rejected = expect(result).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    await vi.waitFor(() => expect(fixture.getAuth).toHaveBeenCalledOnce())
    caller.abort(new Error('cancelled search'))
    await rejected
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not let ambient XAI_API_KEY become a fallback when OAuth is absent', async () => {
    const { session, getAuth } = fakeSession({
      auth: { source: 'XAI_API_KEY', auth: { apiKey: 'paid-key' } },
    })
    const source = createXaiOAuthSearchTokenSource(session)

    expect(source.available()).toBe(true)
    await expect(source.resolve()).resolves.toBeUndefined()
    expect(getAuth).not.toHaveBeenCalled()
  })

  it('accepts only an OAuth-authenticated bearer', async () => {
    const credential: OAuthCredential = {
      type: 'oauth', access: 'oauth-token', refresh: 'refresh-token', expires: Date.now() + 60_000,
    }
    const oauth = fakeSession({ credential, auth: { source: 'OAuth', auth: { apiKey: 'oauth-token' } } })
    await expect(createXaiOAuthSearchTokenSource(oauth.session).resolve()).resolves.toBe('oauth-token')

    const wrongSource = fakeSession({ credential, auth: { source: 'XAI_API_KEY', auth: { apiKey: 'paid-key' } } })
    await expect(createXaiOAuthSearchTokenSource(wrongSource.session).resolve()).resolves.toBeUndefined()
  })

  it('rotates an OAuth token under the credential-store modify lock', async () => {
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'refresh-old', expires: 1 }
    const fixture = fakeSession({
      credential,
      refresh: async current => ({ ...current, access: 'new', refresh: 'refresh-new', expires: Date.now() + 60_000 }),
    })
    const source = createXaiOAuthSearchTokenSource(fixture.session)

    await expect(source.refresh?.('old')).resolves.toBe('new')
    expect(fixture.refresh).toHaveBeenCalledOnce()
    expect(fixture.modify).toHaveBeenCalledOnce()
    expect(fixture.current()?.refresh).toBe('refresh-new')
  })

  it('retains imported stable account metadata when a refresh response omits it', async () => {
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1, accountId: 'account-a' }
    const fixture = fakeSession({ credential, refresh: async () => ({ type: 'oauth', access: 'new', refresh: 'r2', expires: Date.now() + 60_000 }) })
    const source = createXaiOAuthSearchTokenSource(fixture.session)
    const identity = await source.identity!()
    await expect(source.refresh!('old')).resolves.toBe('new')
    expect(fixture.current()?.accountId).toBe('account-a')
    await expect(source.identity!()).resolves.toBe(identity)
  })

  it('reuses a bearer already rotated by another process instead of refreshing twice', async () => {
    const credential: OAuthCredential = {
      type: 'oauth', access: 'already-new', refresh: 'refresh-new', expires: Date.now() + 60_000,
    }
    const fixture = fakeSession({
      credential,
      refresh: async current => ({ ...current, access: 'should-not-run' }),
    })
    const source = createXaiOAuthSearchTokenSource(fixture.session)

    await expect(source.refresh?.('rejected-old')).resolves.toBe('already-new')
    expect(fixture.refresh).not.toHaveBeenCalled()
    expect(fixture.current()?.access).toBe('already-new')
  })

  it('coalesces concurrent refresh of the same rejected bearer', async () => {
    let resolveRefresh!: (value: OAuthCredential) => void
    const hang = new Promise<OAuthCredential>(resolve => {
      resolveRefresh = resolve
    })
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1 }
    const fixture = fakeSession({
      credential,
      refresh: async () => hang,
    })
    const source = createXaiOAuthSearchTokenSource(fixture.session)
    const first = source.refresh?.('old')
    const second = source.refresh?.('old')
    resolveRefresh({ type: 'oauth', access: 'new', refresh: 'r2', expires: Date.now() + 60_000 })
    await expect(first).resolves.toBe('new')
    await expect(second).resolves.toBe('new')
    expect(fixture.refresh).toHaveBeenCalledOnce()
  })

  it('does not coalesce the same bearer from different credential stores', async () => {
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1 }
    const a = fakeSession({ credential, refresh: async current => ({ ...current, access: 'new-a' }) })
    const b = fakeSession({ credential, refresh: async current => ({ ...current, access: 'new-b' }) })
    Object.defineProperty(b.session.store, 'filename', { value: 'separate-store.json' })
    const first = createXaiOAuthSearchTokenSource(a.session).refresh!('old')
    const second = createXaiOAuthSearchTokenSource(b.session).refresh!('old')
    expect(await Promise.all([first, second])).toEqual(['new-a', 'new-b'])
    expect(a.refresh).toHaveBeenCalledOnce()
    expect(b.refresh).toHaveBeenCalledOnce()
  })

  it('cancels one waiter without aborting the shared refresh for another', async () => {
    let release!: (value: OAuthCredential) => void
    const gate = new Promise<OAuthCredential>(resolve => { release = resolve })
    const credential: OAuthCredential = { type: 'oauth', access: 'old', refresh: 'r', expires: 1 }
    const fixture = fakeSession({ credential, refresh: async () => gate })
    const source = createXaiOAuthSearchTokenSource(fixture.session)
    const controller = new AbortController()
    const cancelled = source.refresh!('old', controller.signal)
    const other = source.refresh!('old')
    controller.abort(new Error('cancelled caller'))
    await expect(cancelled).rejects.toThrow('cancelled caller')
    release({ ...credential, access: 'new', refresh: 'new-r' })
    await expect(other).resolves.toBe('new')
    expect(fixture.refresh).toHaveBeenCalledOnce()
    expect(fixture.refresh.mock.calls[0]![1].aborted).toBe(false)
  })
})
