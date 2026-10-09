#!/usr/bin/env node
/**
 * Offline host-compat probe: pack the plugin, install it into a scratch
 * project next to a *published* @deepseek-ai host set, then drive the
 * `resolveModel` and `prepareCall` paths that issue #1 crashed on
 * (`PiAiAdapter.modelOf` bare-reads `profile.modelErrors` in
 * dsh-llm-pi-ai 0.1.5-rc.2).
 *
 * Needs no xAI credentials, no login state, and no active subscription:
 * model resolution reads static pi-ai registry data plus the plugin-built
 * profile, so a logged-out stub session is enough. Network is used only by
 * the scratch `npm install` itself.
 *
 * Usage: node scripts/verify-host-compat.mjs [0.2.0-rc.2]
 * Requires `npm run build` (or a committed lib/) first.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_SETS = {
  '0.2.0-rc.2': { dsh: '0.2.0-rc.2', piAi: '0.87.1', schemastery: '3.18.4', cordis: '4.0.4' },
}
// Components absent from a given host line (renamed/absorbed upstream) are
// excluded from that leg's frozen fixture; everything else stays pinned.
const FIXTURE_EXCLUSIONS = {
  '0.2.0-rc.2': ['dsh-code-runtime'],
}
// Test-fixture freeze: every @deepseek-ai host component the probe tree can
// pull (explicit installs plus the required peers npm auto-installs) is
// pinned to the exact same rc as its leg, so a later rc in the registry
// (e.g. dsh-authorization@0.1.5-rc.3 peering dsh-llm ^0.1.5-rc.3) cannot
// drift the fixture into an ERESOLVE. This freezes the probe only;
// production peer ranges in package.json stay untouched.
const DSH_FIXTURE_COMPONENTS = [
  'dsh-agent',
  'dsh-attachment',
  'dsh-atomic-write',
  'dsh-authorization',
  'dsh-brand',
  'dsh-code-runtime',
  'dsh-credentials',
  'dsh-fs',
  'dsh-home-paths',
  'dsh-invariants',
  'dsh-launch-environment',
  'dsh-llm',
  'dsh-llm-pi-ai',
  'dsh-sandbox',
  'dsh-scope',
  'dsh-session',
  'dsh-session-projection',
  'dsh-settings',
  'dsh-system-prompt',
  'dsh-timeout',
  'dsh-tools',
  'dsh-typert-protocol',
  'dsh-user-approval',
  'dsh-util-crypto',
  'dsh-util-values',
]
const PROBE_MODEL = 'grok-4.6'
const PROBE_ROUTE = 'xai-oauth'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shell = process.platform === 'win32'

function run(file, args, opts = {}) {
  return execFileSync(file, args, { encoding: 'utf8', shell, ...opts })
}

const requested = process.argv[2] ?? '0.2.0-rc.2'
const set = HOST_SETS[requested]
if (set === undefined) {
  console.error(`verify-host-compat: unknown host set "${requested}" (known: ${Object.keys(HOST_SETS).join(', ')})`)
  process.exit(2)
}
const fixtureComponents = DSH_FIXTURE_COMPONENTS.filter(name => !(FIXTURE_EXCLUSIONS[requested] ?? []).includes(name))
if (!existsSync(join(root, 'lib', 'index.js'))) {
  console.error('verify-host-compat: lib/index.js is missing — run `npm run build` first')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'dsh-grok-kit-host-compat-'))
const home = join(work, 'home')
const dshHome = join(work, 'dsh-home')
const npmCache = join(work, 'npm-cache')
const probeDir = join(work, 'probe')
mkdirSync(home)
mkdirSync(dshHome)
mkdirSync(npmCache)
mkdirSync(probeDir)

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  HOME: home,
  USERPROFILE: home,
  npm_config_cache: npmCache,
}

// The stub session is structurally valid but signed out; model resolution
// must not depend on credentials (that is exactly what makes this probe
// subscription-free). Mirror XaiOAuthSession.provider(): route id and
// per-model provider stamps must match the harness route.
const probeSource = `
import { createXaiOAuthAdapter } from 'dsh-grok-kit'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'

const store = {
  async find() { return undefined },
  async get() { return undefined },
  async list() { return [] },
}
const baseline = xaiProvider()
const session = {
  provider: () => ({
    ...baseline,
    id: '${PROBE_ROUTE}',
    name: 'xAI Grok',
    getModels: () => baseline.getModels().map(model => ({ ...model, provider: '${PROBE_ROUTE}' })),
  }),
  store,
}
const adapter = createXaiOAuthAdapter(session, () => undefined)
const info = await adapter.resolveModel('${PROBE_ROUTE}', '${PROBE_MODEL}')
if (!info || typeof info !== 'object') throw new Error('resolveModel returned no model info')
if (typeof adapter.prepareCall !== 'function') throw new Error('adapter.prepareCall is not a function (mixed host/plugin version graph)')
const prepared = await adapter.prepareCall('${PROBE_ROUTE}', '${PROBE_MODEL}')
if (!prepared || typeof prepared !== 'object' || !prepared.model) throw new Error('prepareCall returned no prepared call info')
if (prepared.model.provider !== '${PROBE_ROUTE}' || prepared.model.id !== '${PROBE_MODEL}') {
  throw new Error('prepareCall resolved ' + prepared.model.provider + '/' + prepared.model.id + ', expected ${PROBE_ROUTE}/${PROBE_MODEL}')
}
if (typeof prepared.stream !== 'function') throw new Error('prepareCall stream is not a function (stream never invoked here)')
console.log('resolveModel OK: ${PROBE_ROUTE}/${PROBE_MODEL}')
console.log('prepareCall OK: ${PROBE_ROUTE}/${PROBE_MODEL} (stream seam present, never invoked)')
`

let tarball
try {
  const packLines = run('npm', ['pack', '--ignore-scripts', '--silent'], { cwd: root, env }).trim().split(/\r?\n/)
  const packName = packLines.at(-1)
  if (!packName) throw new Error('npm pack produced no tarball name')
  tarball = resolve(root, packName)
  console.log(`verify-host-compat[${requested}]: packed ${tarball}`)

  writeFileSync(join(probeDir, 'package.json'), JSON.stringify({
    name: 'dsh-grok-kit-host-compat-probe',
    private: true,
    version: '0.0.0',
  }, null, 2))
  writeFileSync(join(probeDir, 'probe.mjs'), probeSource)

  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    tarball,
    ...fixtureComponents.map(name => `@deepseek-ai/${name}@${set.dsh}`),
    `@deepseek-ai/schemastery@${set.schemastery}`,
    `@deepseek-ai/cordis@${set.cordis}`,
    `@earendil-works/pi-ai@${set.piAi}`,
  ], { cwd: probeDir, env, stdio: 'inherit' })

  for (const name of fixtureComponents) {
    const installed = JSON.parse(readFileSync(join(probeDir, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8')).version
    if (installed !== set.dsh) {
      throw new Error(`probe resolved @deepseek-ai/${name} ${installed}, expected frozen fixture version ${set.dsh}`)
    }
  }
  const installedPiAi = JSON.parse(readFileSync(join(probeDir, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), 'utf8')).version
  if (installedPiAi !== set.piAi) {
    throw new Error(`probe resolved pi-ai ${installedPiAi}, expected ${set.piAi}`)
  }

  run('node', ['probe.mjs'], { cwd: probeDir, env, stdio: 'inherit' })
  console.log(`verify-host-compat[${requested}]: OK — resolveModel path clean on dsh-llm-pi-ai ${set.dsh} / pi-ai ${set.piAi}`)
} finally {
  if (tarball !== undefined) rmSync(tarball, { force: true })
  rmSync(work, { recursive: true, force: true })
}
