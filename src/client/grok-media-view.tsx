//
// Part of dsh-grok-kit, Apache-2.0.
//

/**
 * Conversation-page "Generated videos" view: occupies the host
 * `conversation.view` slot so a tab at the top of the conversation page lists
 * every video task this plugin generated for the signed-in account. The
 * settings page keeps only the image/video switches — this tab is the
 * maintenance surface for generated media: play, download, resume, refresh and
 * clear/archive the local task list.
 *
 * Host contract honoured:
 *   - the entry is registered into `conversation.view` (a list, session scope
 *     slot declared by `conversation.session`); the host renders each entry's
 *     component when its tab is active (`renderSlot("conversation.view", …, {
 *     only: viewId })`). We consume only the locale `t` seat and ignore the
 *     session-scoped conversation view owner props — media data is
 *     account-global, not per-session.
 *   - reads are the same frozen same-origin routes the settings page used:
 *     `GET /auth/status` (signed-in gate), `GET /plugins/dsh-grok-kit/capabilities`
 *     (the `videoEnabled` gate) and the task/clear routes owned by
 *     {@link VideoTasksView}; no new routes are introduced client-side.
 *   - the view is mounted only while its tab is active, so leaving it aborts
 *     in-flight reads and revokes blob URLs exactly as the settings page did.
 */

import { useEffect, useState, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { VideoTasksView } from './capabilities-view.tsx'
import { en } from './locales.ts'
import type { XaiOAuthSettingsKey } from './locales.ts'

export type MediaViewTranslate = (key: XaiOAuthSettingsKey, params?: Record<string, unknown>) => string

const FALLBACK_TRANSLATE: MediaViewTranslate = key => en[key]

const STATUS_PATH = '/plugins/dsh-grok-kit/auth/status'
const CAPABILITIES_PATH = '/plugins/dsh-grok-kit/capabilities'

const wrapStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', maxWidth: 760 }
const headingStyle: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const introStyle: CSSProperties = { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const mutedStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, #81858c)' }

type MediaPanelState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'ready'; videoEnabled: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return response.json().catch(() => undefined)
}

/**
 * The signed-in gate and the video-tool gate the task list needs, read once
 * from the frozen routes. Unknown/failed reads settle to the unauthenticated
 * state: mounting the account-scoped list blind would surface a spurious 403.
 */
function useMediaPanelState(): MediaPanelState {
  const [state, setState] = useState<MediaPanelState>({ kind: 'loading' })
  useEffect(() => {
    const abort = new AbortController()
    let live = true
    Promise.all([
      readJson(STATUS_PATH, abort.signal),
      readJson(CAPABILITIES_PATH, abort.signal),
    ])
      .then(([status, capabilities]) => {
        if (!live) return
        const signedIn = isRecord(status) && status.status === 'signed-in'
        if (!signedIn) {
          setState({ kind: 'unauthenticated' })
          return
        }
        const videoEnabled = isRecord(capabilities) && capabilities.videoEnabled === true
        setState({ kind: 'ready', videoEnabled })
      })
      .catch(() => {
        if (live) setState({ kind: 'unauthenticated' })
      })
    return () => {
      live = false
      abort.abort()
    }
  }, [])
  return state
}

interface GrokMediaViewProps {
  /** Locale translator injected by the slot registration; English fallback when absent. */
  t?: MediaViewTranslate
}

/**
 * The conversation-page generated-videos view: the maintenance list of the
 * account's video tasks (play / download / resume / clear). A thin shell around
 * {@link VideoTasksView} — it owns only the signed-in and video-enabled gates;
 * the list itself, its reads and its clear actions stay where they were.
 */
export function GrokMediaView({ t: translate }: GrokMediaViewProps) {
  const t = translate ?? FALLBACK_TRANSLATE
  const state = useMediaPanelState()
  return (
    <div style={wrapStyle} aria-labelledby="grok-media-view-title" data-testid="grok-media-view">
      <header>
        <h2 id="grok-media-view-title" style={headingStyle}>{t('mediaViewTitle')}</h2>
        <p style={introStyle}>{t('mediaViewIntro')}</p>
      </header>
      {state.kind === 'loading' ? <p style={mutedStyle}>{t('mediaViewLoading')}</p> : null}
      {state.kind === 'unauthenticated' ? <p style={mutedStyle}>{t('mediaViewSignedOut')}</p> : null}
      {state.kind === 'ready' ? <VideoTasksView t={t} videoEnabled={state.videoEnabled} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Slot wiring
// ---------------------------------------------------------------------------

/** Tab identity contributed into the host `conversation.view` list slot. */
const MEDIA_VIEW_ID = 'grok-media'

/**
 * Register the generated-videos view as a conversation-page tab. Called from
 * the client entry; the registration lives in a `slots` child fiber so it
 * unloads with the host UI (same shape as `applyVideoViews`).
 *
 * The translator is bound from the plugin's existing settings locale namespace
 * (`settings.xai-oauth`) so the tab label and the panel copy follow the host
 * language; if the locale service is unavailable the view falls back to the
 * English copy — never to hardcoded Chinese.
 */
export function applyGrokMediaView(ctx: Context): void {
  const t: MediaViewTranslate = typeof ctx.locale?.bind === 'function'
    ? ctx.locale.bind('settings.xai-oauth') as MediaViewTranslate
    : FALLBACK_TRANSLATE
  ctx.inject(['slots'], scope => {
    scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view',
      id: MEDIA_VIEW_ID,
      order: 100,
      label: () => t('mediaViewTitle'),
      inject: () => ({ t }),
    }, GrokMediaView))
  })
}
