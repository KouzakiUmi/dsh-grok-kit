import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createXaiOAuthAdapter } from '../src/adapter.ts'
import { XaiOAuthSession } from '../src/session.ts'
import { XAI_OAUTH_ROUTE } from '../src/ids.ts'
import * as invariant from '../src/invariant.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('desktop host dependency contract', () => {
  it('uses host-provided pi-ai 1.2.0 without installing a plugin-owned copy', () => {
    expect(manifest.dependencies).not.toHaveProperty('@earendil-works/pi-ai')
    expect(manifest.peerDependencies['@earendil-works/pi-ai']).toBe('1.2.0')
    expect(manifest.peerDependenciesMeta['@earendil-works/pi-ai']).toEqual({ optional: true })
    expect(manifest.devDependencies['@earendil-works/pi-ai']).toBe('1.2.0')
    expect(manifest.devDependencies['@deepseek-ai/dsh-llm-pi-ai']).toBe('0.2.1-alpha.3')
  })

  it('keeps the legacy invariant entry inert without the removed service', async () => {
    expect(manifest.peerDependencies).not.toHaveProperty('@deepseek-ai/dsh-invariants')
    expect(invariant).not.toHaveProperty('inject')
    const dispose = await invariant.apply()
    expect(dispose).toBeTypeOf('function')
    expect(dispose()).toBeUndefined()
  })

  it('resolves and prepares the OAuth route on the actual host adapter without credentials', async () => {
    const session = new XaiOAuthSession()
    try {
      const adapter = createXaiOAuthAdapter(session, () => undefined)
      const model = await adapter.resolveModel(XAI_OAUTH_ROUTE, 'grok-4.6')
      expect(model.provider).toBe(XAI_OAUTH_ROUTE)
      expect(model.id).toBe('grok-4.6')
      const prepared = await adapter.prepareCall(XAI_OAUTH_ROUTE, 'grok-4.6')
      expect(prepared.model.provider).toBe(XAI_OAUTH_ROUTE)
      expect(prepared.model.id).toBe('grok-4.6')
      expect(prepared.stream).toBeTypeOf('function')
    } finally {
      session.dispose()
    }
  })
})
