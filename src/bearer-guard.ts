//
// Part of dsh-grok-kit, Apache-2.0.
//

/**
 * Fail-closed destination guard for the user's OAuth access token.
 *
 * Every request that would carry an `Authorization` header goes through this
 * module. Plugin call sites use {@link fetchWithBearer}, which attaches the
 * bearer only after the destination is accepted. pi-ai chat lets the OpenAI
 * SDK attach the header itself, so that path receives {@link guardBearerFetch}
 * and is refused before the underlying fetch runs.
 *
 * Any `Authorization` value counts, not only a scheme at the start of the
 * header. `Headers` joins duplicates into one comma-separated string, so a
 * leading `Basic` would hide a later `Bearer`. When `init.headers` and a
 * `Request` both exist, either side carrying the header is enough.
 *
 * A credentialed request is sent with `redirect: 'error'`, overriding the
 * caller, so a 3xx cannot move the token onto another path or host.
 *
 * OAuth login and refresh post a device code or refresh token as a form body
 * to auth.x.ai; they do not send this bearer. Video downloads are token-free
 * and must stay off {@link fetchWithBearer} (vidgen.x.ai is not allowlisted).
 *
 * Allowlist, https only, exact host, no userinfo, no non-default port, no
 * fragment:
 * - `api.x.ai` — any path (models, responses, images, video submit/status)
 * - `cli-chat-proxy.grok.com` — any path (billing and settings)
 * - `https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`
 *   exactly: no extra segment, query, or fragment
 *
 * @module dsh-grok-kit/bearer-guard
 */

/** Hosts that may receive the OAuth bearer on any https path. */
export const OAUTH_BEARER_HOSTS = ['api.x.ai', 'cli-chat-proxy.grok.com'] as const

/** The only grok.com URL that may receive the OAuth bearer. */
export const OAUTH_BEARER_EXACT_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'

const BEARER_HOSTS = new Set<string>(OAUTH_BEARER_HOSTS)
const EXACT_GROK_CREDITS = new URL(OAUTH_BEARER_EXACT_URL)

/** Node's fetch globals expose `RequestInit` but not the DOM `HeadersInit` / `RequestInfo` aliases. */
type FetchHeaders = NonNullable<RequestInit['headers']>
type FetchInput = Parameters<typeof fetch>[0]

/** Thrown when a bearer would be sent somewhere outside the allowlist. The message never includes the token. */
export class BearerDestinationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BearerDestinationError'
  }
}

function destinationLabel(url: URL): string {
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${url.hostname}${port}${url.pathname}`
}

function parseAbsolute(input: string): URL {
  try {
    return new URL(input)
  } catch {
    throw new BearerDestinationError('refusing to send the OAuth bearer: destination is not an absolute URL')
  }
}

function allowedDestination(url: URL): boolean {
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.port !== '') return false
  if (url.hash !== '') return false
  if (BEARER_HOSTS.has(url.hostname)) return true
  return url.hostname === EXACT_GROK_CREDITS.hostname
    && url.pathname === EXACT_GROK_CREDITS.pathname
    && url.search === EXACT_GROK_CREDITS.search
}

/** Accept an absolute https destination on the OAuth bearer allowlist. Returns the parsed URL. */
export function assertBearerDestination(input: string | URL): URL {
  const url = input instanceof URL ? new URL(input.href) : parseAbsolute(input)
  if (!allowedDestination(url)) {
    throw new BearerDestinationError(`refusing to send the OAuth bearer to ${destinationLabel(url)}`)
  }
  return url
}

/** True when {@link assertBearerDestination} would accept `input`. */
export function isBearerDestination(input: string | URL): boolean {
  try {
    assertBearerDestination(input)
    return true
  } catch (error) {
    if (error instanceof BearerDestinationError) return false
    throw error
  }
}

function copyHeaders(headers: FetchHeaders | undefined): Record<string, string> {
  if (headers === undefined) return {}
  const out: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    out[key] = value
  })
  return out
}

function headersWithBearer(headers: FetchHeaders | undefined, bearer: string): Record<string, string> {
  const out = copyHeaders(headers)
  out.authorization = `Bearer ${bearer}`
  return out
}

/**
 * Attach the OAuth bearer and perform the request.
 * The header is written only after the destination is accepted, and it
 * replaces any caller-supplied authorization header. `redirect` is always
 * `error`, including when the caller asked to follow.
 */
export function fetchWithBearer(
  fetchImpl: typeof fetch,
  input: string | URL,
  bearer: string,
  init?: RequestInit,
): Promise<Response> {
  assertBearerDestination(input)
  const headers = headersWithBearer(init?.headers, bearer)
  return fetchImpl(input, { ...init, headers, redirect: 'error' })
}

/**
 * True when `headers` carries `Authorization`, or when the header list cannot
 * be read. Duplicates count: the WHATWG constructor keeps the name if any
 * value was appended, including a bearer hidden after another scheme.
 */
function headersCarryAuthorization(headers: FetchHeaders): boolean {
  try {
    return new Headers(headers).has('authorization')
  } catch {
    return true
  }
}

function requestHeadersCarryAuthorization(request: Request): boolean {
  try {
    return request.headers.has('authorization')
  } catch {
    return true
  }
}

/**
 * Fail closed if either side carries `Authorization`. `init.headers` replaces
 * the Request's header list on the wire, so looking at only one side would
 * miss a bearer the other side still holds.
 */
function requestCarriesAuthorization(input: FetchInput, init?: RequestInit): boolean {
  const fromInit = init?.headers !== undefined && headersCarryAuthorization(init.headers)
  const fromRequest = typeof Request !== 'undefined'
    && input instanceof Request
    && requestHeadersCarryAuthorization(input)
  return fromInit || fromRequest
}

function requestDestination(input: FetchInput): string | URL {
  if (typeof input === 'string' || input instanceof URL) return input
  return input.url
}

/**
 * Wrap a fetch so a request that carries an Authorization header is refused
 * unless its destination is allowlisted, and is sent with `redirect: 'error'`.
 * Requests without that header (OAuth form posts, token-free downloads) are
 * forwarded unchanged, including their redirect mode.
 */
export function guardBearerFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!requestCarriesAuthorization(input, init)) return await fetchImpl(input, init)
    assertBearerDestination(requestDestination(input))
    return await fetchImpl(input, { ...init, redirect: 'error' })
  }) as typeof fetch
}
