/**
 * xAI-only outbound proxy — per-plugin setting, no global configuration.
 *
 * Style matches the other local dsh plugins: this bundle owns one setting
 * of its own (stored in `$DSH_HOME/.xai-oauth-proxy.json`, editable on its
 * settings page). Nothing global is touched except one transparent
 * `globalThis.fetch` hook that routes ONLY `x.ai` origins (api.x.ai / x.ai
 * and subdomains, plus the exact cli-chat-proxy.grok.com billing host and
 * the exact grok.com GetGrokCreditsConfig path) through this plugin's
 * ProxyAgent and passes every other request to the original fetch
 * untouched. While the plugin is loaded the hook applies to ALL matching
 * requests in this process — including the catalog `xai` API-key route —
 * and it is restored on plugin dispose.
 *
 * Effective URL precedence: stored setting > plugin config `proxyUrl` >
 * `DSH_XAI_PROXY` (plugin-scoped env for headless/CLI use). HTTP/HTTPS
 * proxy URLs only; undici's ProxyAgent does not speak SOCKS. URLs with
 * embedded credentials are rejected and never persisted.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { GROK_GRPC_CREDITS_URL } from './grok-credits.ts'
import { GROK_BILLING_URL, GROK_SETTINGS_URL } from './quota.ts'

const PROXY_FILE_VERSION = 1
const PROXY_FILENAME = '.xai-oauth-proxy.json'

export interface XaiProxySettings {
  proxyUrl: string
  /** Opt-in: quota uses a plugin-owned transport instead of global fetch wrappers. */
  quotaCompatibilityMode: boolean
}

/** Absolute path of the plugin-owned proxy setting file. */
export function xaiProxyPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), PROXY_FILENAME))
}

/** Best-effort atomic scrub of a stored proxy file that held credentials. */
function cleanupStoredProxy(file: string): void {
  const tmp = `${file}.cleanup`
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: PROXY_FILE_VERSION, proxyUrl: '' }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // Best effort: the read path already returns '' — disk scrubbing is defense.
  }
}

/**
 * Read the plugin's own stored proxy URL ('' = off; invalid/userinfo values
 * are dropped AND the disk copy is scrubbed so credentials do not linger).
 */
function readStoredProxySettings(): XaiProxySettings | undefined {
  try {
    const file = xaiProxyPath()
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: unknown
      proxyUrl?: unknown
      quotaCompatibilityMode?: unknown
    }
    if (doc.version !== PROXY_FILE_VERSION) return undefined
    const normalized = validProxyUrl(typeof doc.proxyUrl === 'string' ? doc.proxyUrl.trim() : '')
    if (normalized === undefined) {
      cleanupStoredProxy(file)
      return { proxyUrl: '', quotaCompatibilityMode: false }
    }
    return { proxyUrl: normalized, quotaCompatibilityMode: doc.quotaCompatibilityMode === true }
  } catch {
    return undefined
  }
}

export function readStoredProxyUrl(): string {
  return readStoredProxySettings()?.proxyUrl ?? ''
}

/**
 * Persist the plugin's own proxy setting. Fail-closed: URLs with embedded
 * credentials or invalid proxies are rejected BEFORE anything hits disk.
 */
