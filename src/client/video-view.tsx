//

// Part of dsh-grok-kit, Apache-2.0.

//

/**
 * Session result cards for the grok video tools (`grok_video_generate`,
 * `grok_video_status`, `grok_video_resume`), plus the shared video-task
 * contract parsers and lazy media resource that the settings video-task list
 * reuses through {@link VideoMediaCard}.
 *
 * Safety rules baked into this module:
 *   - two explicit user actions, both same-origin, both aborted on unmount:
 *     `POST /plugins/dsh-grok-kit/video/resume` with `{ taskId }` (continues
 *     waiting/downloading for an existing task — never creates one, never
 *     regenerates, never polls on a timer) and `GET
 *     /plugins/dsh-grok-kit/video/file?taskId=<uuid>` (bytes of one `done`
 *     task of the signed-in account, size-checked before and after the read,
 *     capped at MAX_VIDEO_DOWNLOAD_BYTES). No Range request and no extra
 *     backend route: the player and the download button share ONE lazy
 *     {@link VideoBlobResource} — bytes are fetched only after a user action,
 *     simultaneous requests are merged into a single fetch, and every request
 *     and object URL is aborted/revoked when the owner unmounts or the bound
 *     task / account changes.
 *   - no remote media URLs and no local path reads; the `<video>` element only
 *     ever points at a blob object URL minted from those same-origin bytes,
 *     with native `controls` and never autoplays (playback starts from the
 *     user's click).
 *   - the host session channel (`session.readAttachment`) resolves IMAGE
 *     attachments only (verified against the host source: its lookup matches
 *     `type === 'image'` blocks and then calls `attachments.readImage`), and a
 *     `FileAttachmentRef` carries no media type — so that API is never used
 *     here for video bytes; the full file reference is still printed as the
 *     fallback when a download fails.
 *
 * Presentation (shared {@link MediaCardFrame}, same look as the imagine cards):
 * the first view is media + specs + the state actions only. Technical ids,
 * the full attachment reference, the prompt, ISO timestamps, the model and
 * the copy-reference action live inside the collapsed `details` section — the
 * initial view never dumps raw text. A settled `done` card never offers the
 * resume action; `failed` and `submission-unknown` never offer any action
 * that would POST again; "stop waiting" only cancels the local wait and keeps
 * the billing notice.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { MediaCardFrame, mediaCardStyles, type MediaCardTone } from './media-card.tsx'
import { en } from './locales.ts'
import { GROK_VIDEO_FILE_PATH } from '../video-config.ts'
import type { XaiOAuthSettingsKey } from './locales.ts'

/** Translator bound from the settings locale namespace and injected with the slot. */
export type VideoTranslate = (key: XaiOAuthSettingsKey, params?: Record<string, unknown>) => string

/**
 * English fallback for the rare case that the locale service is not bound
 * (tests, or a boot where the namespace was not registered). English — never a
 * hardcoded Chinese string — so an English UI can never show Chinese errors.
 */
export const FALLBACK_TRANSLATE: VideoTranslate = key => en[key]

/** Host tool names this view occupies. */
export const VIDEO_TOOL_NAMES = ['grok_video_generate', 'grok_video_status', 'grok_video_resume'] as const
export type VideoToolName = (typeof VIDEO_TOOL_NAMES)[number]

const RESUME_PATH = '/plugins/dsh-grok-kit/video/resume'

// ---------------------------------------------------------------------------
// Frozen video task contract
// ---------------------------------------------------------------------------

export const VIDEO_TASK_STATES = [
  'pending',
  'downloading',
  'done',
  'failed',
  'interrupted',
  'submission-unknown',
] as const

export type VideoTaskState = (typeof VIDEO_TASK_STATES)[number]

/** `FileAttachmentRef`: file refs carry no media type (host contract). */
export interface VideoTaskAttachment {
  attachmentId: string
  name: string
  bytes: number
}

