import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SuperGrokQuotaClient } from '../src/quota.ts'
import type { GrokCapabilityRouteOptions } from '../src/capability-routes.ts'
const captured = vi.hoisted(() => ({
  notify: undefined as (() => void) | undefined,
  authChanged: undefined as (() => void) | undefined,
  quota: undefined as SuperGrokQuotaClient | undefined,
  capabilities: undefined as GrokCapabilityRouteOptions | undefined,
  identity: 'account-a' as string | undefined,
}))
vi.mock('../src/session.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/session.ts')>()
  return { ...original, XaiOAuthSession: class extends original.XaiOAuthSession {
    constructor(...args: ConstructorParameters<typeof original.XaiOAuthSession>) { super(...args); captured.notify = args[1] }
  } }
})
vi.mock('../src/token-source.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/token-source.ts')>(),
  createXaiOAuthSearchTokenSource: () => ({ available: () => true, identity: async () => captured.identity, resolve: async () => 'synthetic-access' }),
}))
vi.mock('../src/options.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/options.ts')>(), readStoredOptions: () => ({}),
}))
vi.mock('../src/quota-routes.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/quota-routes.ts')>(),
  registerGrokQuotaRoute: (_ctx: unknown, quota: SuperGrokQuotaClient) => { captured.quota = quota },
}))
vi.mock('../src/auth-routes.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/auth-routes.ts')>(),
  registerXaiOAuthAuthRoutes: (_ctx: unknown, _session: unknown, _config: unknown, onAccountChange?: () => void) => { captured.authChanged = onAccountChange },
}))
vi.mock('../src/capability-routes.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/capability-routes.ts')>(),
  registerGrokCapabilityRoutes: (_ctx: unknown, options: GrokCapabilityRouteOptions) => { captured.capabilities = options },
}))
import { apply } from '../src/index.ts'
import { XaiOAuthSession } from '../src/session.ts'
beforeEach(() => { captured.identity = 'account-a' })
afterEach(() => { captured.quota?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture() {
  vi.spyOn(XaiOAuthSession.prototype, 'loadCachedCatalog').mockResolvedValue(undefined)
  vi.spyOn(XaiOAuthSession.prototype, 'refreshLiveCatalog').mockResolvedValue(undefined)
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => new Response(JSON.stringify(
    String(input).includes('/billing?') ? { config: { creditUsagePercent: 42 } } : { subscription_tier_display: 'SuperGrok' },
  )))
  vi.stubGlobal('fetch', fetch)
  const scoped = { tools: { register: vi.fn() }, systemPrompt: { section: vi.fn() }, webServer: { register: vi.fn(() => () => undefined) }, effect: vi.fn() }
  const ctx = {
    emit: vi.fn(), get: vi.fn(), effect: vi.fn(),
    llm: { listProviders: () => [], registerAdapter: vi.fn() },
    inject: (_deps: unknown, callback: (context: typeof scoped) => void) => callback(scoped),
  }
  apply(ctx as never, { imagineTool: false, editTool: false, videoTool: false })
  return { quota: captured.quota!, capabilities: captured.capabilities!, fetch, ctx }
}

describe('quota account lifecycle integration', () => {
  it('preserves quota cache on same-account model selection and catalog notifications', async () => {
    const { quota, fetch, ctx } = fixture()
    const cached = await quota.get()
    expect(cached).toMatchObject({ state: 'available', usedPercent: 42 })
    fetch.mockRejectedValue(new Error('synthetic network failure after caching'))
    captured.notify!()
    captured.notify!()
    expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
    expect(await quota.get()).toBe(cached)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('invalidates on explicit auth changes even before media is visited', async () => {
    const { quota, fetch } = fixture()
    const cached = await quota.get()
    captured.authChanged!()
    expect(await quota.get()).not.toBe(cached)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('keeps the cached account quota through first media identity initialization', async () => {
    const { quota, capabilities, fetch } = fixture()
    const cached = await quota.get()
    fetch.mockRejectedValue(new Error('synthetic network failure after caching'))
    expect(await capabilities.identity!()).toBe('account-a')
    expect(await capabilities.identity!()).toBe('account-a')
    expect(await quota.get()).toBe(cached)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('still resets quota on a known account change and unknown identity', async () => {
    const { quota, capabilities } = fixture()
    await quota.get()
    await capabilities.identity!()
    const reset = vi.spyOn(quota, 'reset')
    captured.identity = 'account-b'
    await capabilities.identity!()
    expect(reset).toHaveBeenCalledTimes(1)
    captured.identity = undefined
    await capabilities.identity!()
    expect(reset).toHaveBeenCalledTimes(2)
    expect(await quota.get()).toMatchObject({ state: 'unavailable', reason: 'auth' })
  })
})