export async function writeStoredProxySettings(settings: XaiProxySettings): Promise<void> {
  const normalized = validProxyUrl(settings.proxyUrl)
  if (normalized === undefined) {
    throw new Error('proxyUrl must be a valid http:// or https:// URL without embedded credentials')
  }
  const file = xaiProxyPath()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  await writeFileAtomic(file, `${JSON.stringify(
    { version: PROXY_FILE_VERSION, proxyUrl: normalized, quotaCompatibilityMode: settings.quotaCompatibilityMode },
    null,
    2,
  )}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** Legacy URL-only callers must not silently reset the compatibility choice. */
export async function writeStoredProxyUrl(url: string): Promise<void> {
  await writeStoredProxySettings({
    proxyUrl: url,
    quotaCompatibilityMode: readStoredProxySettings()?.quotaCompatibilityMode ?? false,
  })
}

let proxyAgent: ProxyAgent | null = null
let quotaDirectAgent: Agent | null = null
let quotaCompatibilityMode = false

function urlHref(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') {
    return (input as { url: string }).url
  }
  return ''
}

const GROK_CREDITS_PATH = new URL(GROK_GRPC_CREDITS_URL).pathname

/**
 * xAI API origins, the exact official Grok subscription billing proxy, and
 * the exact grok.com GetGrokCreditsConfig fallback. Other grok.com paths stay
 * direct so a configured proxy is not a general grok.com tunnel
 * (GROK-QUOTA-CREDITS-001).
 */
export function isXaiProxyTarget(input: unknown): boolean {
  if (input === undefined || input === null) return false
  try {
    const url = new URL(urlHref(input))
    const host = url.hostname.toLowerCase()
    if (host === 'x.ai' || host.endsWith('.x.ai') || host === 'cli-chat-proxy.grok.com') return true
    return host === 'grok.com' && url.pathname === GROK_CREDITS_PATH
  } catch {
    return false
  }
}

/** Narrow to a URL-bearing value: not '', not the literal spellings 'undefined'/'null'. */
function nonBlank(value: string | undefined): value is string {
  if (value === undefined) return false
  const trimmed = value.trim()
  return trimmed !== '' && trimmed !== 'undefined' && trimmed !== 'null'
}

/** Validate an HTTP(S) proxy URL. Returns the trimmed URL, '' for an explicit off, or undefined for an invalid value. */
export function validProxyUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.hostname.length === 0) return undefined
    // Refuse embedded credentials (username:password@host): the stored proxy
    // file, the GET /auth/proxy response and logs must never carry them.
    if (parsed.username !== '' || parsed.password !== '') return undefined
    return trimmed
  } catch {
    return undefined
  }
}

/**
 * Point the xAI-only hook at a proxy URL; '' clears it (xAI goes direct too).
 * Invalid URLs are rejected and never throw — the plugin must not crash on a
 * bad stored/env value. Returns true when the value was applied.
 */
export function setXaiProxyUrl(url: string): boolean {
  const normalized = validProxyUrl(url)
  const previous = proxyAgent
  proxyAgent = null
  if (previous !== null) void previous.close().catch(() => undefined)
  if (normalized === undefined) return false
  if (normalized !== '') proxyAgent = new ProxyAgent(normalized)
  return true
}

const QUOTA_ENDPOINTS = new Set([GROK_BILLING_URL, GROK_SETTINGS_URL, GROK_GRPC_CREDITS_URL])

/** Runtime-only; callers persist the settings before applying a change. */
export function setQuotaCompatibilityMode(enabled: boolean): void {
  quotaCompatibilityMode = enabled
}

/**
 * Quota-only fetch adapter. Off preserves the current global wrapper chain.
 * On uses imported Undici plus an explicit current dispatcher (including a
 * plugin-owned direct Agent when the URL is blank), not the global dispatcher.
 * The quota client supplies URL inputs and only strings/byte-array bodies;
 * normalizing headers and wrapping the response stream bridge DOM/Undici types
 * without buffering away the client's body ceiling or cancellation semantics.
 */
export const fetchGrokQuota: typeof fetch = async (input, init) => {
  if (!quotaCompatibilityMode) return globalThis.fetch(input, init)
  if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('Quota transport requires a URL')
  // Defense in depth: this bypass is never a general-purpose outbound fetch,
  // even if a future caller forgets the upstream bearer destination guard.
  if (!QUOTA_ENDPOINTS.has(new URL(input).href)) throw new TypeError('Quota transport requires an official quota endpoint')
  const body = init?.body
  if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    throw new TypeError('Quota transport requires a string or byte-array body')
  }
  const dispatcher = proxyAgent ?? (quotaDirectAgent ??= new Agent())
  const response = await undiciFetch(input, {
    ...init,
    body,
    headers: Object.fromEntries(new Headers(init?.headers)),
    dispatcher,
    redirect: 'error',
  })
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers),
  })
}

/**
 * Install a transparent global-fetch hook that routes x.ai origins, the
 * exact official Grok billing host, and the exact GetGrokCreditsConfig path
 * through this plugin's ProxyAgent; every other request goes to the
 * original fetch untouched. Reference counted: every install returns its
 * OWN idempotent disposer, and the original fetch is restored only after
 * the LAST owner releases — and only if our wrapper is still installed
 * (a later component that replaced fetch after us is never clobbered).
 */
export function installXaiFetchHook(): () => void {
  if (hookOwners === 0) {
    originalFetch = globalThis.fetch
    const base = originalFetch.bind(globalThis)
    const wrapper = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      if (proxyAgent !== null && isXaiProxyTarget(input)) {
        return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
          ...(init ?? {}),
          dispatcher: proxyAgent,
        } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
      }
      return base(input, init)
    }) as typeof fetch
    globalThis.fetch = wrapper
    installedWrapper = wrapper
  }
  hookOwners += 1
  let released = false
  return () => {
    if (released) return
    released = true
    hookOwners -= 1
    if (hookOwners > 0) return
    // Only restore when our wrapper is still the installed fetch; a later
    // third-party hook must not be clobbered by our dispose.
    if (installedWrapper !== undefined && globalThis.fetch === installedWrapper) {
      globalThis.fetch = originalFetch ?? globalThis.fetch
    }
    const previous = proxyAgent
    proxyAgent = null
    if (previous !== null) void previous.close().catch(() => undefined)
    const direct = quotaDirectAgent
    quotaDirectAgent = null
    if (direct !== null) void direct.close().catch(() => undefined)
    quotaCompatibilityMode = false
    installedWrapper = undefined
    originalFetch = undefined
  }
}

let hookOwners = 0
let installedWrapper: typeof fetch | undefined
let originalFetch: typeof fetch | undefined

/** Effective settings; show config/env fallback so toggling mode cannot clear an unseen proxy. */
export function readXaiProxySettings(configUrl?: string): XaiProxySettings {
  const stored = readStoredProxySettings()
  if (stored !== undefined) return stored
  const env = process.env.DSH_XAI_PROXY
  const candidate = nonBlank(configUrl) ? configUrl.trim() : nonBlank(env) ? env.trim() : ''
  return { proxyUrl: validProxyUrl(candidate) ?? '', quotaCompatibilityMode: false }
}

/** Effective proxy URL: stored > config > env. Invalid/userinfo values resolve to ''. */
export function resolveXaiProxyUrl(configUrl?: string): string {
  return readXaiProxySettings(configUrl).proxyUrl
}

/**
 * Apply the effective proxy URL (stored > config > env) to the already
 * installed hook. Callers own the hook lifecycle via installXaiFetchHook().
 * Returns the effective URL, '' when unset/invalid.
 */
export function applyXaiProxy(configUrl?: string): string {
  const settings = readXaiProxySettings(configUrl)
  setXaiProxyUrl(settings.proxyUrl)
  setQuotaCompatibilityMode(settings.quotaCompatibilityMode)
  return settings.proxyUrl
}
