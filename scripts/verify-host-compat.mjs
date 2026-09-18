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
 * Usage: node scripts/verify-host-compat.mjs [0.1.5-rc.2|0.1.2-rc.1]
 * Requires `npm run build` (or a committed lib/) first.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_SETS = {
  '0.1.5-rc.2': { dsh: '0.1.5-rc.2', piAi: '0.85.1' },
  '0.1.2-rc.1': { dsh: '0.1.2-rc.1', piAi: '0.84.4' },
}
const PROBE_MODEL = 'grok-4.6'
const PROBE_ROUTE = 'xai-oauth'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shell = process.platform === 'win32'

function run(file, args, opts = {}) {
  return execFileSync(file, args, { encoding: 'utf8', shell, ...opts })
}

const requested = process.argv[2] ?? '0.1.5-rc.2'
const set = HOST_SETS[requested]
if (set === undefined) {
  console.error(`verify-host-compat: unknown host set "${requested}" (known: ${Object.keys(HOST_SETS).join(', ')})`)
  process.exit(2)
}
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
    `@deepseek-ai/dsh-llm@${set.dsh}`,
    `@deepseek-ai/dsh-llm-pi-ai@${set.dsh}`,
    `@deepseek-ai/dsh-tools@${set.dsh}`,
    `@deepseek-ai/dsh-home-paths@${set.dsh}`,
    `@deepseek-ai/dsh-atomic-write@${set.dsh}`,
    '@deepseek-ai/schemastery@3.18.2',
    '@deepseek-ai/cordis@4.0.2',
    `@earendil-works/pi-ai@${set.piAi}`,
  ], { cwd: probeDir, env, stdio: 'inherit' })

  const installedDsh = JSON.parse(readFileSync(join(probeDir, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'package.json'), 'utf8')).version
  const installedPiAi = JSON.parse(readFileSync(join(probeDir, 'node_modules', '@earendil-works', 'pi-ai', 'package.json'), 'utf8')).version
  if (installedDsh !== set.dsh || installedPiAi !== set.piAi) {
    throw new Error(`probe resolved dsh-llm-pi-ai ${installedDsh} / pi-ai ${installedPiAi}, expected ${set.dsh} / ${set.piAi}`)
  }

  run('node', ['probe.mjs'], { cwd: probeDir, env, stdio: 'inherit' })
  console.log(`verify-host-compat[${requested}]: OK — resolveModel path clean on dsh-llm-pi-ai ${set.dsh} / pi-ai ${set.piAi}`)
} finally {
  if (tarball !== undefined) rmSync(tarball, { force: true })
  rmSync(work, { recursive: true, force: true })
}