export interface VideoTaskResult {
  taskId: string
  state: VideoTaskState
  model: string
  createdAt: string
  updatedAt: string
  prompt: string
  duration?: number
  resolution?: string
  attachment?: VideoTaskAttachment
  error?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVideoTaskState(value: unknown): value is VideoTaskState {
  return typeof value === 'string' && (VIDEO_TASK_STATES as readonly string[]).includes(value)
}

/** Parse one task against the frozen contract; malformed tasks yield undefined. */
export function parseVideoTask(value: unknown): VideoTaskResult | undefined {
  if (!isObject(value)) return undefined
  const taskId = value['taskId']
  const state = value['state']
  if (typeof taskId !== 'string' || taskId === '') return undefined
  if (!isVideoTaskState(state)) return undefined
  const rawAttachment = value['attachment']
  const attachment = isObject(rawAttachment)
    && typeof rawAttachment['attachmentId'] === 'string'
    && rawAttachment['attachmentId'] !== ''
    && typeof rawAttachment['name'] === 'string'
    && typeof rawAttachment['bytes'] === 'number'
    && Number.isFinite(rawAttachment['bytes'])
    && rawAttachment['bytes'] >= 0
    ? {
      attachmentId: rawAttachment['attachmentId'],
      name: rawAttachment['name'],
      bytes: rawAttachment['bytes'],
    }
    : undefined
  return {
    taskId,
    state,
    model: typeof value['model'] === 'string' ? value['model'] : '',
    createdAt: typeof value['createdAt'] === 'string' ? value['createdAt'] : '',
    updatedAt: typeof value['updatedAt'] === 'string' ? value['updatedAt'] : '',
    prompt: typeof value['prompt'] === 'string' ? value['prompt'] : '',
    ...typeof value['duration'] === 'number' && Number.isFinite(value['duration']) ? { duration: value['duration'] } : {},
    ...typeof value['resolution'] === 'string' ? { resolution: value['resolution'] } : {},
    ...attachment === undefined ? {} : { attachment },
    ...typeof value['error'] === 'string' && value['error'] !== '' ? { error: value['error'] } : {},
  }
}

/** Parse the `GET /video/tasks` payload (`{ tasks: [...] }`); throws when malformed. */
export function parseVideoTasks(payload: unknown): VideoTaskResult[] {
  if (!isObject(payload) || !Array.isArray(payload['tasks'])) throw new Error('video task list is malformed')
  const tasks: VideoTaskResult[] = []
  for (const raw of payload['tasks']) {
    const task = parseVideoTask(raw)
    if (task !== undefined) tasks.push(task)
  }
  return tasks
}

/**
 * Parse a `POST /video/resume` payload. The frozen contract returns the task
 * itself; the `{ result: task }` wrapper is accepted only as a transitional
 * shape while the host route lands.
 */
export function parseResumePayload(value: unknown): VideoTaskResult | undefined {
  const direct = parseVideoTask(value)
  if (direct !== undefined) return direct
  return isObject(value) ? parseVideoTask(value['result']) : undefined
}

// ---------------------------------------------------------------------------
// Block shape helpers (loose on purpose: the host owns the real definitions)
// ---------------------------------------------------------------------------

interface ContentPart {
  type?: string
  text?: string
  attachment?: unknown
}

export interface VideoToolCallBlock {
  kind?: string
  phase?: string
  call?: { name?: string; argsRaw?: string }
  argsRaw?: string
  name?: string
  content?: ContentPart[]
  isError?: boolean
  callId?: string
  seq?: number
  /** Persisted `presentationMeta`: exactly the VideoTaskResult (host projection). */
  meta?: unknown
}

interface SessionBinding {
  session?: {
    cancel?: () => Promise<{ ok: boolean }>
  }
}

export interface SessionsService {
  binding: (sessionId: string) => SessionBinding | undefined
}

function toolNameOf(block: unknown): VideoToolName {
  if (isObject(block)) {
    const name = isObject(block['call']) ? block['call']['name'] : block['name']
    if (typeof name === 'string' && (VIDEO_TOOL_NAMES as readonly string[]).includes(name)) return name as VideoToolName
  }
  return 'grok_video_generate'
}

function rawArgs(block: unknown): string | undefined {
  if (!isObject(block)) return undefined
  const raw = 'kind' in block && isObject(block['call'])
    ? block['call']['argsRaw']
    : block['argsRaw']
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

function argsOf(block: unknown): Record<string, unknown> | undefined {
  const raw = rawArgs(block)
  if (raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Prompt from the call arguments (used by the pending and failure cards). */
function promptOf(block: unknown): string {
  const args = argsOf(block)
  const prompt = args?.['prompt']
  return typeof prompt === 'string' ? prompt.trim() : ''
}

function textOf(block: unknown): string {
  if (!isObject(block) || !Array.isArray(block['content'])) return ''
  const parts: string[] = []
  for (const part of block['content'] as ContentPart[]) {
    if (!isObject(part)) continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') parts.push(part.text.trim())
  }
  return parts.join('\n\n')
}

/** The task result embedded in a settled tool result. */
function taskOf(block: unknown): VideoTaskResult | undefined {
  if (!isObject(block)) return undefined
  // 1. Persisted presentation metadata — the host's lossless projection of the
  //    VideoTaskResult, written into the session log next to the result.
  const fromMeta = parseVideoTask(block['meta'])
  if (fromMeta !== undefined) return fromMeta
  // 2. A JSON-encoded text part (defensive: replays/older logs).
  if (Array.isArray(block['content'])) {
    for (const part of block['content'] as ContentPart[]) {
      if (!isObject(part) || part.type !== 'text' || typeof part.text !== 'string') continue
      try {
        const task = parseVideoTask(JSON.parse(part.text))
        if (task !== undefined) return task
      } catch {
        // Prose result text — handled by the summary parser below.
      }
    }
  }
  // 3. The model-facing summary line ("Video task <id> is <state> (model …)").
  return parseTaskSummary(textOf(block))
}

const TASK_SUMMARY = /Video task (\S+) is ([a-z-]+)(?: \(model ([^)]*)\))?/
const ATTACHMENT_SUMMARY = /attachment=(\{[^{}]*\})/

/**
 * Last-resort parse of the host's prose summary. Only the fields stated
 * verbatim in that sentence are extracted — nothing is guessed.
 */
export function parseTaskSummary(text: string): VideoTaskResult | undefined {
  const summary = TASK_SUMMARY.exec(text)
  if (summary === null) return undefined
  const attachmentMatch = ATTACHMENT_SUMMARY.exec(text)
  let attachment: unknown
  if (attachmentMatch !== null) {
    try {
      attachment = JSON.parse(attachmentMatch[1])
    } catch {
      attachment = undefined
    }
  }
  return parseVideoTask({
    taskId: summary[1],
    state: summary[2],
    model: summary[3] ?? '',
    ...attachment === undefined ? {} : { attachment },
  })
}

/** File blocks in the result (`{ type: 'file', attachment }`), kept as refs. */
function fileAttachmentsOf(block: unknown): VideoTaskAttachment[] {
  if (!isObject(block) || !Array.isArray(block['content'])) return []
  const refs: VideoTaskAttachment[] = []
  for (const part of block['content'] as ContentPart[]) {
    if (!isObject(part) || part.type !== 'file') continue
    const parsed = parseVideoTask({ taskId: 'ref', state: 'done', attachment: part.attachment })
    const attachment = parsed?.attachment
    if (attachment !== undefined) refs.push(attachment)
  }
  return refs
}

/**
 * All file references of one card, deduplicated by `attachmentId`: the
 * structured task's attachment wins over a `file` block carrying the same id,
 * and genuinely different attachments are all kept.
 */
export function collectVideoAttachments(task: VideoTaskResult | undefined, block: unknown): VideoTaskAttachment[] {
  const byId = new Map<string, VideoTaskAttachment>()
  if (task?.attachment !== undefined) byId.set(task.attachment.attachmentId, task.attachment)
  for (const attachment of fileAttachmentsOf(block)) {
    if (!byId.has(attachment.attachmentId)) byId.set(attachment.attachmentId, attachment)
  }
  return [...byId.values()]
}

export function formatBytes(bytes: number): string {
  if (bytes < 1e3) return `${String(bytes)} B`
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(bytes < 1e4 ? 1 : 0)} KB`
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`
}

// ---------------------------------------------------------------------------
// Lazy video file download (same-origin host route, bounded, abortable)
// ---------------------------------------------------------------------------

/**
 * Same-origin byte route owned by the host plugin: `GET ?taskId=<uuid>`.
 * It only serves `done` tasks of the signed-in account — no arbitrary path or
 * attachment id is ever accepted by this client.
 */
export const VIDEO_FILE_PATH = GROK_VIDEO_FILE_PATH
/** Client-side ceiling; a larger reported size is refused before any request. */
export const MAX_VIDEO_DOWNLOAD_BYTES = 100 * 1024 * 1024

export function videoFileUrl(taskId: string): string {
  return `${VIDEO_FILE_PATH}?taskId=${encodeURIComponent(taskId)}`
}

function guessVideoMediaType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.mov') || lower.endsWith('.qt')) return 'video/quicktime'
  if (lower.endsWith('.mkv')) return 'video/x-matroska'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4'
  return 'application/octet-stream'
}

function triggerDownload(url: string, name: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.append(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
  }
}

/** Read the body while refusing anything past `limit` (never buffers unbounded). */
async function readCapped(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const body = response.body
  // A body-less response cannot be streamed, and falling back to blob() would
  // only validate the size AFTER buffering — so it is refused outright.
  if (body === null) throw new Error('response has no readable stream; download aborted')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (chunk.value === undefined) continue
    total += chunk.value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`response exceeds the ${formatBytes(limit)} streaming cap`)
    }
    chunks.push(chunk.value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Fetch one finished task's video file: size pre-check against the reported
 * `attachment.bytes`, a hard 100 MiB read cap, and a length check on the bytes
 * actually received. Rejects with a human-readable reason on any mismatch.
 */
export async function fetchVideoFile(task: VideoTaskResult, signal: AbortSignal): Promise<Blob> {
  const attachment = task.attachment
  if (attachment === undefined) throw new Error('attachment missing: the task has no stored file reference')
  if (task.state !== 'done') throw new Error('only finished (done) tasks can be downloaded')
  if (attachment.bytes > MAX_VIDEO_DOWNLOAD_BYTES) {
    throw new Error(`file ${formatBytes(attachment.bytes)} exceeds the ${formatBytes(MAX_VIDEO_DOWNLOAD_BYTES)} client limit`)
  }
  const response = await fetch(videoFileUrl(task.taskId), {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/octet-stream' },
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const data = await readCapped(response, MAX_VIDEO_DOWNLOAD_BYTES)
  if (attachment.bytes > 0 && data.byteLength !== attachment.bytes) {
    throw new Error(`length mismatch: expected ${String(attachment.bytes)} bytes, received ${String(data.byteLength)} bytes`)
  }
  return new Blob([data], { type: guessVideoMediaType(attachment.name) })
}

// ---------------------------------------------------------------------------
// Shared lazy media resource (player + download use the same bytes)
// ---------------------------------------------------------------------------

export interface VideoBlobResource {
  /**
   * Fetch the bytes once: simultaneous callers share the same in-flight
   * request and the same resolved blob; a later call reuses the cache.
   */
  load: () => Promise<Blob>
  /** Object URL of the loaded blob (minted once, revoked by `dispose`). */
  objectUrl: () => string | undefined
  /** Abort the request and revoke every object URL this resource minted. */
  dispose: () => void
}

/**
 * One task's lazily fetched video bytes, shared by the player and the download
 * button. Nothing is requested until `load()` (a user action); concurrent
 * `load()` calls merge into a single fetch; `dispose()` aborts the in-flight
 * request and revokes all object URLs (unmount, task switch, account switch).
 * Disposing never poisons the resource: the owner that disposed it is gone or
 * rebound, so a stray later `load()` simply starts over.
 */
export function createVideoBlobResource(loader: (signal: AbortSignal) => Promise<Blob>): VideoBlobResource {
  let inflight: Promise<Blob> | undefined
  let controller: AbortController | undefined
  let cached: Blob | undefined
  let url: string | undefined
  let generation = 0
  const load = (): Promise<Blob> => {
    if (cached !== undefined) return Promise.resolve(cached)
    if (inflight !== undefined) return inflight
    const active = new AbortController()
    controller = active
    const epoch = generation
    const started = loader(active.signal).then(
      blob => {
        active.signal.throwIfAborted()
        if (epoch !== generation) throw new DOMException('Media resource was disposed', 'AbortError')
        cached = blob
        inflight = undefined
        return blob
      },
      (error: unknown) => {
        if (epoch === generation) inflight = undefined
        throw error
      },
    )
    inflight = started
    return started
  }
  return {
    load,
    objectUrl: () => {
      if (cached === undefined) return undefined
      if (url === undefined) url = URL.createObjectURL(cached)
      return url
    },
    dispose: () => {
      generation += 1
      controller?.abort()
      controller = undefined
      inflight = undefined
      cached = undefined
      if (url !== undefined) {
        URL.revokeObjectURL(url)
        url = undefined
      }
    },
  }
}

interface VideoBlobEntry {
  key: string
  resource: VideoBlobResource
}

/**
 * The {@link VideoBlobResource} bound to the current task: rebuilt (and the
 * previous one disposed) when the task id changes, disposed again on unmount —
 * which also covers an account switch, because the settings page remounts the
 * account subtree with a fresh key. The loader always reads the *latest* task
 * so a task that completes after the card mounted still downloads correctly.
 */
export function useVideoBlobResource(task: VideoTaskResult | undefined): VideoBlobResource | undefined {
  const holder = useRef<VideoBlobEntry | undefined>(undefined)
  const latest = useRef<VideoTaskResult | undefined>(task)
  latest.current = task
  const key = task?.taskId
  if (key === undefined) {
    if (holder.current !== undefined) {
      holder.current.resource.dispose()
      holder.current = undefined
    }
  } else if (holder.current?.key !== key) {
    holder.current?.resource.dispose()
    holder.current = {
      key,
      resource: createVideoBlobResource(signal => {
        const current = latest.current
        if (current === undefined) return Promise.reject(new Error('no task is bound to the media resource'))
        return fetchVideoFile(current, signal)
      }),
    }
  }
  const resource = key === undefined ? undefined : holder.current?.resource
  // Capture the owned resource, rather than clearing a shared ref during cleanup:
  // React's effect replay must still dispose loads started after that replay.
  useEffect(() => () => { resource?.dispose() }, [resource])
  return resource
}

// ---------------------------------------------------------------------------
// Small detail styles (host `--dsw-alias-*` tokens; no external assets)
// ---------------------------------------------------------------------------

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 }
const labelStyle: CSSProperties = { ...mediaCardStyles.muted, flex: '0 0 auto' }
const valueStyle: CSSProperties = { fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)', fontSize: 12, overflowWrap: 'anywhere', minWidth: 0 }

const TASK_STATE_TONE: Record<VideoTaskState, MediaCardTone> = {
  pending: 'busy',
  downloading: 'busy',
  done: 'success',
  failed: 'error',
  interrupted: 'neutral',
  'submission-unknown': 'neutral',
}

/** Task state label from the shared settings locale (zh/en, no hardcoded copy). */
function taskStateLabel(t: VideoTranslate, state: VideoTaskState | undefined): string {
  switch (state) {
    case 'pending': return t('taskStatePending')
    case 'downloading': return t('taskStateDownloading')
    case 'done': return t('taskStateDone')
    case 'failed': return t('taskStateFailed')
    case 'interrupted': return t('taskStateInterrupted')
    case 'submission-unknown': return t('taskStateSubmissionUnknown')
    default: return t('videoCardStateUnknown')
  }
}

/** Pending card title for the tool currently running. */
function pendingTitle(t: VideoTranslate, name: VideoToolName): string {
  switch (name) {
    case 'grok_video_status': return t('videoCardPendingStatus')
    case 'grok_video_resume': return t('videoCardPendingResume')
    default: return t('videoCardPendingGenerate')
  }
}

const SOURCE_LABEL = 'Grok Video'

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ActionButton({ t, label, onClick, disabled, primary }: { t: VideoTranslate; label: string; onClick: () => Promise<unknown>; disabled?: boolean; primary?: boolean }) {
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  return (
    <button
      type="button"
      style={{ ...mediaCardStyles.action, ...primary === true ? mediaCardStyles.primaryAction : {} }}
      disabled={disabled === true || state === 'pending'}
      aria-busy={state === 'pending'}
      onClick={() => {
        if (state === 'pending' || disabled === true) return
        setState('pending')
        Promise.resolve().then(onClick).then(() => {
          if (alive.current) setState('idle')
        }).catch(() => {
          if (alive.current) setState('failed')
        })
      }}
    >
      {state === 'pending' ? t('working') : state === 'failed' ? t('actionFailed') : label}
    </button>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value}</span>
    </div>
  )
}

function PromptDetail({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <strong style={{ fontSize: 12, fontWeight: 600 }}>{title}</strong>
      <p style={mediaCardStyles.prompt}>{text}</p>
    </div>
  )
}

/** One file reference block (name / size / id / full ref / copy action). */
function AttachmentDetail({ attachment, t }: { attachment: VideoTaskAttachment; t: VideoTranslate }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  useEffect(() => {
    if (copied === 'idle') return
    const timer = window.setTimeout(() => { setCopied('idle') }, 2000)
    return () => { window.clearTimeout(timer) }
  }, [copied])
  return (
    <div data-testid="grok-video-attachment-ref" aria-label={t('videoCardAriaFileRef')} style={{ display: 'grid', gap: 6 }}>
      <strong style={{ fontSize: 12, fontWeight: 600 }}>{t('videoCardFile')}</strong>
      <div style={rowStyle}>
        <span style={labelStyle}>{t('videoCardFileName')}</span>
        <span style={valueStyle}>{attachment.name}</span>
        <span style={labelStyle}>{t('videoCardFileSize')}</span>
        <span style={valueStyle}>{formatBytes(attachment.bytes)}</span>
      </div>
      <DetailRow label="attachmentId" value={attachment.attachmentId} />
      <DetailRow label={t('videoAttachmentRef')} value={JSON.stringify(attachment)} />
      <div>
        <ActionButton
          t={t}
          label={copied === 'ok' ? t('videoCardCopied') : copied === 'fail' ? t('videoCardCopyFailed') : t('videoCardCopyRef')}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify(attachment))
              setCopied('ok')
            } catch {
              setCopied('fail')
              throw new Error('clipboard unavailable')
            }
          }}
        />
      </div>
      <span style={labelStyle}>{t('videoCardRefNote')}</span>
    </div>
  )
}

