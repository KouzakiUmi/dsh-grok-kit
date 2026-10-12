import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { XaiOAuthSession } from '../src/session.ts'
import type { XaiOAuthCredentialStore } from '../src/store.ts'
import { restoreEnv } from './restore-env.ts'

const FUTURE = Date.now() + 3_600_000

function oauthCredential() {
  return { type: 'oauth' as const, access: 'access-token', refresh: 'refresh-token', expires: FUTURE }
}

function mockStore(impl: {
  read: () => Promise<unknown>
  exists?: () => boolean
  delete?: () => Promise<void>
}): XaiOAuthCredentialStore {
  return {
    read: impl.read,
    exists: impl.exists ?? (() => true),
    delete: impl.delete ?? (async () => undefined),
    filename: 'unused',
  } as unknown as XaiOAuthCredentialStore
}

/** Serve a minimal OpenAI-shaped /v1/models body without touching the network. */
function stubModelsFetch(): void {
  vi.stubGlobal('fetch', async () => new Response(
    JSON.stringify({ data: [{ id: 'grok-4.6' }, { id: 'grok-imagine-image' }] }),
    { status: 200 },
  ))
}

let realDshHome: string | undefined
let tempHome: string | undefined

/** Keep writeCache out of the real user home during retry tests. */
async function isolateDshHome(): Promise<void> {
  tempHome = await mkdtemp(join(tmpdir(), 'dsh-xai-session-'))
  realDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempHome
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (tempHome !== undefined) restoreEnv('DSH_HOME', realDshHome)
  const home = tempHome
  realDshHome = undefined
  tempHome = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
})

describe('session OAuth identity preservation', () => {
  it('retains accountId through provider-native refresh without changing new-login semantics', async () => {
    const session = new XaiOAuthSession(mockStore({ read: async () => undefined }), undefined, { catalogRetryDelaysMs: [] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }), { status: 200 })))
    const oauth = session.models.getProvider('xai')?.auth.oauth
    expect(oauth).toBeDefined()
    const credential = { ...oauthCredential(), accountId: 'account-a' }
    const rotated = await oauth!.refresh(credential, new AbortController().signal)
    expect(rotated.accountId).toBe('account-a')
    expect(rotated.access).toBe('new')
    const withoutAccount = await oauth!.refresh(oauthCredential(), new AbortController().signal)
    expect(withoutAccount.accountId).toBeUndefined()
    session.dispose()
  })
})

describe('XaiOAuthSession.refreshLiveCatalog', () => {
  it('does not reject when credential resolution hits a lock timeout', async () => {
    const store = mockStore({
      read: async () => {
        throw new Error('timed out waiting for lock on C:\\Users\\x\\.grok\\auth.json')
      },
    })
    // Empty retry schedule keeps this unit test free of background timers.
    const session = new XaiOAuthSession(store, undefined, { catalogRetryDelaysMs: [] })
    await expect(session.refreshLiveCatalog()).resolves.toBeUndefined()
    expect(session.catalogError).toMatch(/timed out waiting for lock/)
  })

  it('retries in the background after a failure and recovers to the live catalog', async () => {
    vi.useFakeTimers()
    await isolateDshHome()
    let reads = 0
    const store = mockStore({
      read: async () => {
        reads += 1
        if (reads < 2) throw new Error('atomic-write: timed out waiting for the writer lock at X.lock')
        return oauthCredential()
      },
    })
    const changes: number[] = []
    const session = new XaiOAuthSession(store, () => { changes.push(1) })
    stubModelsFetch()
    await session.refreshLiveCatalog()
    expect(session.catalogSource).toBe('fallback')
    expect(reads).toBe(1)
    await vi.runAllTimersAsync()
    expect(reads).toBe(2)
    expect(session.catalogSource).toBe('live')
    expect(session.catalogError).toBeUndefined()
    // The retry runs detached (void), so its success tail — writeCache + the
    // change notification — settles on real fs IO after the timer queue
    // drains. waitFor bridges that last hop.
    await vi.waitFor(() => expect(changes.length).toBeGreaterThanOrEqual(1))
    session.dispose()
  })

  it('does not schedule a retry when no credential file exists', async () => {
    vi.useFakeTimers()
    const store = mockStore({
      read: async () => {
        throw new Error('atomic-write: timed out waiting for the writer lock at X.lock')
      },
      exists: () => false,
    })
    const session = new XaiOAuthSession(store)
    await session.refreshLiveCatalog()
    await vi.runAllTimersAsync()
    expect(session.catalogSource).toBe('fallback')
    expect(session.catalogError).toMatch(/timed out waiting for the writer lock/)
    session.dispose()
  })

  it('gives up after exhausting the retry schedule', async () => {
    vi.useFakeTimers()
    let reads = 0
    const store = mockStore({
      read: async () => {
        reads += 1
        throw new Error('atomic-write: timed out waiting for the writer lock at X.lock')
      },
    })
    const session = new XaiOAuthSession(store, undefined, { catalogRetryDelaysMs: [10, 20] })
    await session.refreshLiveCatalog()
    await vi.runAllTimersAsync()
    expect(reads).toBe(3)
    expect(session.catalogError).toMatch(/timed out waiting for the writer lock/)
    session.dispose()
  })

  it('dispose cancels a pending background retry', async () => {
    vi.useFakeTimers()
    let reads = 0
    const store = mockStore({
      read: async () => {
        reads += 1
        throw new Error('atomic-write: timed out waiting for the writer lock at X.lock')
      },
    })
    const session = new XaiOAuthSession(store, undefined, { catalogRetryDelaysMs: [60_000] })
    await session.refreshLiveCatalog()
    session.dispose()
    await vi.runAllTimersAsync()
    expect(reads).toBe(1)
  })

  it('does not commit an in-flight listing after logout', async () => {
    await isolateDshHome()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', async (_url: string, init?: { signal?: AbortSignal }) => {
      await gate
      if (init?.signal?.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'grok-4.6' }] }),
        { status: 200 },
      )
    })
    const session = new XaiOAuthSession(
      mockStore({ read: async () => oauthCredential() }),
      undefined,
      { catalogRetryDelaysMs: [] },
    )
    const pending = session.refreshLiveCatalog()
    await session.logout()
    release()
    await pending
    expect(session.catalogSource).toBe('fallback')
    expect(session.liveModelIds()).toBeUndefined()
  })

  it('does not commit an in-flight listing after dispose', async () => {
    await isolateDshHome()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', async (_url: string, init?: { signal?: AbortSignal }) => {
      await gate
      if (init?.signal?.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      return new Response(
        JSON.stringify({ data: [{ id: 'grok-4.6' }] }),
        { status: 200 },
      )
    })
    const session = new XaiOAuthSession(
      mockStore({ read: async () => oauthCredential() }),
      undefined,
      { catalogRetryDelaysMs: [] },
    )
    const pending = session.refreshLiveCatalog()
    session.dispose()
    release()
    await pending
    expect(session.catalogSource).toBe('fallback')
    expect(session.liveModelIds()).toBeUndefined()
  })

  it('only the latest concurrent refresh may commit when completions finish out of order', async () => {
    await isolateDshHome()
    const gates: Array<() => void> = []
    let started = 0
    vi.stubGlobal('fetch', async (_url: string, init?: { signal?: AbortSignal }) => {
      const index = started
      started += 1
      await new Promise<void>(resolve => { gates[index] = resolve })
      if (init?.signal?.aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      const id = index === 0 ? 'grok-old' : 'grok-new'
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 })
    })
    const session = new XaiOAuthSession(
      mockStore({ read: async () => oauthCredential() }),
      undefined,
      { catalogRetryDelaysMs: [] },
    )
    const first = session.refreshLiveCatalog()
    await vi.waitFor(() => expect(gates[0]).toBeTypeOf('function'))
    const second = session.refreshLiveCatalog()
    await vi.waitFor(() => expect(gates[1]).toBeTypeOf('function'))
    gates[1]!()
    await second
    expect(session.liveModelIds()).toEqual(['grok-new'])
    expect(session.catalogSource).toBe('live')
    gates[0]!()
    await first
    expect(session.liveModelIds()).toEqual(['grok-new'])
    expect(session.catalogSource).toBe('live')
    session.dispose()
  })
})

