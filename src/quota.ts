//

// Part of dsh-grok-kit, Apache-2.0.

//

/**
 * X Subscription / legacy SuperGrok quota probe over the official Grok CLI billing
 * proxy, reusing the shared OAuth token source (resolve + 401 refresh on the
 * same rotation chain as chat/search — never a bare token refresh here).
 *
 * The wire shape mirrors what dsh-subusage reads from
 * `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` (plus an
 * optional `GET /settings` for the plan display name): `creditUsagePercent`
 * is the USED percentage (0–100), legacy responses fall back to
 * `monthlyLimit`/`used` cents. That REST shape answers HTTP 500 ("Failed to
 * serialize billing response") on some unified-billing accounts, so a
 * non-auth failure falls back to grok.com's gRPC-web GetGrokCreditsConfig on
 * the same bearer (GROK-QUOTA-CREDITS-001, see ./grok-credits.ts). A readable period without a reported percentage
 * yields partial metadata, never a fabricated usage number. Snapshots are cached per OAuth
 * account partition for 60s; an unknown or mid-flight-changed identity fails
 * closed and never returns another account's data.
 *
 * Every await (token resolution, refresh, both reads) races the whole-get
 * deadline and the disposal controller, so a hung token source, refresh, or
 * body cannot outlive the 10s budget. Non-caller failures always come back
 * as a fixed snapshot state, never as an exception for the route.
 * @module dsh-grok-kit/quota
 */

import { sanitizeDiagnosticMessage } from './capabilities.ts'
import { GROK_GRPC_CREDITS_URL, GROK_GRPC_EMPTY_FRAME, parseGrokCreditsGrpcWeb } from './grok-credits.ts'
import type { GrokCreditsBillingBody } from './grok-credits.ts'
import type { XaiOAuthTokenSource } from './token-source.ts'

/** Official Grok CLI billing proxy (forwards to GetGrokCreditsConfig). */
export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
/** Plan display name source; failure falls back to the billing body tier. */
export const GROK_SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings'
/** Official GrokComConfig.token_header default: nginx routes OAuth on this string. */
export const GROK_TOKEN_AUTH = 'xai-grok-cli'
/** Version header the billing proxy expects alongside the token auth. */
export const GROK_CLIENT_VERSION = '1.0.13'

/** Hard budget for one get(): token resolution, refresh, and both reads. */
export const DEFAULT_QUOTA_TIMEOUT_MS = 10_000
/** Successful snapshots are served from cache for 60s per account. */
export const QUOTA_CACHE_TTL_MS = 60_000
/** Independent budget for the optional settings (plan name) read. */
export const QUOTA_SETTINGS_TIMEOUT_MS = 3_000
/** Upstream response ceiling (same scale as the Web routes' request ceiling). */
export const MAX_QUOTA_RESPONSE_BYTES = 1024 * 1024
/** Plan display names are upstream free text: sanitized and length-capped. */
export const QUOTA_PLAN_MAX_LENGTH = 100

export type QuotaPeriod = 'week' | 'month' | 'subscription'

export type QuotaErrorReason = 'auth' | 'restricted' | 'temporary' | 'invalid'

export interface AvailableQuotaSnapshot {
  state: 'available'
  /** USED percentage as reported by the billing proxy (0–100). */
  usedPercent: number
  /** 100 − usedPercent; derived, not an upstream field. */
  remainingPercent: number
  period: QuotaPeriod
  /** ISO timestamp of the fetch (cache hits keep the original). */
  checkedAt: string
  resetAt?: string
  plan?: string
  /** Prepaid (purchased) credit balance converted from US cents. */
  prepaidBalanceUsd?: number
  /** Authoritative proxy flag, not inferred from the displayed tier name. */
  unifiedBilling?: boolean
}

/** Readable subscription metadata when the proxy does not report a usage percentage. */
export interface PartialQuotaSnapshot {
  state: 'partial'
  period: QuotaPeriod
  checkedAt: string
  resetAt?: string
  plan?: string
  prepaidBalanceUsd?: number
  unifiedBilling?: boolean
}

type NormalizedQuota = Omit<AvailableQuotaSnapshot, 'state' | 'checkedAt'>
  | (Omit<PartialQuotaSnapshot, 'state' | 'checkedAt'> & { usedPercent?: never; remainingPercent?: never })

export type QuotaSnapshot =
  | AvailableQuotaSnapshot
  | PartialQuotaSnapshot
  | { state: 'signed-out' | 'unavailable' | 'error'; reason?: QuotaErrorReason }

