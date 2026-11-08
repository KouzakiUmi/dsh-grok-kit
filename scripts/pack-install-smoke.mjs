#!/usr/bin/env node
/**
 * Isolated DSH pack-install smoke (DSH 0.2.1-alpha.3): install the declared
 * host with pi-ai pinned, npm pack, `dsh plugin add` into the `web` profile,
 * booted `--help`, and the plugin entry.
 * Isolates DSH_HOME / HOME / USERPROFILE and package-manager config/cache.
 * Does not read real user credentials.
 *
 * Does not use a preinstalled `dsh`. Published dsh-llm-pi-ai@0.2.1-alpha.3
 * depends on pi-ai ^1.1.0, so a global install of that DSH release floats
 * off the tested 1.2.0 pin. The install override is exact, and a mismatched
 * copy still fails the smoke.
 *
 * Usage: node scripts/pack-install-smoke.mjs [0.2.1-alpha.3]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_SETS, declaredHostPackageJson, hostPiAiError, resolveHostPiAiPackageJson } from './host-contract.mjs'

const requestedDsh = process.argv[2] ?? '0.2.1-alpha.3'
if (!Object.hasOwn(HOST_SETS, requestedDsh)) {
  console.error(`pack-install-smoke: unknown host version "${requestedDsh}" (known: ${Object.keys(HOST_SETS).join(', ')})`)
  process.exit(2)
}
const { dsh: EXPECTED_DSH, piAi: EXPECTED_PI_AI } = HOST_SETS[requestedDsh]
const PROFILE = 'web'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shell = process.platform === 'win32'

function run(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    shell,
    ...opts,
  })
}

const work = mkdtempSync(join(tmpdir(), 'dsh-grok-kit-smoke-'))
const home = join(work, 'home')
const dshHome = join(work, 'dsh-home')
const npmCache = join(work, 'npm-cache')
const pnpmHome = join(work, 'pnpm-home')
const appdata = join(work, 'appdata')
mkdirSync(home)
mkdirSync(dshHome)
mkdirSync(npmCache)
mkdirSync(pnpmHome)
mkdirSync(appdata)
const npmrc = join(work, 'npmrc')
writeFileSync(npmrc, `cache=${npmCache.replaceAll('\\', '/')}\n`)

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  HOME: home,
  USERPROFILE: home,
  APPDATA: appdata,
  LOCALAPPDATA: join(work, 'localappdata'),
  npm_config_userconfig: npmrc,
  npm_config_cache: npmCache,
  PNPM_HOME: pnpmHome,
  XDG_CACHE_HOME: join(work, 'xdg-cache'),
  XDG_CONFIG_HOME: join(work, 'xdg-config'),
}

let tarball
try {
  const hostPrefix = join(work, 'host')
  mkdirSync(hostPrefix)
  writeFileSync(join(hostPrefix, 'package.json'), `${JSON.stringify(declaredHostPackageJson(requestedDsh), null, 2)}\n`)
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ], { cwd: hostPrefix, env, stdio: 'inherit' })
  const binName = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const bin = join(hostPrefix, 'node_modules', '.bin', binName)
  if (!existsSync(bin)) throw new Error(`declared host install is missing ${bin}`)
  const dshDir = join(hostPrefix, 'node_modules', '@deepseek-ai', 'dsh')
  const versionOut = run(bin, ['--version'], { env, cwd: work })
  if (!versionOut.includes(EXPECTED_DSH)) {
    throw new Error(`dsh --version is not ${EXPECTED_DSH}: ${versionOut.trim()}`)
  }
  const dshPkg = JSON.parse(readFileSync(join(dshDir, 'package.json'), 'utf8'))
  if (dshPkg.version !== EXPECTED_DSH) {
    throw new Error(`@deepseek-ai/dsh package is ${dshPkg.version}, expected ${EXPECTED_DSH}`)
  }
  const piPkg = resolveHostPiAiPackageJson(dshDir)
  if (piPkg === undefined) throw new Error(`host pi-ai not found from ${dshDir}`)
  const piVersion = JSON.parse(readFileSync(piPkg, 'utf8')).version
  const piError = hostPiAiError(piVersion, EXPECTED_PI_AI)
  if (piError !== undefined) throw new Error(piError)
  console.log(`pack-install-smoke: declared host pi-ai ${piVersion} at ${piPkg}`)

  const packLines = run('npm', ['pack', '--ignore-scripts', '--silent'], { cwd: root, env }).trim().split(/\r?\n/)
  const packName = packLines.at(-1)
  if (!packName) throw new Error('npm pack produced no tarball name')
  tarball = resolve(root, packName)
  console.log(`pack-install-smoke: packed ${tarball}`)

  // pnpm 11 hard-fails installs when dependency build scripts are neither allowed nor
  // explicitly denied (ERR_PNPM_IGNORED_BUILDS). pi-ai 1.2.0 pins @google/genai and pulls
  // protobufjs, both shipping build scripts. Declare them denied at the profile root where
  // `dsh plugin add` runs pnpm so the smoke measures pack/install/boot rather than builds.
  const profileDir = join(dshHome, 'profiles', PROFILE)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), "allowBuilds:\n  '@google/genai': false\n  protobufjs: false\n")

  run(bin, ['plugin', '--profile', PROFILE, 'add', tarball], { env, cwd: work, stdio: 'inherit' })

  const dump = run(bin, ['--profile', PROFILE, '--dump-config'], { env, cwd: work })
  if (!dump.includes('dsh-grok-kit')) throw new Error('dump-config does not mention dsh-grok-kit')
  if (!/backendSearch:\s*false/.test(dump) && !/"backendSearch":\s*false/.test(dump)) {
    throw new Error(`dump-config does not show backendSearch: false\n${dump.slice(0, 2000)}`)
  }

  const help = run(bin, ['--profile', PROFILE, '--help'], {
    env,
    cwd: work,
    timeout: 30_000,
  })
  if (!help.includes('Usage: dsh --profile web') && !help.includes('Serve the DeepSeek Harness browser UI.')) {
    throw new Error(`booted web profile help did not contain a stable web marker\n${help.slice(0, 2000)}`)
  }

  const pluginDir = join(dshHome, 'profiles', PROFILE, 'node_modules', 'dsh-grok-kit')
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  if (manifest.version !== '0.2.9') {
    throw new Error(`installed plugin version is ${manifest.version}, expected 0.2.9`)
  }
  if (!existsSync(join(pluginDir, 'lib', 'index.js'))) {
    throw new Error('installed plugin is missing lib/index.js')
  }
  console.log(`pack-install-smoke: OK — DSH ${EXPECTED_DSH} / pi-ai ${EXPECTED_PI_AI} / booted web profile loaded dsh-grok-kit@0.2.9`)
} finally {
  if (tarball !== undefined) rmSync(tarball, { force: true })
  rmSync(work, { recursive: true, force: true })
}
