import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { XAI_OAUTH_ROUTE, XAI_PI_PROVIDER } from '../src/ids.ts'
import { lockPathForAuthFile, resolveXaiOAuthStorePath, XaiOAuthCredentialStore } from '../src/store.ts'

const files: string[] = []

afterEach(async () => {
  files.length = 0
})

/** A pid that is definitely gone: spawn a short-lived child and wait for exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve())
    child.once('error', reject)
  })
  return child.pid!
}

const CREDENTIAL = {
  type: 'oauth' as const,
  access: 'access-token',
  refresh: 'refresh-token',
  expires: 1_700_000_000_000,
}

async function tempStore(): Promise<XaiOAuthCredentialStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-'))
  const filename = join(dir, 'auth.json')
  files.push(filename)
  return new XaiOAuthCredentialStore(filename)
}

describe('XaiOAuthCredentialStore', () => {
  it('round-trips an oauth credential', async () => {
    const store = await tempStore()
    const written = await store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 1_700_000_000_000,
    }))
    expect(written).toMatchObject({ type: 'oauth', access: 'access-token', refresh: 'refresh-token' })
    const read = await store.read(XAI_PI_PROVIDER)
    expect(read).toEqual(written)
    expect(await store.list()).toEqual([{ providerId: XAI_PI_PROVIDER, type: 'oauth' }])
    const text = await readFile(store.filename, 'utf8')
    expect(text).not.toContain('XAI_API_KEY')
    expect(JSON.parse(text).version).toBe(1)
  })

  it('ignores other provider ids on read and refuses them on write', async () => {
    const store = await tempStore()
    await store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
    }))
    expect(await store.read('openai-codex')).toBeUndefined()
    await expect(store.modify('openai-codex', async current => current)).rejects.toThrow(/does not own/)
  })

  it('reads and writes the same credential for the route id alias too', async () => {
    const store = await tempStore()
    await store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'aaa',
      refresh: 'rrr',
      expires: 1,
    }))
    // The pi-ai collection resolves auth under the harness route id.
    expect(await store.read(XAI_OAUTH_ROUTE)).toMatchObject({ type: 'oauth', access: 'aaa' })
    const rotated = await store.modify(XAI_OAUTH_ROUTE, async current => ({
      ...current!,
      access: 'bbb',
      refresh: 'rrr2',
      expires: 999,
    }))
    expect(rotated).toMatchObject({ type: 'oauth', access: 'bbb', refresh: 'rrr2' })
    expect(await store.read(XAI_PI_PROVIDER)).toMatchObject({ access: 'bbb' })
    await store.delete(XAI_OAUTH_ROUTE)
    expect(await store.read(XAI_PI_PROVIDER)).toBeUndefined()
  })

  it('rejects an unsupported document version', async () => {
    const store = await tempStore()
    await writeFile(store.filename, `${JSON.stringify({
      version: 99,
      credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    })}\n`, { mode: 0o600 })
    await expect(store.read(XAI_PI_PROVIDER)).rejects.toThrow(/unsupported auth format version/)
  })

  it('rejects unknown credential fields', async () => {
    const store = await tempStore()
    await writeFile(store.filename, `${JSON.stringify({
      version: 1,
      credential: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, leak: 'nope' },
    })}\n`, { mode: 0o600 })
    await expect(store.read(XAI_PI_PROVIDER)).rejects.toThrow(/unknown field/)
  })

  it('deletes only the xAI credential', async () => {
    const store = await tempStore()
    await store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
    }))
    await store.delete(XAI_PI_PROVIDER)
    expect(await store.read(XAI_PI_PROVIDER)).toBeUndefined()
    expect(await store.list()).toEqual([])
  })

  it('takes over a leftover lock whose recorded owner is gone (official atomic-write protocol)', async () => {
    const store = await tempStore()
    const lockPath = `${store.lockFilename}.lock`
    const dead = await deadPid()
    await writeFile(lockPath, `${dead}\n`, { mode: 0o600 })
    try {
      const written = await store.modify(XAI_PI_PROVIDER, async () => CREDENTIAL)
      expect(written).toMatchObject({ type: 'oauth', access: 'access-token' })
      expect(await store.read(XAI_PI_PROVIDER)).toMatchObject({ access: 'access-token' })
      expect(await readFile(lockPath, 'utf8').catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(lockPath, { force: true })
    }
  }, 10_000)

  it('times out on a malformed or foreign lock and preserves its content (fail-closed)', async () => {
    const store = await tempStore()
    const lockPath = `${store.lockFilename}.lock`
    const malformed = 'corrupt-not-a-pid\n'
    await writeFile(lockPath, malformed, { mode: 0o600 })
    try {
      await expect(store.modify(XAI_PI_PROVIDER, async () => CREDENTIAL))
        .rejects.toThrow(/timed out waiting for the writer lock/)
      expect(await readFile(lockPath, 'utf8')).toBe(malformed)
    } finally {
      await rm(lockPath, { force: true })
    }
  }, 10_000)

  it('does not treat an empty lock as an orphan even if it is old', async () => {
    const store = await tempStore()
    const lockPath = `${store.lockFilename}.lock`
    await writeFile(lockPath, '', { mode: 0o600 })
    try {
      await expect(store.modify(XAI_PI_PROVIDER, async () => CREDENTIAL))
        .rejects.toThrow(/timed out waiting for the writer lock/)
      expect(await readFile(lockPath, 'utf8')).toBe('')
    } finally {
      await rm(lockPath, { force: true })
    }
  }, 10_000)

  it('still times out on a writer lock whose owner is alive', async () => {
    const store = await tempStore()
    const lockPath = `${store.lockFilename}.lock`
    await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600 })
    try {
      await expect(store.modify(XAI_PI_PROVIDER, async () => CREDENTIAL))
        .rejects.toThrow(/timed out waiting for the writer lock/)
    } finally {
      await rm(lockPath, { force: true })
    }
  }, 10_000)

  it('serializes concurrent child processes contending for a leftover dead-PID lock without overlap or lost updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-concurrency-'))
    const filename = join(dir, 'auth.json')
    const store = new XaiOAuthCredentialStore(filename)
    const initial = {
      type: 'oauth' as const,
      access: 'initial-access',
      refresh: 'initial-refresh',
      expires: 1_000,
    }
    await store.modify(XAI_PI_PROVIDER, async () => initial)

    const dead = await deadPid()
    const lockPath = `${store.lockFilename}.lock`
    await writeFile(lockPath, `${dead}\n`, { mode: 0o600 })

    const markerFile = join(dir, 'active.marker')
    const startGateFile = join(dir, 'start.gate')
    const workerScript = join(dir, 'worker.mjs')
    const storeTsUrl = new URL('../src/store.ts', import.meta.url).href

    const workerCode = [
      "import { writeFile, rm } from 'node:fs/promises';",
      "import { existsSync } from 'node:fs';",
      "import { XaiOAuthCredentialStore } from " + JSON.stringify(storeTsUrl) + ";",
      "",
      "const [authFile, marker, readyFile, startGate] = process.argv.slice(2);",
      "const store = new XaiOAuthCredentialStore(authFile);",
      "",
      "// Signal ready to parent",
      "await writeFile(readyFile, String(process.pid) + '\\n');",
      "",
      "// Wait for parent start gate",
      "const deadline = Date.now() + 10000;",
      "while (!existsSync(startGate)) {",
      "  if (Date.now() > deadline) throw new Error('Start gate timed out');",
      "  await new Promise(r => setTimeout(r, 20));",
      "}",
      "",
      "// Contend for store.modify under the lock",
      "await store.modify('xai', async (current) => {",
      "  if (!current) throw new Error('current credential missing');",
      "  // Exclusive-create marker file to verify no overlap in critical section",
      "  await writeFile(marker, String(process.pid) + '\\n', { flag: 'wx' });",
      "  try {",
      "    await new Promise(r => setTimeout(r, 80));",
      "    return {",
      "      ...current,",
      "      access: 'token-' + process.pid,",
      "      expires: (current.expires ?? 1000) + 1,",
      "    };",
      "  } finally {",
      "    await rm(marker, { force: true });",
      "  }",
      "});",
    ].join('\n') + '\n';
    await writeFile(workerScript, workerCode, 'utf8')

    const children: import('node:child_process').ChildProcess[] = []
    const spawnWorker = (readyFile: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', workerScript, filename, markerFile, readyFile, startGateFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        timeout: 12_000,
      })
      children.push(child)
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      let settled = false
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        if (code === 0) resolve()
        else reject(new Error(`Worker exited with code ${code} signal ${signal}: ${stderr}`))
      })
    })

    const ready1 = join(dir, 'ready-1.marker')
    const ready2 = join(dir, 'ready-2.marker')
    // Attach handlers immediately, including while waiting for the ready barrier.
    const resultsPromise = Promise.allSettled([spawnWorker(ready1), spawnWorker(ready2)])

    try {
      // Wait until both workers have booted and signaled readiness
      const readyDeadline = Date.now() + 8000
      while (!existsSync(ready1) || !existsSync(ready2)) {
        if (Date.now() > readyDeadline) throw new Error('Worker ready synchronization timed out')
        await new Promise(r => setTimeout(r, 20))
      }

      // Release start gate to trigger simultaneous contention
      await writeFile(startGateFile, 'start\n', 'utf8')

      const results = await resultsPromise
      for (const res of results) {
        if (res.status === 'rejected') throw res.reason
      }

      const finalCred = await store.read(XAI_PI_PROVIDER)
      expect(finalCred).toMatchObject({
        type: 'oauth',
        expires: 1_002,
      })
      expect(await readFile(markerFile, 'utf8').catch(() => undefined)).toBeUndefined()
      expect(await readFile(lockPath, 'utf8').catch(() => undefined)).toBeUndefined()
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill() } catch { /* ignore */ }
        }
      }
      // Never remove the fixture while a child can still read or write it.
      await resultsPromise
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('reads and writes a Grok CLI auth.json without dropping extra slot fields', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-grok-store-'))
    const grokDir = join(dir, '.grok')
    await mkdir(grokDir, { recursive: true })
    const filename = join(grokDir, 'auth.json')
    await writeFile(filename, `${JSON.stringify({
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: 'old-access',
        refresh_token: 'old-refresh',
        expires_at: '2026-08-14T12:00:00.000Z',
        oidc_issuer: 'https://auth.x.ai',
        email: 'keep@example.com',
        first_name: 'Ada',
      },
    }, null, 2)}\n`, { mode: 0o600 })
    const store = new XaiOAuthCredentialStore(filename)
    expect(store.sharedWithGrokCli).toBe(true)
    expect(await store.read(XAI_PI_PROVIDER)).toMatchObject({ type: 'oauth', access: 'old-access' })
    await store.modify(XAI_PI_PROVIDER, async current => ({
      type: 'oauth',
      access: 'new-access',
      refresh: 'new-refresh',
      expires: Date.parse('2026-08-23T18:00:00.000Z'),
      accountId: current && 'accountId' in current ? current.accountId : undefined,
    }))
    const slot = (JSON.parse(await readFile(filename, 'utf8')) as Record<string, Record<string, unknown>>)[
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'
    ]
    expect(slot).toMatchObject({
      key: 'new-access',
      refresh_token: 'new-refresh',
      email: 'keep@example.com',
      first_name: 'Ada',
    })
  })

  it('prefers ~/.grok/auth.json over a leftover dsh credential file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-xai-homes-'))
    const userHome = join(home, 'user')
    const dshHome = join(home, 'dsh')
    await mkdir(join(userHome, '.grok'), { recursive: true })
    await mkdir(dshHome, { recursive: true })
    await writeFile(join(userHome, '.grok', 'auth.json'), '{}\n', { mode: 0o600 })
    await writeFile(join(dshHome, '.xai-oauth-auth.json'), '{}\n', { mode: 0o600 })
    expect(resolveXaiOAuthStorePath({ userHome, dshHome }).replaceAll('\\', '/'))
      .toMatch(/\/user\/.grok\/auth\.json$/)
  })

  it('stays signed out after deleting xAI from a shared file with one foreign slot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-logout-'))
    const filename = join(dir, '.grok', 'auth.json')
    await mkdir(join(dir, '.grok'), { recursive: true })
    const foreign = { key: 'foreign-access', refresh_token: 'foreign-refresh', oidc_issuer: 'https://other.example' }
    await writeFile(filename, JSON.stringify({ 'https://other.example::client': foreign }), { mode: 0o600 })
    const store = new XaiOAuthCredentialStore(filename)
    await store.modify(XAI_PI_PROVIDER, async () => CREDENTIAL)
    expect(await store.read(XAI_PI_PROVIDER)).toMatchObject({ access: CREDENTIAL.access })
    await store.delete(XAI_PI_PROVIDER)
    expect(await store.read(XAI_PI_PROVIDER)).toBeUndefined()
    expect(await store.list()).toEqual([])
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ 'https://other.example::client': foreign })
  })

  it('migrates a legacy DSH envelope in the Grok file without retaining stale tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-migrate-'))
    const filename = join(dir, '.grok', 'auth.json')
    await mkdir(join(dir, '.grok'), { recursive: true })
    await writeFile(filename, JSON.stringify({ version: 1, credential: CREDENTIAL }), { mode: 0o600 })
    const store = new XaiOAuthCredentialStore(filename)
    await store.modify(XAI_PI_PROVIDER, async () => ({ ...CREDENTIAL, access: 'rotated', refresh: 'rotated-refresh' }))
    const document = JSON.parse(await readFile(filename, 'utf8'))
    expect(document).not.toHaveProperty('credential')
    expect(document).not.toHaveProperty('version')
    expect(await store.read(XAI_PI_PROVIDER)).toMatchObject({ access: 'rotated', refresh: 'rotated-refresh' })
    await store.delete(XAI_PI_PROVIDER)
    expect(await store.read(XAI_PI_PROVIDER)).toBeUndefined()
  })

  it('keeps the writer lock out of ~/.grok when sharing the Grok CLI file', () => {
    const grok = lockPathForAuthFile(join('/home', 'u', '.grok', 'auth.json')).replaceAll('\\', '/')
    expect(grok).toMatch(/\/.dsh\/.xai-oauth-auth\.json$/)
    expect(grok).not.toContain('/.grok/')
    const store = new XaiOAuthCredentialStore(join(tmpdir(), 'dsh-xai-lockpath', '.grok', 'auth.json'))
    expect(store.lockFilename.replaceAll('\\', '/')).toMatch(/\/dsh-xai-lockpath\/.dsh\/.xai-oauth-auth\.json$/)
  })

  it.runIf(process.platform !== 'win32')('rejects a credential file readable beyond the owner (Linux)', async () => {
    const store = await tempStore()
    await store.modify(XAI_PI_PROVIDER, async () => ({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 1,
    }))
    await chmod(store.filename, 0o644)
    await expect(store.read(XAI_PI_PROVIDER)).rejects.toThrow(/readable beyond its owner/)
    await chmod(store.filename, 0o600)
    await expect(store.read(XAI_PI_PROVIDER)).resolves.toMatchObject({ type: 'oauth', access: 'a' })
  })
})