/** Pending (unsettled) call: media slot + local stop with the billing note. */
function VideoPendingCard({ block, sessionId, sessions, t: translate }: VideoCardProps) {
  const t = translate ?? FALLBACK_TRANSLATE
  const prompt = promptOf(block)
  const canCancel = typeof sessionId === 'string' && typeof sessions?.binding === 'function'
  return (
    <MediaCardFrame
      testId="grok-video-pending"
      ariaLabel={t('videoCardAriaRunning')}
      title={SOURCE_LABEL}
      status={pendingTitle(t, toolNameOf(block))}
      statusTone="busy"
      summary={prompt === '' ? t('videoCardReceivingArgs') : undefined}
      preview={(
        <div style={mediaCardStyles.preview}>
          <progress style={{ width: '100%', height: 4 }} />
        </div>
      )}
      actions={canCancel
        ? (
            <ActionButton
              t={t}
              label={t('videoCardStopWaiting')}
              onClick={async () => {
                const accepted = await sessions!.binding(sessionId!)?.session?.cancel?.()
                if (accepted?.ok !== true) throw new Error('cancel failed')
              }}
            />
          )
        : undefined}
      notice={t('resumeHint')}
      detailsLabel={t('videoUiDetails')}
      details={prompt === '' ? undefined : <PromptDetail title={t('videoCardPrompt')} text={prompt} />}
    />
  )
}