/** Billing/settings JSON was readable but carried no usable quota fields. */
export class QuotaResponseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * proto3 message fields decode as `{ val: n }`; a bare `{}` is the proto
 * zero value. Missing messages and malformed values remain unknown.
 */
function cents(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  return Object.keys(value).length === 0 ? 0 : numeric(value.val)
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * RFC 3339 / ISO-8601 offset datetime with capture groups so the calendar
 * components can be validated below: Date.parse alone rolls invalid dates
 * forward ("0" becomes 2000-01-01, 2026-02-30 becomes March 2), which would
 * let an invented reset date be displayed and cached as a partial success.
 */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/u

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** Rejects lexically valid but calendar-invalid timestamps: 2026-02-30, 24:00, +25:00. */
function isRfc3339CalendarValid(match: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6]
    .map(index => match[index] === undefined ? 0 : Number(match[index]))
  const offsetHours = match[9] === undefined ? 0 : Number(match[9])
  const offsetMinutes = match[10] === undefined ? 0 : Number(match[10])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const monthDays = month === 2 && leapYear ? 29 : MONTH_DAYS[month - 1]
  // A leap second (60) is lexically valid per RFC 3339, but Date.parse still
  // rejects it below; the <= 60 range check only keeps it out of the 61+ bin.
  return month >= 1 && month <= 12
    && day >= 1 && day <= monthDays
    && hour < 24 && minute < 60 && second <= 60
    && offsetHours < 24 && offsetMinutes < 60
}

/** Accepts RFC 3339 strings and Unix epoch seconds/milliseconds; otherwise omitted. */
function parseResetAt(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const text = raw.trim()
    const match = ISO_DATE_TIME.exec(text)
    if (match === null || !isRfc3339CalendarValid(match)) return undefined
    const ms = Date.parse(text)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1e12 ? raw : raw * 1000
    return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined
  }
  return undefined
}

/**
 * Strict mapping of the GetGrokCreditsConfig billing body (plus the optional
 * settings body). A valid period may carry metadata without a percentage;
 * malformed percentages and unreadable data still throw. No values are invented.
 */
export function normalizeSuperGrokQuota(
  body: unknown,
  settingsBody: unknown,
): NormalizedQuota {
  const config = isRecord(body) && isRecord(body.config) ? body.config : {}
  let percent = numeric(config.creditUsagePercent)
  if (percent === undefined) {
    // Legacy shape: absolute US cents. A missing or proto-zero `{}` used
    // value is a genuine zero; anything else that is not a non-negative
    // number must not masquerade as zero usage.
    const limit = cents(config.monthlyLimit)
    if (limit !== undefined && limit > 0) {
      const usedRaw = config.used
      let used: number
      if (usedRaw === undefined) used = 0
      else {
        const value = cents(usedRaw)
        if (value !== undefined && value >= 0) used = value
        else if (isRecord(usedRaw) && Object.keys(usedRaw).length === 0) used = 0
        else throw new QuotaResponseError('SuperGrok billing response has an invalid used value')
      }
      percent = used / limit * 100
    }
  }
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined
  // The unified proxy can omit the percentage while reporting a valid period.
  // Preserve those details, but never interpret an omitted percentage as 0%.
  const periodOnly = percent === undefined && config.creditUsagePercent === undefined
    && (period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' || period?.type === 'USAGE_PERIOD_TYPE_MONTHLY')
    && parseResetAt(period.end) !== undefined
  if (percent === undefined ? !periodOnly : percent < 0 || percent > 100) {
    throw new QuotaResponseError('SuperGrok billing response has no usable usage percentage')
  }
  const periodType = period?.type
  // Legacy billing bounds evidence a monthly period only when at least one
  // bound is a real timestamp; present-but-garbage fields (e.g. end: "0")
  // must not be labelled a month with no reset date.
  const hasParseableBillingBounds = parseResetAt(config.billingPeriodStart) !== undefined
    || parseResetAt(config.billingPeriodEnd) !== undefined
  const kind: QuotaPeriod = periodType === 'USAGE_PERIOD_TYPE_WEEKLY' ? 'week'
    : periodType === 'USAGE_PERIOD_TYPE_MONTHLY' ? 'month'
      : period !== undefined ? 'subscription'
        : hasParseableBillingBounds ? 'month' : 'subscription'
  const plan = trimmedString(isRecord(settingsBody) ? settingsBody.subscription_tier_display : undefined)
    ?? trimmedString(isRecord(body) ? body.subscription_tier : undefined)
  // Upstream free text: strip token-like strings and URL query strings, then
  // cap the length; a plan reduced to nothing is omitted, never echoed raw.
  const safePlan = plan === undefined
    ? undefined
    : sanitizeDiagnosticMessage(plan).trim().slice(0, QUOTA_PLAN_MAX_LENGTH).trim()
  const prepaid = cents(config.prepaidBalance)
  const resetAt = parseResetAt(period?.end ?? config.billingPeriodEnd)
  const details = {
    period: kind,
    ...typeof config.isUnifiedBillingUser === 'boolean' ? { unifiedBilling: config.isUnifiedBillingUser } : {},
    ...resetAt === undefined ? {} : { resetAt },
    ...safePlan === undefined || safePlan.length === 0 ? {} : { plan: safePlan },
    // A negative prepaid balance is not a reportable credit balance.
    ...prepaid === undefined || prepaid < 0 ? {} : { prepaidBalanceUsd: Math.round(prepaid) / 100 },
  }
  return percent === undefined ? details : { ...details, usedPercent: percent, remainingPercent: 100 - percent }
}

/** Release an unread response without letting a broken cancel exceed the budget. */
function discardResponse(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined) } catch { /* Best effort. */ }
}

