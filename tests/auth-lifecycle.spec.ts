import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { XaiOAuthSession } from '../src/session.ts'

const authCalls = vi.hoisted(() => ({ login: vi.fn(), importGrok: vi.fn() }))
vi.mock('../src/auth.ts', () => ({
  loginXaiOAuthSession: authCalls.login,
  importXaiOAuthSession: authCalls.importGrok,
  xaiOAuthAuthStatus: async () => ({ authenticated: false }),
}))
vi.mock('../src/grok-import.ts', () => ({ probeGrokAuth: async () => ({ available: false }) }))
import { XaiOAuthWebAuth } from '../src/auth-routes.ts'

beforeEach(() => { vi.clearAllMocks() })

describe('OAuth action serialization', () => {
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