/** Errored call: keep the host error visible and the prompt folded away. */
function VideoFailureCard({ block, t: translate }: VideoCardProps) {
  const t = translate ?? FALLBACK_TRANSLATE
  const prompt = promptOf(block)
  const text = textOf(block)
  return (
    <MediaCardFrame
      testId="grok-video-failure"
      ariaLabel={t('videoCardFailureTitle')}
      title={SOURCE_LABEL}
      status={t('videoCardFailureTitle')}
      statusTone="error"
      notice={text === '' ? undefined : text}
      detailsLabel={t('videoUiDetails')}
      details={prompt === '' ? undefined : <PromptDetail title={t('videoCardPrompt')} text={prompt} />}
    />
  )
}

export interface VideoMediaCardProps {
  /** Settled tool-call block: prompt fallback, result text and file blocks. */
  block?: unknown
  /** Structured task (presentationMeta / JSON result / settings task list). */
  task?: VideoTaskResult
  /** Locale translator injected with the slot; English fallback when absent. */
  t?: VideoTranslate
  /** Changing it drops a locally applied query/resume result (refresh wins). */
  resetToken?: unknown
  /** Gate for the query/resume action (settings: video tool must be enabled). */
  continueEnabled?: boolean
  testId?: string
}

/**
 * The one media-first card shared by the session toolview and the settings
 * video-task list: media + specs + state actions in the first view; ids, full
 * ref, prompt, model and ISO times folded into `details`.
 *
 * State actions: `done` → play + download (download is the primary action, no
 * resume ever); `pending` / `downloading` → query; `interrupted` → resume;
 * `failed` / `submission-unknown` → nothing that could POST again.
 */