/** Bounded body read: hard byte ceiling, abort-aware. */
export async function readBoundedBytes(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) {
    discardResponse(response)
    signal.throwIfAborted()
  }
  const body = response.body
  if (body === null) throw new Error('quota response has no body')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let completed = false
  try {
    for (;;) {
      const pending = reader.read()
      const { done, value } = signal === undefined ? await pending : await raceAbort(pending, signal)
      if (done) { completed = true; break }
      size += value.byteLength
      if (size > maxBytes) throw new Error(`quota response body exceeded ${maxBytes} bytes`)
      chunks.push(value)
    }
  } finally {
    // The reader owns a locked body: response.body.cancel() cannot cancel it.
    // Do not await cancellation; transports may ignore it or never settle it.
    if (!completed) {
      try { void reader.cancel().catch(() => undefined) } catch { /* Best effort. */ }
    }
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Bounded JSON read: hard byte ceiling, then a strict JSON parse. */
export async function readBoundedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const text = (await readBoundedBytes(response, maxBytes, signal)).toString('utf8').trim()
  if (text.length === 0) throw new Error('quota response body is empty')
  return JSON.parse(text) as unknown
}

/**
 * Make an unabortable promise (a token-source getAuth, a hung body) actually
 * honor the shared budget signal: reject on abort and remove the listener
 * once either side settles. The underlying promise keeps running — its owner
 * (token source / fetch) is responsible for it, and dispose() aborts the
 * shared signal it was handed. Fetch callers also discard any response that
 * arrives after the race has already been aborted.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = false
    const onAbort = () => { aborted = true; reject(signal.reason) }
    // Observe the underlying promise first. get() after dispose() races an
    // already-aborted combined signal; returning before this handler would
    // leave a later identity/token rejection unhandled and can take down Node.
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        if (aborted) discard?.(value)
        else resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function quotaRequestInit(bearer: string, signal: AbortSignal): RequestInit {
  return {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${bearer}`,
      'x-xai-token-auth': GROK_TOKEN_AUTH,
      'x-grok-client-version': GROK_CLIENT_VERSION,
    },
    // A billing proxy must answer directly; following a redirect would send
    // the bearer somewhere the user never configured.
    redirect: 'error',
    signal,
  }
}

/**
 * gRPC-web credits probe request: the same bearer/routing headers as the REST
 * proxy plus the gRPC-web envelope (empty request message, grok.com origin —
 * the browser client sends exactly these; GROK-QUOTA-CREDITS-001).
 */
function grpcCreditsRequestInit(bearer: string, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: {
      accept: 'application/grpc-web+proto',
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      origin: 'https://grok.com',
      referer: 'https://grok.com/?_s=usage',
      authorization: `Bearer ${bearer}`,
      'x-xai-token-auth': GROK_TOKEN_AUTH,
      'x-grok-client-version': GROK_CLIENT_VERSION,
    },
    body: GROK_GRPC_EMPTY_FRAME,
    redirect: 'error',
    signal,
  }
}

interface CacheEntry {
  identity: string
  snapshot: AvailableQuotaSnapshot | PartialQuotaSnapshot
  fetchedAt: number
}

