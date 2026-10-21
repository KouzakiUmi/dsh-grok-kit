import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetch as undiciFetch } from 'undici'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreEnv } from './restore-env.ts'
import { GROK_GRPC_CREDITS_URL } from '../src/grok-credits.ts'

vi.mock('undici', async importOriginal => {
  const actual = await importOriginal<typeof import('undici')>()
  return {
    ...actual,
    fetch: vi.fn(async () => new Response('proxied')),
  }
})
import {
  applyXaiProxy,
  installXaiFetchHook,
  isXaiProxyTarget,
  readStoredProxyUrl,
  readXaiProxySettings,
  resolveXaiProxyUrl,
  setQuotaCompatibilityMode,
  setXaiProxyUrl,
  validProxyUrl,
  writeStoredProxyUrl,
  writeStoredProxySettings,
  xaiProxyPath,
} from '../src/proxy.ts'

const originalHome = process.env.DSH_HOME
const originalEnv = process.env.DSH_XAI_PROXY
let dir: string | undefined

afterEach(async () => {
  restoreEnv('DSH_HOME', originalHome)
  restoreEnv('DSH_XAI_PROXY', originalEnv)
  setXaiProxyUrl('')
  setQuotaCompatibilityMode(false)
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function tempHome(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'dsh-grok-kit-proxy-'))
  process.env.DSH_HOME = dir
  return dir
}

