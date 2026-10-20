//

// Part of dsh-grok-kit, Apache-2.0.

//

/**
 * Local video task list for the conversation-page "Generated videos" view
 * (`grok-media-view` embeds {@link VideoTasksView}).
 *
 * Contract rules honoured here:
 *   - reads only the frozen same-origin routes: `GET
 *     /plugins/dsh-grok-kit/video/tasks` and `POST
 *     /plugins/dsh-grok-kit/video/tasks/clear`; the query/resume and file-byte
 *     actions live inside the shared {@link VideoMediaCard} (same card, same
 *     visuals and the same state actions as the session toolview);
 *   - no automatic probing of the upstream and no timer polling — one read on
 *     mount plus explicit refresh;
 *   - loading and error states are real, and every fetch is aborted when the
 *     component unmounts;
 *   - clearing removes only this account's local records; the host attachment
 *     store is immutable and its files are never deleted here.
 */

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { XaiOAuthSettingsKey } from './locales.ts'
import { VideoMediaCard, parseVideoTasks } from './video-view.tsx'
import type { VideoTaskResult } from './video-view.tsx'

const VIDEO_TASKS_PATH = '/plugins/dsh-grok-kit/video/tasks'
const VIDEO_CLEAR_PATH = '/plugins/dsh-grok-kit/video/tasks/clear'

/** Settings locale binder shape (injected by `XaiSettings`). */
export type SettingsTranslate = (key: XaiOAuthSettingsKey, params?: Record<string, unknown>) => string

// ---------------------------------------------------------------------------
// Small request helper (same-origin JSON, abortable)
// ---------------------------------------------------------------------------

interface JsonRequestInit {
  method?: 'GET' | 'POST'
  body?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function requestJson(path: string, init: JsonRequestInit, signal: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const request: RequestInit = { method: init.method ?? 'GET', credentials: 'same-origin', headers, signal }
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json'
    request.body = JSON.stringify(init.body)
  }
  const response = await fetch(path, request)
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = isRecord(value) && typeof value['error'] === 'string' ? `: ${value['error']}` : ''
    throw new Error(`HTTP ${String(response.status)}${detail}`)
  }
  return value
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

// ---------------------------------------------------------------------------
// Styles (host `--dsw-alias-*` tokens)
// ---------------------------------------------------------------------------

const titleStyle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const hintStyle: CSSProperties = { ...bodyStyle, fontSize: 12, margin: 0, color: 'var(--dsw-alias-label-tertiary, #81858c)' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const listStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, margin: 0, padding: 0, listStyle: 'none' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 32, padding: '5px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer' }

// ---------------------------------------------------------------------------
// Video task list
// ---------------------------------------------------------------------------

type TasksStatus =
  | { kind: 'disabled' }
  | { kind: 'loading' }
  | { kind: 'error'; detail: string }
  | { kind: 'ready'; tasks: VideoTaskResult[] }

/**
 * Local video task list: one read per mount/refresh. Each row renders the same
 * {@link VideoMediaCard} as the session toolview (query/resume/download/play
 * actions included), keyed by `resetToken` so a refreshed list wins over a
 * locally applied query/resume result.
 */