export interface SuperGrokQuotaClientOptions {
  /** Shared OAuth token source (resolve + refresh on the official chain). */
  tokens: XaiOAuthTokenSource
  /** Test seam; defaults to the current globalThis.fetch at call time. */
  fetch?: typeof fetch
  /** Injectable clock for TTL and checkedAt. */
  now?: () => number
  /** Whole-get budget in milliseconds. Defaults to 10s. */
  timeoutMs?: number
}

/**
 * Process-local owner of the SuperGrok quota cache. One success is cached for
 * the current account partition; sign-out, account switches, and unknown
 * identities fail closed instead of serving another account's numbers.
 */
export class SuperGrokQuotaClient {
  private readonly tokens: XaiOAuthTokenSource
  private readonly fetchImpl: typeof fetch | undefined
  private readonly now: () => number
  private readonly timeoutMs: number
  private cache: CacheEntry | undefined
  /** Bumped by reset()/dispose() so a stale in-flight get cannot re-fill the cache. */
  private generation = 0
  /** Aborted by dispose() so hung token/refresh/body work ends immediately. */
  private readonly disposal = new AbortController()

  constructor(options: SuperGrokQuotaClientOptions) {
    this.tokens = options.tokens
    this.fetchImpl = options.fetch
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS
  }

  /** Read the current global fetch lazily so a proxy hook installed after construction still applies. */
  private get fetcher(): typeof fetch {
    return this.fetchImpl ?? globalThis.fetch
  }

  /**
   * Drop the cache slot: sign-out, account switches, and identity changes
   * must not leave a request that started under the previous account writing
   * fresh-looking cache entries (nor A→B→A re-serving A's stale numbers).
   * The generation bump also blocks every in-flight get — including the one
   * performing this drop — from re-filling the slot afterwards.
   */
  reset(): void {
    this.cache = undefined
    this.generation += 1
  }

  /** Same drop as reset(); the bump intentionally also blocks this get's own later cache write. */
  private dropCache(): void {
    this.cache = undefined
    this.generation += 1
  }

  /**
   * Drop the cache (as reset) and abort every in-flight get through the
   * shared disposal signal — hung token resolution, refreshes, and body
   * reads end immediately. Gets started after dispose come back as a fixed
   * temporary error state; the route is unregistered by its own lifecycle.
   */
  dispose(): void {
    this.reset()
    this.disposal.abort(new Error('SuperGrok quota client disposed'))
  }

  /**
   * Serve a cached snapshot for the current account, or probe the billing
   * proxy. Only caller cancellation (route disconnect) propagates as a
   * thrown error; deadline expiry, disposal, and every other failure map to
   * a fixed snapshot state that never carries upstream diagnostics.
   */
  async get(signal?: AbortSignal): Promise<QuotaSnapshot> {
    signal?.throwIfAborted()
    // Captured before anything runs: a reset()/dispose() at any point during
    // this get — including while the identity read is in flight — blocks its
    // cache write. A dropCache() this get performs for its own account switch
    // therefore also costs it the write; that is conservative and safe (the
    // next read refetches and caches).
    const generation = this.generation
    if (!this.tokens.available()) {
      // Signed out: nothing may survive — not the cache, and not an in-flight
      // get from the signed-in account that could re-fill it.
      this.dropCache()
      return { state: 'signed-out' }
    }
    try {
      return await this.probe(generation, signal)
    } catch (error) {
      // Caller cancellation rethrows; the deadline, disposal, and every other
      // failure come back as a fixed temporary state — never as an exception
      // the route would have to turn into a 500.
      if (signal?.aborted) throw error
      return { state: 'error', reason: 'temporary' }
    }
  }