describe('proxy settings', () => {
  it('reads old proxy documents with compatibility off and never enables a truthy non-boolean flag', async () => {
    const home = await tempHome()
    for (const flag of [undefined, 'true', 1, null]) {
      await writeFile(xaiProxyPath(home), JSON.stringify({ version: 1, proxyUrl: 'http://127.0.0.1:9', quotaCompatibilityMode: flag }))
      expect(readXaiProxySettings()).toEqual({ proxyUrl: 'http://127.0.0.1:9', quotaCompatibilityMode: false })
    }
  })

  it('keeps the mode in storage when a legacy URL-only writer updates the proxy', async () => {
    await tempHome()
    await writeStoredProxySettings({ proxyUrl: 'http://127.0.0.1:9', quotaCompatibilityMode: true })
    await writeStoredProxyUrl('http://127.0.0.1:10')
    expect(readXaiProxySettings()).toEqual({ proxyUrl: 'http://127.0.0.1:10', quotaCompatibilityMode: true })
  })
  it('includes the exact billing host without routing unrelated Grok or lookalike hosts', () => {
    for (const url of [
      'https://api.x.ai/v1/models',
      'https://auth.x.ai',
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
      GROK_GRPC_CREDITS_URL,
    ]) {
      expect(isXaiProxyTarget(url)).toBe(true)
      expect(isXaiProxyTarget(new URL(url))).toBe(true)
      expect(isXaiProxyTarget({ url })).toBe(true)
    }
    for (const url of [
      'https://grok.com',
      'https://grok.com/',
      'https://other.grok.com',
      'https://www.grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig',
      'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig/extra',
      'https://grok.com.evil.example/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig',
      'https://cli-chat-proxy.grok.com.evil.example',
      'https://evilcli-chat-proxy.grok.com',
      'not a url',
    ]) {
      expect(isXaiProxyTarget(url)).toBe(false)
    }
  })

  it('routes only the credits fallback through the configured proxy', async () => {
    const direct = vi.fn(async () => new Response('direct'))
    const previous = globalThis.fetch
    globalThis.fetch = direct as typeof fetch
    const dispose = installXaiFetchHook()
    try {
      expect(setXaiProxyUrl('http://127.0.0.1:9')).toBe(true)
      vi.mocked(undiciFetch).mockClear()
      const proxied = await globalThis.fetch(GROK_GRPC_CREDITS_URL)
      expect(await proxied.text()).toBe('proxied')
      expect(direct).not.toHaveBeenCalled()
      expect(undiciFetch).toHaveBeenCalledOnce()
      const init = vi.mocked(undiciFetch).mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined
      expect(init?.dispatcher).toBeTruthy()
      const other = await globalThis.fetch('https://grok.com/')
      expect(await other.text()).toBe('direct')
      expect(undiciFetch).toHaveBeenCalledOnce()
      setXaiProxyUrl('')
      direct.mockClear()
      const cleared = await globalThis.fetch(GROK_GRPC_CREDITS_URL)
      expect(await cleared.text()).toBe('direct')
      expect(undiciFetch).toHaveBeenCalledOnce()
    } finally {
      dispose()
      setXaiProxyUrl('')
      globalThis.fetch = previous
    }
  })

  it('resolves precedence: stored setting > config > DSH_XAI_PROXY env', async () => {
    const home = await tempHome()
    process.env.DSH_XAI_PROXY = 'http://env.example:7897'
    expect(resolveXaiProxyUrl('http://config.example:7897')).toBe('http://config.example:7897')

    await writeStoredProxyUrl('http://stored.example:7897')
    expect(resolveXaiProxyUrl('http://config.example:7897')).toBe('http://stored.example:7897')

    // Explicitly disabling the proxy must survive a restart, overriding config/env.
    await writeStoredProxyUrl('')
    expect(resolveXaiProxyUrl('http://config.example:7897')).toBe('')

    expect(resolveXaiProxyUrl('')).toBe('')
    await rm(xaiProxyPath(home))
    // With no saved override, an empty config follows the environment.
    expect(resolveXaiProxyUrl('')).toBe('http://env.example:7897')

    // Everything cleared: direct.
    process.env.DSH_XAI_PROXY = ''
    expect(resolveXaiProxyUrl('')).toBe('')
    expect(readStoredProxyUrl()).toBe('')
    await writeStoredProxyUrl('')
    expect(await readFile(xaiProxyPath(home), 'utf8')).toContain('"version": 1')
  })

  it('treats an unsupported stored version as unset', async () => {
    const home = await tempHome()
    await writeFile(xaiProxyPath(home), `${JSON.stringify({ version: 99, proxyUrl: 'http://evil.example:9' })}\n`)
    expect(readStoredProxyUrl()).toBe('')
    expect(resolveXaiProxyUrl('')).toBe('')
  })

  it('trims whitespace around the stored URL', async () => {
    await tempHome()
    await writeStoredProxyUrl('  http://a.example:7897  ')
    expect(resolveXaiProxyUrl('')).toBe('http://a.example:7897')
    await writeStoredProxyUrl('https://socks5wontwork.example:1080')
    expect(resolveXaiProxyUrl('')).toBe('https://socks5wontwork.example:1080')
    await writeStoredProxyUrl('')
  })

  it('applyXaiProxy returns the effective URL and clears cleanly', async () => {
    await tempHome()
    expect(applyXaiProxy('')).toBe('')
    expect(applyXaiProxy('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(applyXaiProxy('')).toBe('')
  })

  it('treats the literal "undefined"/"null" env spellings as unset and never throws on a bad URL', async () => {
    await tempHome()
    process.env.DSH_XAI_PROXY = 'undefined'
    expect(resolveXaiProxyUrl('')).toBe('')
    expect(applyXaiProxy('')).toBe('')
    process.env.DSH_XAI_PROXY = 'null'
    expect(resolveXaiProxyUrl('')).toBe('')
    // Invalid values are rejected, not crash-on-apply.
    expect(validProxyUrl('not a url')).toBeUndefined()
    expect(validProxyUrl('ftp://example:21')).toBeUndefined()
    expect(setXaiProxyUrl('not a url')).toBe(false)
    expect(setXaiProxyUrl('http://127.0.0.1:8080')).toBe(true)
    expect(setXaiProxyUrl('')).toBe(true)
  })

  it('refuses proxy URLs with embedded credentials and never persists them', async () => {
    const home = await tempHome()
    expect(validProxyUrl('http://user:pass@example.com:8080')).toBeUndefined()
    expect(validProxyUrl('http://user@example.com:8080')).toBeUndefined()
    expect(validProxyUrl('http://example.com:8080')).toBe('http://example.com:8080')
    expect(setXaiProxyUrl('http://user:pass@example.com:8080')).toBe(false)

    // Direct write of credentials is fail-closed: nothing hits the disk.
    await expect(writeStoredProxyUrl('http://user:pass@example.com:8080')).rejects.toThrow(/credentials/)
    expect(await readFile(xaiProxyPath(home), 'utf8').catch(() => '')).not.toContain('user')

    // A legacy file that already contains credentials is scrubbed ON DISK.
    await writeFile(xaiProxyPath(home), `${JSON.stringify({
      version: 1,
      proxyUrl: 'http://user:pass@example.com:8080',
    })}\n`)
    expect(readStoredProxyUrl()).toBe('')
    const disk = await readFile(xaiProxyPath(home), 'utf8')
    expect(disk).not.toContain('user')
    expect(disk).not.toContain('pass')
    expect(JSON.parse(disk)).toMatchObject({ version: 1, proxyUrl: '' })

    // env/config with credentials resolve to '' (nothing is routed).
    process.env.DSH_XAI_PROXY = 'http://user:pass@example.com:8080'
    expect(resolveXaiProxyUrl('')).toBe('')
    process.env.DSH_XAI_PROXY = ''
  })

  it('install/dispose restores the original fetch', async () => {
    await tempHome()
    const original = globalThis.fetch
    const d1 = installXaiFetchHook()
    applyXaiProxy('http://127.0.0.1:8080')
    expect(globalThis.fetch).not.toBe(original)
    d1()
    expect(globalThis.fetch).toBe(original)
    // Install again after dispose works (idempotent cycles).
    const d2 = installXaiFetchHook()
    applyXaiProxy('')
    expect(globalThis.fetch).not.toBe(original)
    d2()
    expect(globalThis.fetch).toBe(original)
  })

  it('reference counts owners: one release keeps the hook, the last restores it', async () => {
    const original = globalThis.fetch
    const d1 = installXaiFetchHook()
    const d2 = installXaiFetchHook()
    d1()
    expect(globalThis.fetch).not.toBe(original) // nestedStillHooked: true
    d2()
    expect(globalThis.fetch).toBe(original)
    // Released disposers are idempotent.
    d1()
    expect(globalThis.fetch).toBe(original)
  })

  it('never clobbers a fetch installed by a later component', async () => {
    const later = ((_input: unknown) => Promise.resolve(new Response('later'))) as typeof fetch
    const d1 = installXaiFetchHook()
    globalThis.fetch = later
    d1()
    expect(globalThis.fetch).toBe(later) // preservesLaterHook: true
    globalThis.fetch = later
  })
})