describe('XaiOAuthSession.setSelectedModels', () => {
  it('treats an explicit empty list as "show all" and persists it across reloads', async () => {
    await isolateDshHome()
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ data: [{ id: 'grok-4.5' }, { id: 'grok-4.6' }, { id: 'grok-imagine-image' }] }),
      { status: 200 },
    ))
    const session = new XaiOAuthSession(
      mockStore({ read: async () => oauthCredential() }),
      undefined,
      { catalogRetryDelaysMs: [] },
    )
    // Seed liveIds so writeCache emits a non-empty document: parseCache drops
    // a document whose ids AND selected are both empty, which would make a
    // reload assertion vacuous.
    await session.refreshLiveCatalog()
    expect(session.liveModelIds()).toEqual(['grok-4.5', 'grok-4.6', 'grok-imagine-image'])

    // First pin one model, then clear the selection the way the Settings
    // "Show all" button does (POST selected: []).
    await session.setSelectedModels(['grok-4.5'])
    expect(session.selectedModelIds()).toEqual(['grok-4.5'])
    await session.setSelectedModels([])
    expect(session.selectedModelIds()).toBeUndefined()
    const visible = session.visibleModels().map(model => model.id)
    expect(visible).toContain('grok-4.6')
    expect(visible).toEqual(session.availableModels().map(model => model.id))

    // The cache document carries live ids but must omit the selected key —
    // assert the file itself so a selected: [] regression cannot pass.
    const cached = JSON.parse(
      await readFile(join(tempHome!, '.xai-oauth-models.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(cached['ids']).toContain('grok-4.6')
    expect(cached).not.toHaveProperty('selected')

    // A fresh session loading that cache stays in "show all".
    const reloaded = new XaiOAuthSession(
      mockStore({ read: async () => undefined }),
      undefined,
      { catalogRetryDelaysMs: [] },
    )
    await reloaded.loadCachedCatalog()
    expect(reloaded.selectedModelIds()).toBeUndefined()
  })

  it('falls back to the preferred model when a non-empty selection has no chat-model ids', async () => {
    const session = new XaiOAuthSession(
      mockStore({ read: async () => undefined }),
      undefined,
      { catalogRetryDelaysMs: [] },
    )
    await session.setSelectedModels(['grok-imagine-image', 'grok-build-0.1'])
    expect(session.selectedModelIds()).toEqual(['grok-4.6'])
  })

  it('keeps only chat-model ids when a non-empty selection is mixed', async () => {
    const session = new XaiOAuthSession(
      mockStore({ read: async () => undefined }),
      undefined,
      { catalogRetryDelaysMs: [] },
    )
    await session.setSelectedModels(['grok-imagine-image', 'grok-4.5', 'grok-build-0.1'])
    expect(session.selectedModelIds()).toEqual(['grok-4.5'])
  })
})