  private async probe(generation: number, signal: AbortSignal | undefined): Promise<QuotaSnapshot> {
    // One hard deadline covering token resolution, the refresh, and both reads.
    const deadline = AbortSignal.timeout(this.timeoutMs)
    const combined = signal === undefined
      ? AbortSignal.any([deadline, this.disposal.signal])
      : AbortSignal.any([deadline, this.disposal.signal, signal])
    // Fail closed: without a stable account partition nothing is cached,
    // returned, or attributed to a previous account. The identity read has no
    // signal parameter, so it races the budget here.
    const identity = await raceAbort(Promise.resolve(this.tokens.identity?.()), combined)
    if (identity === undefined) {
      // Fail closed: without a stable account partition nothing is cached,
      // returned, or attributed to a previous account.
      this.dropCache()
      return { state: 'unavailable', reason: 'auth' }
    }
    const cached = this.cache
    if (cached !== undefined && cached.identity !== identity) {
      // A different account is current: the previous account's entry must not
      // survive a A→B→A round-trip, and an in-flight get under the old
      // account must not re-fill the slot.
      this.dropCache()
    } else if (cached !== undefined && this.now() - cached.fetchedAt < QUOTA_CACHE_TTL_MS) {
      // Serve from cache only after re-checking that the account partition is
      // still the one this get started with (mirrors the post-fetch check).
      const identityNow = await raceAbort(Promise.resolve(this.tokens.identity?.()), combined)
      if (identityNow !== identity) {
        this.dropCache()
        return { state: 'unavailable' }
      }
      return cached.snapshot
    }
    // Token resolution (getAuth) may ignore its signal: race it so the budget
    // is real, and let the shared disposal abort it mid-flight.
    const bearer = await raceAbort(Promise.resolve(this.tokens.resolve(combined)), combined)
    if (bearer === undefined || bearer.length === 0) {
      this.dropCache()
      return { state: 'signed-out' }
    }
    const resolved = await this.resolveBilling(bearer, combined)
    if ('state' in resolved) return { state: 'error', reason: resolved.reason }
    let data: NormalizedQuota
    try {
      data = normalizeSuperGrokQuota(resolved.body, resolved.settings)
    } catch {
      return { state: 'error', reason: 'invalid' }
    }
    // The snapshot belongs to the account that was current when it was
    // fetched: a mid-flight account change must neither return nor cache it.
    const identityAfter = await raceAbort(Promise.resolve(this.tokens.identity?.()), combined)
    if (identityAfter !== identity) return { state: 'unavailable' }
    const checkedAt = new Date(this.now()).toISOString()
    const snapshot: AvailableQuotaSnapshot | PartialQuotaSnapshot = typeof data.usedPercent === 'number' && typeof data.remainingPercent === 'number'
      ? { ...data, state: 'available', usedPercent: data.usedPercent, remainingPercent: data.remainingPercent, checkedAt }
      : { ...data, state: 'partial', checkedAt }
    // A reset()/dispose() since this get started wins: the stale in-flight
    // result is still returned to its own caller, but never re-cached.
    if (generation === this.generation) {
      this.cache = { identity, snapshot, fetchedAt: this.now() }
    }
    return snapshot
  }

  /**
   * Resolve the billing body and its settings companion. The REST credits
   * shape runs first (with at most one 401 refresh on the shared official
   * chain); any non-auth failure — transport error or a non-401/403 status —
   * falls back to the gRPC-web credits probe on the same bearer before the
   * failure is reported (GROK-QUOTA-CREDITS-001). Auth outcomes never fall
   * back, so a revoked login can never surface as usage data.
   */
  private async resolveBilling(bearer: string, signal: AbortSignal): Promise<BillingResolution> {
    let token = bearer
    let round: QuotaRound
    try {
      round = await this.fetchRound(token, signal)
    } catch (error) {
      return this.grpcOrRethrow(token, signal, error)
    }
    if (signal.aborted) { discardResponse(round.billing); signal.throwIfAborted() }
    if (round.billing.status === 401) {
      discardResponse(round.billing)
      // At most one refresh, on the shared official chain; 403/429 never
      // refresh. A refresh that returns nothing new cannot be retried.
      const refreshed = await raceAbort(Promise.resolve(this.tokens.refresh?.(token, signal)), signal)
      if (refreshed === undefined || refreshed.length === 0 || refreshed === token) {
        return { state: 'error', reason: 'auth' }
      }
      token = refreshed
      try {
        round = await this.fetchRound(token, signal)
      } catch (error) {
        return this.grpcOrRethrow(token, signal, error)
      }
      if (signal.aborted) { discardResponse(round.billing); signal.throwIfAborted() }
      if (round.billing.status === 401) {
        discardResponse(round.billing)
        return { state: 'error', reason: 'auth' }
      }
    }
    if (!round.billing.ok) {
      const status = round.billing.status
      discardResponse(round.billing)
      if (status === 403) return { state: 'error', reason: 'restricted' }
      // The parallel settings read has already settled here and still carries
      // the plan name alongside the gRPC fallback body.
      const grpcBody = await this.probeCreditsGrpc(token, signal)
      return grpcBody === undefined
        ? { state: 'error', reason: 'temporary' }
        : { body: grpcBody, settings: round.settings }
    }
    try {
      return { body: await readBoundedJson(round.billing, MAX_QUOTA_RESPONSE_BYTES, signal), settings: round.settings }
    } catch (error) {
      // Aborts (deadline/disposal/caller) propagate to the state mapping in
      // get(); a readable but unusable body is an invalid response.
      if (signal.aborted) throw error
      return { state: 'error', reason: 'invalid' }
    }
  }