export function VideoTasksView({ t, videoEnabled }: { t: SettingsTranslate; videoEnabled: boolean }) {
  const [status, setStatus] = useState<TasksStatus>({ kind: videoEnabled ? 'loading' : 'disabled' })
  const [reloadKey, setReloadKey] = useState(0)
  const [clearState, setClearState] = useState<{ kind: 'idle' | 'busy' | 'done' | 'error'; removed?: number }>({ kind: 'idle' })

  useEffect(() => {
    if (!videoEnabled) {
      setStatus({ kind: 'disabled' })
      return
    }
    const abort = new AbortController()
    let live = true
    setStatus({ kind: 'loading' })
    requestJson(VIDEO_TASKS_PATH, {}, abort.signal)
      .then(value => parseVideoTasks(value))
      .then(tasks => { if (live) setStatus({ kind: 'ready', tasks }) })
      .catch((error: unknown) => {
        if (!live || abort.signal.aborted) return
        setStatus({ kind: 'error', detail: errorDetail(error) })
      })
    return () => {
      live = false
      abort.abort()
    }
  }, [reloadKey, videoEnabled])

  /**
   * Clear finished or all tasks of the signed-in account from the local store.
   * Confirmed (the `all` scope deletes everything, including in-flight rows
   * that cannot be re-listed); on success the list reloads so the panel and
   * the cleared store stay in sync. Never contacts the upstream.
   */
  const clearTasks = async (scope: 'done' | 'all'): Promise<void> => {
    if (!videoEnabled || clearState.kind === 'busy') return
    const confirmKey = scope === 'all' ? 'videoClearConfirmAll' : 'videoClearConfirmDone'
    if (!window.confirm(t(confirmKey))) return
    setClearState({ kind: 'busy' })
    try {
      const result = await requestJson(VIDEO_CLEAR_PATH, { method: 'POST', body: { scope } }, new AbortController().signal) as { removed?: unknown }
      const removed = typeof result?.removed === 'number' ? result.removed : 0
      setClearState({ kind: 'done', removed })
      setReloadKey(key => key + 1)
    } catch {
      setClearState({ kind: 'error' })
    }
  }

  const hasTasks = videoEnabled && status.kind === 'ready' && status.tasks.length > 0
  const hasFinished = hasTasks && (status as { tasks: VideoTaskResult[] }).tasks.some(task => task.state === 'done')

  return (
    <section aria-label={t('videoTasksTitle')} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={rowStyle}>
        <h4 style={{ ...titleStyle, fontSize: 13 }}>{t('videoTasksTitle')}</h4>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={buttonStyle} disabled={!videoEnabled || clearState.kind === 'busy' || !hasFinished} onClick={() => { void clearTasks('done') }}>
            {clearState.kind === 'busy' ? t('videoClearBusy') : t('videoClearDone')}
          </button>
          <button type="button" style={buttonStyle} disabled={!videoEnabled || clearState.kind === 'busy' || !hasTasks} onClick={() => { void clearTasks('all') }}>
            {t('videoClearAll')}
          </button>
          <button type="button" style={buttonStyle} disabled={!videoEnabled || status.kind === 'loading'} onClick={() => { if (videoEnabled) setReloadKey(key => key + 1) }}>
            {t('videoTasksRefresh')}
          </button>
        </div>
      </div>
      {videoEnabled ? <p style={hintStyle}>{t('videoTasksIntro')}</p> : null}
      {videoEnabled ? null : <p style={hintStyle}>{t('videoTasksDisabled')}</p>}
      {videoEnabled ? <p style={hintStyle}>{t('resumeHint')}</p> : null}
      {videoEnabled && status.kind === 'loading' ? <p style={bodyStyle}>{t('videoTasksLoading')}</p> : null}
      {videoEnabled && status.kind === 'error' ? (
        <>
          <p style={errorStyle}>{t('videoTasksError')}</p>
          {status.detail === '' ? null : <p style={errorStyle}>{status.detail}</p>}
        </>
      ) : null}
      {clearState.kind === 'done' ? <p role="status" style={{ ...bodyStyle, color: 'var(--dsw-alias-state-success-primary, #22a06b)' }}>{t('videoClearDoneFeedback', { n: String(clearState.removed ?? 0) })}</p> : null}
      {clearState.kind === 'error' ? <p role="alert" style={errorStyle}>{t('videoClearFailed')}</p> : null}
      {videoEnabled && status.kind === 'ready' && status.tasks.length === 0 ? <p style={bodyStyle}>{t('videoTasksEmpty')}</p> : null}
      {hasTasks ? (
        <ul style={listStyle}>
          {(status as { tasks: VideoTaskResult[] }).tasks.map(task => (
            <li key={task.taskId} style={{ listStyle: 'none' }}>
              <VideoMediaCard
                task={task}
                t={t}
                resetToken={task}
                continueEnabled={videoEnabled}
                testId="grok-video-task"
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Capability snapshot panel
// ---------------------------------------------------------------------------
