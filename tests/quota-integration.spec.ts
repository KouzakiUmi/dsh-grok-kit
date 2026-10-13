import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SuperGrokQuotaClient } from '../src/quota.ts'
const captured = vi.hoisted(() => ({ notify: undefined as (() => void) | undefined, quota: undefined as SuperGrokQuotaClient | undefined }))
vi.mock('../src/session.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/session.ts')>()
  return { ...original, XaiOAuthSession: class extends original.XaiOAuthSession {
    constructor(...args: ConstructorParameters<typeof original.XaiOAuthSession>) { super(...args); captured.notify = args[1] }
  } }
})
vi.mock('../src/token-source.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/token-source.ts')>(),
  createXaiOAuthSearchTokenSource: () => ({ available: () => true, identity: async () => 'account-a', resolve: async () => 'synthetic-access' }),
}))
vi.mock('../src/quota-routes.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/quota-routes.ts')>(),
  registerGrokQuotaRoute: (_ctx: unknown, quota: SuperGrokQuotaClient) => { captured.quota = quota },
}))
import { apply } from '../src/index.ts'
import { XaiOAuthSession } from '../src/session.ts'
afterEach(() => { captured.quota?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('quota account lifecycle integration', () => {
  it('clears successful quota cache through existing account/catalog notifications without visiting media', async () => {
    vi.spyOn(XaiOAuthSession.prototype, 'loadCachedCatalog').mockResolvedValue(undefined)
    vi.spyOn(XaiOAuthSession.prototype, 'refreshLiveCatalog').mockResolvedValue(undefined)
    let percent = 42
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => new Response(JSON.stringify(
      String(input).includes('/billing?') ? { config: { creditUsagePercent: percent } } : { subscription_tier_display: 'SuperGrok' },
    )))
    vi.stubGlobal('fetch', fetch)
    const scoped = { tools: { register: vi.fn() }, systemPrompt: { section: vi.fn() }, webServer: { register: vi.fn(() => () => undefined) }, effect: vi.fn() }
    const ctx = {
      emit: vi.fn(), get: vi.fn(), effect: vi.fn(),
      llm: { listProviders: () => [], registerAdapter: vi.fn() },
      inject: (_deps: unknown, callback: (context: typeof scoped) => void) => callback(scoped),
    }
    apply(ctx as never, { imagineTool: false, editTool: false, videoTool: false })
    expect(await captured.quota!.get()).toMatchObject({ state: 'available', usedPercent: 42 })
    percent = 20
    expect(await captured.quota!.get()).toMatchObject({ state: 'available', usedPercent: 42 })
    expect(fetch).toHaveBeenCalledTimes(2)
    captured.notify!()
    expect(ctx.emit).toHaveBeenCalledWith('llm/adapters-updated')
    expect(await captured.quota!.get()).toMatchObject({ state: 'available', usedPercent: 20 })
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