export function VideoMediaCard({ block, task: reported, t: translate, resetToken, continueEnabled = true, testId }: VideoMediaCardProps) {
  const t = translate ?? FALLBACK_TRANSLATE
  const [override, setOverride] = useState<VideoTaskResult | undefined>(undefined)
  const [continueState, setContinueState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [playing, setPlaying] = useState(false)
  const [blobState, setBlobState] = useState<'idle' | 'busy' | 'error'>('idle')
  const [blobError, setBlobError] = useState<string | undefined>(undefined)
  const [downloaded, setDownloaded] = useState(false)
  const abort = useRef<AbortController | undefined>(undefined)
  const mounted = useRef(true)
  const playbackStarted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      abort.current?.abort()
    }
  }, [])
  // Refresh or task replacement wins over both applied and in-flight results.
  useEffect(() => {
    abort.current?.abort()
    setOverride(undefined)
    setContinueState('idle')
  }, [resetToken, reported?.taskId])
  useEffect(() => {
    playbackStarted.current = false
    setPlaying(false)
    setBlobState('idle')
    setBlobError(undefined)
    setDownloaded(false)
  }, [reported?.taskId])

  const task = override ?? reported
  const resource = useVideoBlobResource(task)
  // Task identity of the currently bound media resource. A load started for one
  // task settles after the card has been rebound to another one: the old
  // resource is disposed, so the load can only ever end in an error, and that
  // error belongs to a task the card no longer shows. Same isolation the
  // query/resume path gets from the controller identity in `continueTask`.
  const boundTaskId = useRef<string | undefined>(task?.taskId)
  boundTaskId.current = task?.taskId
  const attachments = collectVideoAttachments(task, block)
  const resultText = textOf(block)
  const prompt = task?.prompt !== undefined && task.prompt !== '' ? task.prompt : promptOf(block)

  if (task === undefined && attachments.length === 0 && resultText === '') return null

  const attachment = attachments[0]
  const canPlay = task?.state === 'done' && attachment !== undefined
  const canContinue = task !== undefined
    && (task.state === 'pending' || task.state === 'downloading' || task.state === 'interrupted')
  const stateLabel = taskStateLabel(t, task?.state)

  /** The bound task must still be the one this card renders. */
  const stillBound = (boundId: string | undefined): boolean => mounted.current && boundTaskId.current === boundId

  const loadMedia = async (): Promise<void> => {
    if (resource === undefined || blobState === 'busy') return
    const boundId = task?.taskId
    setBlobState('busy')
    setBlobError(undefined)
    try {
      await resource.load()
      if (!stillBound(boundId)) return
      setPlaying(true)
      setBlobState('idle')
    } catch (error: unknown) {
      if (!stillBound(boundId)) return
      setBlobError(error instanceof Error ? error.message : String(error))
      setBlobState('error')
    }
  }

  const download = async (): Promise<void> => {
    if (resource === undefined || task === undefined || blobState === 'busy') return
    const boundId = task.taskId
    setBlobState('busy')
    setBlobError(undefined)
    try {
      await resource.load()
      if (!stillBound(boundId)) return
      const url = resource.objectUrl()
      if (url !== undefined) triggerDownload(url, task.attachment?.name ?? `grok-video-${task.taskId}`)
      setDownloaded(true)
      setBlobState('idle')
    } catch (error: unknown) {
      if (!stillBound(boundId)) return
      setBlobError(error instanceof Error ? error.message : String(error))
      setBlobState('error')
    }
  }

  /** Query/resume: `POST /video/resume` for one existing task — never a new one. */
  const continueTask = async (): Promise<void> => {
    if (task === undefined || continueState === 'busy' || !continueEnabled) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setContinueState('busy')
    try {
      const response = await fetch(RESUME_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ taskId: task.taskId }),
        signal: controller.signal,
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const updated = parseResumePayload(value)
      if (controller.signal.aborted || !mounted.current || abort.current !== controller) return
      if (updated !== undefined) setOverride(updated)
      setContinueState('done')
    } catch {
      if (controller.signal.aborted || !mounted.current) return
      setContinueState('error')
    }
  }

  // Preview: a user click loads the shared blob and plays it with native
  // controls; nothing is fetched and nothing autoplays before that click.
  let preview: ReactNode
  if (canPlay) {
    const url = resource?.objectUrl()
    preview = playing && url !== undefined
      ? (
          <video
            controls
            playsInline
            preload="metadata"
            src={url}
            data-testid="grok-video-player"
            aria-label={t('videoCardAriaResult')}
            ref={(element: HTMLVideoElement | null) => {
              // Playback starts from the user's click only (the card never
              // autoplays): the ref fires once per loaded element.
              if (element !== null && !playbackStarted.current) {
                playbackStarted.current = true
                void element.play().catch(() => undefined)
              }
            }}
            style={{ display: 'block', width: '100%', maxHeight: 380, borderRadius: 12, background: 'var(--dsw-alias-bg-base)' }}
          />
        )
      : (
          <button
            type="button"
            data-testid="grok-video-preview"
            aria-label={t('videoUiPlay')}
            title={t('videoUiLoadVideo')}
            disabled={blobState === 'busy'}
            onClick={() => { void loadMedia() }}
            style={{ ...mediaCardStyles.preview, width: '100%', cursor: 'pointer', font: 'inherit' }}
          >
            <span aria-hidden style={{ fontSize: 26, lineHeight: 1 }}>▶</span>
            <span style={mediaCardStyles.muted}>{blobState === 'busy' ? t('videoUiLoading') : t('videoUiPlay')}</span>
          </button>
        )
  } else if (task?.state === 'pending' || task?.state === 'downloading') {
    preview = (
      <div style={mediaCardStyles.preview}>
        <progress style={{ width: '100%', height: 4 }} />
      </div>
    )
  } else {
    preview = (
      <div style={mediaCardStyles.preview}>
        <span style={mediaCardStyles.muted}>{stateLabel}</span>
      </div>
    )
  }

  const summaryParts: string[] = []
  if (task?.resolution !== undefined) summaryParts.push(task.resolution)
  if (task?.duration !== undefined) summaryParts.push(`${String(task.duration)}s`)
  for (const ref of attachments) summaryParts.push(`${ref.name} · ${formatBytes(ref.bytes)}`)
  const summary = summaryParts.length === 0
    ? undefined
    : summaryParts.map((part, index) => <span key={`${String(index)}:${part}`}>{part}</span>)

  const actions: ReactNode = (
    <>
      {canPlay
        ? (
            <>
              <ActionButton
                t={t}
                primary
                label={blobState === 'busy' ? t('videoDownloadBusy') : downloaded ? t('videoCardRedownload') : t('videoDownload')}
                onClick={download}
              />
            </>
          )
        : null}
      {canContinue && task !== undefined
        ? (
            <ActionButton
              t={t}
              label={task.state === 'interrupted' ? t('videoUiResume') : t('videoUiQuery')}
              onClick={continueTask}
              disabled={!continueEnabled}
            />
          )
        : null}
    </>
  )

  const notice: ReactNode = (
    <>
      {task?.error !== undefined && (task.state === 'failed' || task.state === 'interrupted' || task.state === 'submission-unknown')
        ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{task.error}</span>
        : null}
      {blobError === undefined ? null : <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{`${t('videoDownloadFailed')} ${blobError}`}</span>}
      {continueState === 'done' ? <span style={{ color: 'var(--dsw-alias-state-success-primary)' }}>{t('videoCardResumeDone')}</span> : null}
      {continueState === 'error' ? <span style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{t('videoCardResumeFailed')}</span> : null}
    </>
  )

  const details: ReactNode = (
    <>
      {prompt === '' ? null : <PromptDetail title={t('videoCardPrompt')} text={prompt} />}
      {task === undefined ? null : <DetailRow label="taskId" value={task.taskId} />}
      {task?.model === undefined || task.model === '' ? null : <DetailRow label={t('videoCardModel')} value={task.model} />}
      {task?.createdAt === undefined || task.createdAt === '' ? null : <DetailRow label={t('videoCardCreated')} value={task.createdAt} />}
      {task?.updatedAt === undefined || task.updatedAt === '' ? null : <DetailRow label={t('videoCardUpdated')} value={task.updatedAt} />}
      {resultText === '' || task !== undefined ? null : <PromptDetail title={t('videoCardResult')} text={resultText} />}
      {attachments.map(ref => <AttachmentDetail key={ref.attachmentId} attachment={ref} t={t} />)}
      {task === undefined && attachments.length > 0 ? <span style={labelStyle}>{t('videoCardFileOnly')}</span> : null}
      <span style={labelStyle}>{t('resumeHint')}</span>
      <span style={labelStyle}>{t('videoCardDownloadNote')}</span>
    </>
  )

  return (
    <MediaCardFrame
      testId={testId ?? 'grok-video-result'}
      ariaLabel={t('videoCardAriaResult')}
      title={SOURCE_LABEL}
      status={stateLabel}
      statusTone={task === undefined ? 'neutral' : TASK_STATE_TONE[task.state]}
      summary={summary}
      preview={preview}
      actions={canPlay || canContinue ? actions : undefined}
      notice={blobError !== undefined || continueState === 'done' || continueState === 'error'
        || (task?.error !== undefined && (task.state === 'failed' || task.state === 'interrupted' || task.state === 'submission-unknown'))
        ? notice
        : undefined}
      detailsLabel={t('videoUiDetails')}
      details={details}
    />
  )
}

