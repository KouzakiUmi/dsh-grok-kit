/**
 * OAuth-only bearer source for search, chat 401 retry, and Imagine.
 * Refresh runs outside the 2s file lock; compare-and-write is inside it.
 * @module dsh-grok-kit/token-source
 */

import { createHash } from 'node:crypto'
import { XAI_PI_PROVIDER } from './ids.ts'
import type { XaiOAuthSession } from './session.ts'

/** OAuth-only token source shared by search, chat 401 retry, and Imagine. */
export interface XaiOAuthTokenSource {
  /** Cheap local availability check. Must not refresh or make network calls. */
  available(): boolean
  /** Local, non-secret account partition. Missing identity must fail closed for durable tasks. */
  identity?(): Promise<string | undefined>
  /** Resolve a current OAuth bearer. Implementations may refresh an expired token under their existing lock. */
  resolve(signal?: AbortSignal): Promise<string | undefined>
  /** Force-refresh after a server-side 401. Must stay OAuth-only and serialize refresh-token rotation. */
  refresh?(rejectedAccessToken: string, signal?: AbortSignal): Promise<string | undefined>
}

/** Account partition only, NOT JWT signature verification or an authorization decision. */
export function oauthIdentityOf(credential: { type: string; accountId?: string; access?: string } | undefined): string | undefined {
  if (credential?.type !== 'oauth') return undefined
  let subject = credential.accountId
  if (subject === undefined && typeof credential.access === 'string' && credential.access.length <= 32_768) {
    const parts = credential.access.split('.')
    if (parts.length === 3 && /^[A-Za-z0-9_-]+$/.test(parts[1] ?? '')) {
      try {
        const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'))
        if (typeof claims === 'object' && claims !== null && !Array.isArray(claims)
          && 'iss' in claims && claims.iss === 'https://auth.x.ai'
          && 'sub' in claims && typeof claims.sub === 'string') subject = claims.sub
      } catch {
        // Opaque or malformed tokens cannot identify durable tasks.
      }
    }
  }
  if (typeof subject !== 'string' || subject.trim().length === 0 || subject.length > 1024) return undefined
  return createHash('sha256').update(`xai-oauth-account:${subject}`).digest('hex')
}

const inFlightRefresh = new Map<string, Map<string, Promise<string | undefined>>>()

/** Stop this caller's wait, not the shared credential read or rotation. */
function waitForCredential<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => { cleanup(); reject(signal.reason) }
    // Observe settlement even when the signal is already aborted, so a late
    // rejection from the continuing operation cannot become unhandled.
    pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build a token source that is OAuth-only by construction, including forced
 * refresh after a server-side 401. In-process refreshes for the same rejected
 * bearer coalesce onto one `oauth.refresh` call.
 */
export function createXaiOAuthSearchTokenSource(session: XaiOAuthSession): XaiOAuthTokenSource {
  return {
    available: () => session.store.exists(),
    async identity(): Promise<string | undefined> {
      return oauthIdentityOf(await session.store.read(XAI_PI_PROVIDER))
    },
    async resolve(signal?: AbortSignal): Promise<string | undefined> {
      signal?.throwIfAborted()
      const credential = await waitForCredential(session.store.read(XAI_PI_PROVIDER), signal)
      signal?.throwIfAborted()
      if (credential?.type !== 'oauth') return undefined
      const auth = await waitForCredential(session.models.getAuth(XAI_PI_PROVIDER), signal)
      signal?.throwIfAborted()
      if (auth?.source !== 'OAuth') return undefined
      const accessToken = auth.auth.apiKey
      return accessToken === undefined || accessToken.length === 0 ? undefined : accessToken
    },
    async refresh(rejectedAccessToken: string, signal?: AbortSignal): Promise<string | undefined> {
      signal?.throwIfAborted()
      const storeKey = session.store.filename
      let refreshes = inFlightRefresh.get(storeKey)
      if (refreshes === undefined) {
        refreshes = new Map()
        inFlightRefresh.set(storeKey, refreshes)
      }
      const existing = refreshes.get(rejectedAccessToken)
      if (existing !== undefined) return waitForCredential(existing, signal)
      const pending = refreshRejected(session, rejectedAccessToken).finally(() => {
        if (refreshes.get(rejectedAccessToken) === pending) refreshes.delete(rejectedAccessToken)
        if (refreshes.size === 0) inFlightRefresh.delete(storeKey)
      })
      refreshes.set(rejectedAccessToken, pending)
      return waitForCredential(pending, signal)
    },
  }
}

async function refreshRejected(
  session: XaiOAuthSession,
  rejectedAccessToken: string,
): Promise<string | undefined> {
  const oauth = session.models.getProvider(XAI_PI_PROVIDER)?.auth.oauth
  if (oauth === undefined) return undefined
  const refreshSignal = new AbortController().signal
  const current = await session.store.read(XAI_PI_PROVIDER)
  refreshSignal.throwIfAborted()
  if (current?.type !== 'oauth') return undefined
  if (current.access !== rejectedAccessToken) return current.access
  const rotated = await oauth.refresh(current, refreshSignal)
  refreshSignal.throwIfAborted()
  const credential = await session.store.modify(XAI_PI_PROVIDER, async candidate => {
    refreshSignal.throwIfAborted()
    if (candidate?.type !== 'oauth') return undefined
    if (candidate.access !== rejectedAccessToken || candidate.refresh !== current.refresh) return undefined
    // Refresh rotates a credential for the same account, not a new login.
    return rotated.accountId === undefined && candidate.accountId !== undefined
      ? { ...rotated, accountId: candidate.accountId }
      : rotated
  })
  refreshSignal.throwIfAborted()
  if (credential?.type !== 'oauth') return undefined
  return credential.access.length === 0 ? undefined : credential.access
}