  /** Transport-failure path: the gRPC-web probe may still answer on this bearer. */
  private async grpcOrRethrow(token: string, signal: AbortSignal, error: unknown): Promise<BillingResolution> {
    if (signal.aborted) throw error
    const grpcBody = await this.probeCreditsGrpc(token, signal)
    if (grpcBody === undefined) throw error
    return { body: grpcBody, settings: undefined }
  }

  /**
   * gRPC-web credits fallback (GROK-QUOTA-CREDITS-001). Any failure returns
   * undefined so the REST outcome keeps deciding the snapshot state; caller
   * aborts still propagate.
   */
  private async probeCreditsGrpc(bearer: string, signal: AbortSignal): Promise<GrokCreditsBillingBody | undefined> {
    try {
      const response = await raceAbort(
        this.fetcher(GROK_GRPC_CREDITS_URL, grpcCreditsRequestInit(bearer, signal)), signal, discardResponse,
      )
      if (signal.aborted) { discardResponse(response); signal.throwIfAborted() }
      const grpcStatus = response.headers.get('grpc-status')
      if (response.ok && (grpcStatus === null || grpcStatus === '0')) {
        return parseGrokCreditsGrpcWeb(await readBoundedBytes(response, MAX_QUOTA_RESPONSE_BYTES, signal))
      }
      discardResponse(response)
      return undefined
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }
  }

  private async fetchRound(bearer: string, signal: AbortSignal): Promise<QuotaRound> {
    // Settings runs under its own shorter budget so a hung plan endpoint
    // cannot eat the whole-get deadline and drag a successful billing read
    // down with it.
    const failed = new AbortController()
    const roundSignal = AbortSignal.any([signal, failed.signal])
    let billing: Response | undefined
    const discardBilling = () => {
      if (billing !== undefined) { discardResponse(billing); billing = undefined }
    }
    roundSignal.addEventListener('abort', discardBilling, { once: true })
    try {
      const [response, settings] = await Promise.all([
        raceAbort(this.fetcher(GROK_BILLING_URL, quotaRequestInit(bearer, roundSignal)), roundSignal, discardResponse)
          .then(response => {
            billing = response
            if (roundSignal.aborted) { discardBilling(); roundSignal.throwIfAborted() }
            return response
          }),
        this.readSettings(bearer, roundSignal),
      ])
      roundSignal.throwIfAborted()
      return { billing: response, settings }
    } catch (error) {
      // A billing failure must also stop settings, including its active reader.
      failed.abort(error)
      discardBilling()
      throw error
    } finally {
      roundSignal.removeEventListener('abort', discardBilling)
    }
  }

  /**
   * Optional plan display name: its own budget (≤3s and ≤ half the whole-get
   * budget), raced fetch + body, any failure degrading to undefined — the
   * billing read decides the quota answer.
   */
  private async readSettings(bearer: string, wholeSignal: AbortSignal): Promise<unknown> {
    const settingsBudget = Math.min(QUOTA_SETTINGS_TIMEOUT_MS, Math.floor(this.timeoutMs / 2))
    const settingsSignal = AbortSignal.any([wholeSignal, AbortSignal.timeout(settingsBudget)])
    try {
      const response = await raceAbort(
        this.fetcher(GROK_SETTINGS_URL, quotaRequestInit(bearer, settingsSignal)), settingsSignal, discardResponse,
      )
      // Fetch may settle just before the abort, with this continuation queued.
      if (settingsSignal.aborted) { discardResponse(response); settingsSignal.throwIfAborted() }
      if (response.ok) return await readBoundedJson(response, MAX_QUOTA_RESPONSE_BYTES, settingsSignal)
      // A non-ok settings response must not hold the connection open.
      discardResponse(response)
      return undefined
    } catch {
      // Timeout, status, or parse failure: the plan falls back to the
      // billing body tier (normalizeSuperGrokQuota handles undefined).
      return undefined
    }
  }
}

interface QuotaRound {
  billing: Response
  settings: unknown
}

/** A parsed billing body plus the settings companion the plan name comes from. */
type BillingResolution =
  | { body: unknown; settings: unknown }
  | { state: 'error'; reason: QuotaErrorReason }
