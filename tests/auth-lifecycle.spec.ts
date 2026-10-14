import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { XaiOAuthSession } from '../src/session.ts'

const authCalls = vi.hoisted(() => ({ login: vi.fn(), importGrok: vi.fn(), status: vi.fn(), authenticated: false }))
vi.mock('../src/auth.ts', () => ({
  loginXaiOAuthSession: authCalls.login,
  importXaiOAuthSession: authCalls.importGrok,
  xaiOAuthAuthStatus: authCalls.status,
}))
vi.mock('../src/grok-import.ts', () => ({ probeGrokAuth: async () => ({ available: false }) }))
import { XaiOAuthWebAuth } from '../src/auth-routes.ts'

beforeEach(() => {
  vi.clearAllMocks()
  authCalls.authenticated = false
  authCalls.status.mockImplementation(async () => ({ authenticated: authCalls.authenticated }))
})

describe('OAuth action serialization', () => {
  function signedInSession() {
    const logout = vi.fn()
    const session = {
      store: { sharedWithGrokCli: false }, logout,
      availableModels: () => [{ id: 'grok-4.6' }],
      visibleModels: () => [{ id: 'grok-4.6' }],
      selectedModelIds: () => ['grok-4.6'],
      catalogSource: 'cache',
    } as unknown as XaiOAuthSession
    return { session, logout }
  }

  it('restores stored signed-in status after reauthorization fails before a challenge', async () => {
    authCalls.authenticated = true
    authCalls.login.mockRejectedValue(new Error('synthetic authorization denied'))
    const { session, logout } = signedInSession()
    const changed = vi.fn()
    const auth = new XaiOAuthWebAuth(session, changed)
    expect(await auth.status()).toMatchObject({ status: 'signed-in' })
    await expect(auth.signIn()).rejects.toThrow('synthetic authorization denied')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(await auth.status()).toMatchObject({ status: 'signed-in', loginError: 'synthetic authorization denied' })
    expect(await auth.status()).toMatchObject({ status: 'signed-in' })
    expect(logout).not.toHaveBeenCalled()
    await auth.dispose()
  })

  it('restores stored identity when an issued authorization challenge is cancelled', async () => {
    authCalls.authenticated = true
    let cancel!: (error: Error) => void
    authCalls.login.mockImplementation(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.x.ai/login' })
      await new Promise<void>((_resolve, reject) => { cancel = reject })
    })
    const { session, logout } = signedInSession()
    const changed = vi.fn()
    const auth = new XaiOAuthWebAuth(session, changed)
    await auth.signIn()
    expect(await auth.status()).toMatchObject({ status: 'signing-in' })
    cancel(new DOMException('synthetic authorization cancelled', 'AbortError'))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(await auth.status()).toMatchObject({ status: 'signed-in', loginError: 'synthetic authorization cancelled' })
    expect(logout).not.toHaveBeenCalled()
    await auth.dispose()
  })

  it('does not let a late recovery read overwrite a newer login challenge', async () => {
    authCalls.authenticated = true
    authCalls.login.mockRejectedValue(new Error('synthetic first login failure'))
    const { session } = signedInSession()
    const changed = vi.fn()
    const auth = new XaiOAuthWebAuth(session, changed)
    await expect(auth.signIn()).rejects.toThrow('synthetic first login failure')
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    let finishRead!: (value: { authenticated: boolean }) => void
    authCalls.status.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const recovering = auth.status()
    authCalls.login.mockImplementation(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.x.ai/new-login' })
      await new Promise<void>((_resolve, reject) => interaction.signal.addEventListener('abort', () => reject(interaction.signal.reason), { once: true }))
    })
    await expect(auth.signIn()).resolves.toEqual({ url: 'https://auth.x.ai/new-login' })
    finishRead({ authenticated: true })
    const status = await recovering
    expect(status).toMatchObject({ status: 'signing-in', url: 'https://auth.x.ai/new-login' })
    expect(status).not.toHaveProperty('loginError')
    expect(await auth.status()).toMatchObject({ status: 'signing-in' })
    await auth.dispose()
  })

  it('does not fabricate a signed-in account when initial authorization fails', async () => {
    authCalls.login.mockRejectedValue(new Error('synthetic initial login failure'))
    const { session, logout } = signedInSession()
    const auth = new XaiOAuthWebAuth(session)
    await expect(auth.signIn()).rejects.toThrow('synthetic initial login failure')
    await auth.dispose()
    expect(await auth.status()).toMatchObject({ status: 'error', message: 'synthetic initial login failure' })
    expect(logout).not.toHaveBeenCalled()
  })

  it('waits for all queued import/logout operations before starting login', async () => {
    let finishImport!: () => void
    let finishLogout!: () => void
    authCalls.importGrok.mockImplementation(() => new Promise<void>(resolve => { finishImport = resolve }))
    const logout = vi.fn(() => new Promise<void>(resolve => { finishLogout = resolve }))
    authCalls.login.mockImplementation(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.x.ai/login' })
    })
    const session = { store: { sharedWithGrokCli: false }, logout } as unknown as XaiOAuthSession
    const auth = new XaiOAuthWebAuth(session)
    const importing = auth.importGrok()
    const signingOut = auth.signOut()
    await vi.waitFor(() => expect(authCalls.importGrok).toHaveBeenCalledOnce())
    finishImport()
    await importing
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce())
    const signingIn = auth.signIn()
    await Promise.resolve()
    await Promise.resolve()
    expect(authCalls.login).not.toHaveBeenCalled()
    finishLogout()
    await signingOut
    await expect(signingIn).resolves.toEqual({ url: 'https://auth.x.ai/login' })
    await auth.dispose()
  })

  it('invalidates account state around import even when its catalog refresh fails', async () => {
    authCalls.importGrok.mockRejectedValue(new Error('synthetic catalog failure after credential write'))
    const changed = vi.fn()
    const auth = new XaiOAuthWebAuth({ store: { sharedWithGrokCli: false } } as unknown as XaiOAuthSession, changed)
    await expect(auth.importGrok()).rejects.toThrow('synthetic catalog failure')
    expect(changed).toHaveBeenCalledTimes(2)
    await auth.dispose()
  })

  it('invalidates account state around logout even when later cache cleanup fails', async () => {
    const changed = vi.fn()
    const session = { store: { sharedWithGrokCli: false }, logout: vi.fn(async () => { throw new Error('synthetic cleanup failure') }) } as unknown as XaiOAuthSession
    const auth = new XaiOAuthWebAuth(session, changed)
    await expect(auth.signOut()).rejects.toThrow('synthetic cleanup failure')
    expect(changed).toHaveBeenCalledTimes(2)
    await auth.dispose()
  })

  it('invalidates login completion independently of catalog success', async () => {
    let fail!: (reason: Error) => void
    authCalls.login.mockImplementation(async interaction => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.x.ai/login' })
      await new Promise<void>((_resolve, reject) => { fail = reject })
    })
    const changed = vi.fn()
    const auth = new XaiOAuthWebAuth({ store: { sharedWithGrokCli: false } } as unknown as XaiOAuthSession, changed)
    await auth.signIn()
    expect(changed).toHaveBeenCalledTimes(1)
    fail(new Error('synthetic catalog failure after credential write'))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(await auth.status()).toMatchObject({ status: 'error' })
    await auth.dispose()
  })
})
