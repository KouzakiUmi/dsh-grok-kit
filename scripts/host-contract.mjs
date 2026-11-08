/**
 * Declared DSH host contract shared by the pack-install smoke and the
 * offline host-compat probe.
 *
 * Tested target: Core 0.2.1-alpha.3 with host-provided pi-ai 1.2.0.
 * The plugin peer range is >=1.2.0 so a newer host is not rejected at
 * install time; these fixtures stay on the version the suite actually tests.
 *
 * Published @deepseek-ai/dsh-llm-pi-ai@0.2.1-alpha.3 depends on
 * @earendil-works/pi-ai ^1.1.0. A plain install therefore floats to the
 * newest 1.x (1.4.0 when the smoke first failed, 1.5.0 later). The smoke
 * installs through declaredHostPackageJson so the override stays exact.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const HOST_SETS = {
  '0.2.1-alpha.3': {
    dsh: '0.2.1-alpha.3',
    piAi: '1.2.0',
    schemastery: '3.18.5-alpha.2',
    cordis: '4.0.5-alpha.2',
  },
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/

export function declaredHostPackageJson(version) {
  const set = HOST_SETS[version]
  if (set === undefined) throw new Error(`unknown host version "${version}"`)
  if (!EXACT_VERSION.test(set.piAi)) {
    throw new Error(`declared pi-ai pin must be an exact version, got ${set.piAi}`)
  }
  return {
    private: true,
    dependencies: { '@deepseek-ai/dsh': set.dsh },
    overrides: { '@earendil-works/pi-ai': set.piAi },
  }
}

/** Node's nearest node_modules walk, starting at startDir. */
export function resolveNearestPackageJson(startDir, packageName) {
  const parts = packageName.split('/')
  let dir = startDir
  const seen = new Set()
  while (!seen.has(dir)) {
    seen.add(dir)
    const candidate = join(dir, 'node_modules', ...parts, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Package the host adapter would load. A copy nested under dsh-llm-pi-ai
 * wins over a hoisted copy, matching Node resolution.
 */
export function resolveHostPiAiPackageJson(dshDir) {
  const adapter = resolveNearestPackageJson(dshDir, '@deepseek-ai/dsh-llm-pi-ai')
  const start = adapter === undefined ? dshDir : dirname(adapter)
  return resolveNearestPackageJson(start, '@earendil-works/pi-ai')
}

export function readPackageVersion(packageJsonPath) {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version
}

/** Undefined when the installed host matches the declared pin. */
export function hostPiAiError(actual, expected) {
  if (actual === expected) return undefined
  return `host pi-ai is ${actual}, expected ${expected}`
}