export interface VideoCardProps {
  block: unknown
  sessionId?: string
  sessions?: SessionsService
  /** Locale translator injected with the slot; English fallback when absent. */
  t?: VideoTranslate
  owner?: { block: unknown }
}

function GrokVideoToolView(rawProps: VideoCardProps) {
  const props = rawProps.owner !== undefined ? { ...rawProps, block: rawProps.owner.block } : rawProps
  const settled = isObject(props.block) && 'kind' in (props.block as Record<string, unknown>)
  if (!settled) return <VideoPendingCard {...props} />
  if ((props.block as VideoToolCallBlock).isError === true) return <VideoFailureCard {...props} />
  return <VideoMediaCard block={props.block} task={taskOf(props.block)} t={props.t} />
}

// ---------------------------------------------------------------------------
// Slot wiring
// ---------------------------------------------------------------------------

/**
 * Register the toolview occupant for all three grok video tools. Called from
 * the client entry; the registrations live in a `sessions` child fiber so they
 * unload with it (same shape as `applyImagineViews`).
 *
 * The translator is bound from the plugin's existing settings locale namespace
 * (`settings.xai-oauth`, registered with zh + en by the client entry) so the
 * cards follow the host language. If the locale service is not available the
 * views fall back to the English copy — never to hardcoded Chinese.
 */
export function applyVideoViews(ctx: Context): void {
  const t: VideoTranslate = typeof ctx.locale?.bind === 'function'
    ? ctx.locale.bind('settings.xai-oauth') as VideoTranslate
    : FALLBACK_TRANSLATE
  ctx.inject(['sessions'], scope => {
    const sessions = scope.sessions as SessionsService
    for (const key of VIDEO_TOOL_NAMES) {
      scope.slots.inject('tool.call.toolview', () => scope.slots.register({
        name: 'tool.call.toolview',
        key,
        inject: () => ({ sessions, t }),
      }, GrokVideoToolView))
    }
  })
}
