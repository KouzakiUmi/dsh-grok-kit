//

// Part of dsh-grok-kit, Apache-2.0.

//

/**
 * In-memory capability state kernel for the Grok kit Web surface.
 *
 * The tracker records what the plugin itself observed (first version: video
 * task probes only); every other feature stays `unverified` until something
 * explicitly calls {@link CapabilityTracker.observe}. Nothing here probes an
 * upstream, persists state, or fabricates quota numbers. Its legacy quota
 * field stays unavailable for compatibility; account quota is read separately
 * through the quota route. `reset()` clears the recorded
 * history (used on sign-out so one account's diagnostics never leak to the
 * next viewer).
 */

import { safeMessage } from './redact.ts'

/** Features reported by the capabilities snapshot. */
export type CapabilityFeatureId = 'video' | 'voice' | 'code' | 'image-generation'

/** All feature ids, in stable snapshot order. */
export const CAPABILITY_FEATURE_IDS: readonly CapabilityFeatureId[] = [
  'video',
  'voice',
  'code',
  'image-generation',
]

/** What the plugin observed for one feature. */
export interface CapabilityObservation {
  state: 'available' | 'restricted' | 'temporary-error'
  checkedAt: string
  model: string
  httpStatus?: number
  message?: string
}

/** One feature row in the snapshot. */
export interface CapabilityFeatureState {
  id: CapabilityFeatureId
  state: 'unverified' | 'available' | 'restricted' | 'temporary-error'
  checkedAt?: string
  model?: string
  httpStatus?: number
  message?: string
}

/** Legacy snapshot field; live account quota uses the independent quota route. */
export interface CapabilityQuotaState {
  state: 'unavailable'
  message: string
}

export interface CapabilitySnapshot {
  features: CapabilityFeatureState[]
  quota: CapabilityQuotaState
  videoEnabled: boolean
}

const QUOTA_UNAVAILABLE_MESSAGE = 'Subscription quota is available from the account quota endpoint.'

/** Observation messages are redacted and truncated before they are stored. */
const MAX_MESSAGE_LENGTH = 300

/** Injectable clock: returns the ISO timestamp stored as `checkedAt`. */
export type CapabilityClock = () => string

function defaultClock(): string {
  return new Date().toISOString()
}

/**
 * Extra conservative redaction layered on top of the shared `safeMessage`:
 * upstream diagnostics may carry JSON keys (api_key / authorization / …),
 * signed URLs (X-Amz-Signature, sig=…), or full upstream bodies that the
 * shared helper does not cover. Values are replaced, never published; the
 * query string of any URL is stripped wholesale so a signed URL can never be
 * reconstructed from a diagnostic message.
 */
export function sanitizeDiagnosticMessage(message: string): string {
  return safeMessage(message)
    // JSON-style secrets with quoted values (the value may contain spaces):
    // "api_key": "…", 'authorization': 'Basic …', signature: "…"
    .replace(
      /(["']?[A-Za-z0-9_-]*(?:key|token|secret|signature|credential|auth|authorization)[A-Za-z0-9_-]*["']?\s*:\s*")([^"]*)(")/giu,
      '$1[redacted]$3',
    )
    // JSON-style secrets with bare values: token: abc123
    .replace(
      /(["']?[A-Za-z0-9_-]*(?:key|token|secret|signature|credential|auth|authorization)[A-Za-z0-9_-]*["']?\s*:\s*)([^"'\s,}\]]+)/giu,
      '$1[redacted]',
    )
    // Query parameters that carry credentials or signatures (X-Amz-Signature, sig, key, token, …).
    .replace(
      /([?&][A-Za-z0-9_.-]*(?:key|token|secret|signature|sig|credential|auth)[A-Za-z0-9_.-]*=)[^&\s'"]+/giu,
      '$1[redacted]',
    )
    // Authorization header values that are not Bearer (Bearer is covered above);
    // the rest of the line is dropped rather than risk a partial leak.
    .replace(/(authorization\s*:\s*)(?!bearer\b)[^\r\n]+/giu, '$1[redacted]')
    // Never publish a full upstream URL with its query string.
    .replace(/(https?:\/\/[^?\s'"<>]+)\?[^?\s'"<>]+/giu, '$1?[redacted]')
}

function sanitizeObservationMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  const safe = sanitizeDiagnosticMessage(message)
  return safe.length === 0 ? undefined : safe.slice(0, MAX_MESSAGE_LENGTH)
}

/**
 * Process-local owner of the observed capability states. Records are memory
 * only (never persisted, never sent anywhere), and `reset()` drops them so
 * history does not survive a sign-out or a plugin reload.
 */
export class CapabilityTracker {
  private readonly observations = new Map<CapabilityFeatureId, CapabilityObservation>()
  private readonly clock: CapabilityClock

  constructor(clock: CapabilityClock = defaultClock) {
    this.clock = clock
  }

  /** Record one observation. Only the video path calls this in the first version. */
  observe(
    feature: CapabilityFeatureId,
    event: {
      state: 'available' | 'restricted' | 'temporary-error'
      checkedAt: string
      model: string
      httpStatus?: number
      message?: string
    },
  ): void {
    const message = sanitizeObservationMessage(event.message)
    this.observations.set(feature, {
      state: event.state,
      checkedAt: event.checkedAt.length > 0 ? event.checkedAt : this.clock(),
      model: event.model,
      ...event.httpStatus === undefined ? {} : { httpStatus: event.httpStatus },
      ...message === undefined ? {} : { message },
    })
  }

  /** Drop every recorded observation (sign-out, dispose, tests). */
  reset(): void {
    this.observations.clear()
  }

  /**
   * Build the Web-facing snapshot. `videoEnabled` gates the video row: with
   * the feature flag off, stale observations are not reported.
   */
  snapshot(videoEnabled: boolean): CapabilitySnapshot {
    const features: CapabilityFeatureState[] = CAPABILITY_FEATURE_IDS.map(id => {
      if (id === 'video' && !videoEnabled) return { id, state: 'unverified' }
      const observed = this.observations.get(id)
      if (observed === undefined) return { id, state: 'unverified' }
      return { id, ...observed }
    })
    return {
      features,
      quota: { state: 'unavailable', message: QUOTA_UNAVAILABLE_MESSAGE },
      videoEnabled,
    }
  }
}
