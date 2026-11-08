import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface HostSet {
  dsh: string
  piAi: string
  schemastery: string
  cordis: string
}

interface DeclaredHostPackage {
  private: boolean
  dependencies: Record<string, string>
  overrides: Record<string, string>
}

interface HostContract {
  HOST_SETS: Record<string, HostSet>
  declaredHostPackageJson: (version: string) => DeclaredHostPackage
  resolveHostPiAiPackageJson: (dshDir: string) => string | undefined
  readPackageVersion: (packageJsonPath: string) => string
  hostPiAiError: (actual: string, expected: string) => string | undefined
}

const contractHref = new URL('../scripts/host-contract.mjs', import.meta.url).href
const contract = await import(contractHref) as HostContract

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

describe('declared DSH host fixture', () => {
  it('pins the tested Core 0.2.1-alpha.3 host to exact pi-ai 1.2.0', () => {
    const set = contract.HOST_SETS['0.2.1-alpha.3']
    expect(set).toEqual({
      dsh: '0.2.1-alpha.3',
      piAi: '1.2.0',
      schemastery: '3.18.5-alpha.2',
      cordis: '4.0.5-alpha.2',
    })
    const spec = contract.declaredHostPackageJson('0.2.1-alpha.3')
    expect(spec.dependencies['@deepseek-ai/dsh']).toBe('0.2.1-alpha.3')
    expect(spec.overrides['@earendil-works/pi-ai']).toBe('1.2.0')
    expect(spec.overrides['@earendil-works/pi-ai']).not.toMatch(/[\^~><=*x]/)
  })

  it('rejects a host whose resolved pi-ai is newer than the tested pin', () => {
    expect(contract.hostPiAiError('1.2.0', '1.2.0')).toBeUndefined()
    expect(contract.hostPiAiError('1.4.0', '1.2.0')).toBe('host pi-ai is 1.4.0, expected 1.2.0')
    expect(contract.hostPiAiError('1.5.0', '1.2.0')).toBe('host pi-ai is 1.5.0, expected 1.2.0')
  })

  it('resolves the pi-ai copy the host adapter loads, preferring a nested copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-grok-kit-host-contract-'))
    try {
      const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
      writeJson(join(dshDir, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.1-alpha.3' })
      writeJson(join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'package.json'), {
        name: '@deepseek-ai/dsh-llm-pi-ai',
        version: '0.2.1-alpha.3',
      })
      writeJson(join(root, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), { version: '1.2.0' })
      const hoisted = contract.resolveHostPiAiPackageJson(dshDir)
      expect(hoisted).toBeTruthy()
      expect(contract.readPackageVersion(hoisted!)).toBe('1.2.0')

      writeJson(join(root, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), {
        version: '1.5.0',
      })
      const nested = contract.resolveHostPiAiPackageJson(dshDir)
      expect(nested).toBeTruthy()
      expect(contract.readPackageVersion(nested!)).toBe('1.5.0')
      expect(contract.hostPiAiError(contract.readPackageVersion(nested!), '1.2.0')).toBe('host pi-ai is 1.5.0, expected 1.2.0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps CI and publish on the pinned smoke instead of a floating global host', () => {
    const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const publish = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')
    const smoke = readFileSync(new URL('../scripts/pack-install-smoke.mjs', import.meta.url), 'utf8')
    const probe = readFileSync(new URL('../scripts/verify-host-compat.mjs', import.meta.url), 'utf8')
    for (const source of [ci, publish]) {
      expect(source).toContain('node scripts/pack-install-smoke.mjs')
      expect(source).not.toContain('npm install -g @deepseek-ai/dsh')
    }
    expect(smoke).toContain('declaredHostPackageJson')
    expect(smoke).toContain('hostPiAiError')
    expect(smoke).not.toContain('npm install -g')
    expect(probe).toContain("from './host-contract.mjs'")
    expect(probe).toContain("overrides: { '@earendil-works/pi-ai': set.piAi }")
  })
})
