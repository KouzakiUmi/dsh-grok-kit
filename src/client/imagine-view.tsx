//
// Merged from the former standalone plugin `dsh-grok-imagine-ui` (v0.1.0),
// including its two production fixes:
//   - render grok_imagine_edit alongside grok_imagine (REVERT-edit-tool-support.md)
//   - never return null for save_path calls: fall back to a text card
//     (FIX-null-render-save-path.md)
//
// Redesigned on the shared MediaCardFrame (media-card.tsx): done cards are
// media-first (gallery with a bounded max width, primary view/download),
// while prompt / raw result / full attachment refs / technical info sit in
// the collapsed details. Pending and failure cards reuse the same frame with
// localized, honest feedback. All copy comes from the `imageUi*` locale keys
// with an English fallback when no translator is bound — never hardcoded
// Chinese.
//

/** Session image viewer for grok_imagine / grok_imagine_edit results. */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { en } from './locales.ts'
import type { XaiOAuthSettingsKey } from './locales.ts'
import { MediaCardFrame, mediaCardStyles } from './media-card.tsx'

const TOOL_NAME = 'grok_imagine'
/** This view renders both text-to-image and image-to-image; the latter is registered as grok_imagine_edit. */
const TOOL_NAMES = new Set(['grok_imagine', 'grok_imagine_edit'])
/**
 * Codex-line image tool. Not rendered here (dsh-codex-connect draws its own
 * cards); only counted at the turn tail for the purple/green source legend.
 */
const CODEX_TOOL_NAMES = new Set(['codex_connect_image_generate'])

/** Translator bound from the settings locale namespace and injected with the slot. */
export type ImagineTranslate = (key: XaiOAuthSettingsKey, params?: Record<string, unknown>) => string

/**
 * English fallback for the rare case that the locale service is not bound
 * (tests, or a boot where the namespace was not registered). English — never a
 * hardcoded Chinese string — so an English UI can never show Chinese copy.
 */
export const FALLBACK_TRANSLATE: ImagineTranslate = key => en[key]

// ---------------------------------------------------------------------------
// Block shapes (loose on purpose: the host owns the real definitions)
// ---------------------------------------------------------------------------

interface ContentPart {
  type?: string
  text?: string
  attachment?: unknown
}

export interface ToolCallBlock {
  kind?: string
  phase?: string
  call?: { name?: string; argsRaw?: string }
  argsRaw?: string
  name?: string
  content?: ContentPart[]
  isError?: boolean
  callId?: string
  seq?: number
  subCalls?: unknown[]
}

interface ExternalStore<T> {
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => T
}

interface SessionBinding {
  session?: {
    readAttachment?: (attachmentId: string) => Promise<{
      ok: boolean
      value?: { attachment: { attachmentId: string; mediaType: string }; data: Uint8Array }
    }>
    prompt?: (parts: Array<{ type: string; text: string }>, mode: string) => Promise<{ ok: boolean }>
    cancel?: () => Promise<{ ok: boolean }>
  }
}

interface SessionsService {
  binding: (sessionId: string) => SessionBinding | undefined
}

interface ChatNodes {
  turnDataSource?: (turn: unknown, kind: string) => ExternalStore<ToolCallBlock[]>
  // Real shape: location is a ConversationLocation whose turn branch carries a
  // TurnLocation object, so the numeric id lives at location.turn.turn.
  values?: () => readonly { kind: string; location?: { turn?: { turn?: number } }; data?: unknown }[]
}

interface ChatState {
  nodes: ChatNodes
}

interface UseChat {
  (selector: (chat: ChatState) => ChatState): ChatState
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toolNameOf(block: unknown): string {
  if (isObject(block)) {
    const name = isObject(block.call) ? block.call.name : block.name
    if (typeof name === 'string' && TOOL_NAMES.has(name)) return name
  }
  return TOOL_NAME
}

function argsOf(block: unknown): Record<string, unknown> | undefined {
  if (!isObject(block)) return undefined
  const raw = 'kind' in block && isObject(block.call)
    ? block.call.argsRaw
    : block.argsRaw
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Edit results have no "regenerate" semantics; re-edit the same input image instead. */
export function regenerateText(toolName: string, prompt: string, args: Record<string, unknown> | undefined, t: ImagineTranslate = FALLBACK_TRANSLATE): string {
  if (toolName !== 'grok_imagine_edit') return `${t('imageUiRegenerateText')}\n${prompt}`
  const sources = [args?.image, ...(Array.isArray(args?.images) ? args.images : [])]
    .filter((source): source is string => typeof source === 'string' && source.trim().length > 0)
    .map(source => source.trim())
  const hint = sources.length > 0 && sources.every(source => source.length <= 400)
    ? `${t('imageUiEditSources')}${JSON.stringify(sources)}`
    : t('imageUiEditSourcesFallback')
  const settings = Object.fromEntries(['aspect_ratio', 'resolution', 'n']
    .filter(key => args?.[key] !== undefined).map(key => [key, args![key]]))
  return `${t('imageUiEditIntro')}${hint}${t('imageUiEditSettings')}${JSON.stringify(settings)}${t('imageUiEditKeepPrompt')}\n${prompt}`
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_STEP = 0.5

/** Bounded box for the media gallery: media-first, but never full-bleed. */
const GALLERY_MAX_WIDTH = 520
/** Text blocks (prompt / raw result) keep the shared prompt style plus a boxed chrome. */
const blockStyle: CSSProperties = {
  ...mediaCardStyles.prompt,
  boxSizing: 'border-box',
  width: '100%',
  maxHeight: 160,
  overflowY: 'auto',
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
}
const sectionHeading: CSSProperties = { fontSize: 13, fontWeight: 600 }

/**
 * Source badge. Grok and Codex image cards look alike in a session, so the
 * card must identify itself: this view renders the Grok line (purple dot);
 * the Codex line is rendered by dsh-codex-connect (green dot is reserved).
 * The turn-tail legend below depends on this purple dot staying on the card.
 */
const SOURCE_TONES = { grok: '#7c3aed', codex: '#10a37f' }
const SOURCE_LABEL = 'Grok Imagine'

function sourceBadge(label: string, tone: string): ReactNode {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <i aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: tone }} />
      <strong style={{ fontSize: 13, fontWeight: 600 }}>{label}</strong>
    </span>
  )
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

interface ImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

function imageRef(value: unknown): ImageRef | undefined {
  if (!isObject(value)) return undefined
  if (typeof value.attachmentId !== 'string' || value.attachmentId === '') return undefined
  if (typeof value.mediaType !== 'string' || !IMAGE_MEDIA_TYPES.has(value.mediaType)) return undefined
  if (!positiveInteger(value.bytes) || !positiveInteger(value.width) || !positiveInteger(value.height)) return undefined
  return {
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes as number,
    width: value.width as number,
    height: value.height as number,
    ...typeof value.name === 'string' ? { name: value.name } : {},
  }
}

function imageAttachments(block: unknown): ImageRef[] {
  if (!isObject(block) || !('kind' in block) || !Array.isArray(block.content)) return []
  const images: ImageRef[] = []
  const seen = new Set<string>()
  for (const part of block.content as ContentPart[]) {
    if (!isObject(part) || part.type !== 'image') continue
    const ref = imageRef(part.attachment)
    if (ref === undefined) return []
    // The same attachment can be repeated inside one result; dedupe by
    // attachmentId while keeping every distinct real image.
    if (seen.has(ref.attachmentId)) continue
    seen.add(ref.attachmentId)
    images.push(ref)
  }
  return images
}

/** Local input references from the call args (image plus images[]). */
function inputSources(block: unknown): string[] {
  const args = argsOf(block)
  if (args === undefined) return []
  return [args.image, ...(Array.isArray(args.images) ? args.images : [])]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
}

function promptOf(block: unknown): string {
  if (!isObject(block)) return ''
  const raw = 'kind' in block && isObject(block.call)
    ? block.call.argsRaw
    : block.argsRaw
  if (typeof raw !== 'string' || raw === '') return ''
  try {
    const parsed: unknown = JSON.parse(raw)
    return isObject(parsed) && typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Text of the result block.
 * `save_path` is rejected before any request and results always land in the
 * attachment library, but failure blocks and text-only results still carry
 * text — returning null here would make the whole tool call vanish from the
 * conversation.
 */
function textOf(block: unknown): string {
  if (!isObject(block) || !('kind' in block) || !Array.isArray(block.content)) return ''
  const parts: string[] = []
  for (const part of block.content as ContentPart[]) {
    if (!isObject(part)) continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') parts.push(part.text.trim())
  }
  return parts.join('\n\n')
}

function formatBytes(bytes: number): string {
  if (bytes < 1e3) return `${String(bytes)} B`
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(bytes < 1e4 ? 1 : 0)} KB`
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`
}

function formatMediaType(mediaType: string): string {
  return mediaType === 'image/jpeg' ? 'JPEG' : mediaType.slice(6).toUpperCase()
}

function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return 'png'
  }
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

// ---------------------------------------------------------------------------
// Image loading (blob URLs per session, cached and revoked)
// ---------------------------------------------------------------------------

function useImageLoader(sessionId: string | undefined, sessions: SessionsService | undefined) {
  const urls = useRef(new Map<string, { sessionId: string; url: string }>())
  const pending = useRef(new Map<string, Promise<string>>())
  const activeSession = useRef(sessionId)
  const disposed = useRef(false)
  activeSession.current = sessionId
  useEffect(() => {
    disposed.current = false
    return () => {
      disposed.current = true
      for (const entry of urls.current.values()) URL.revokeObjectURL(entry.url)
      urls.current.clear()
    }
  }, [])
  useEffect(() => () => {
    for (const [key, entry] of urls.current) {
      if (entry.sessionId !== sessionId) continue
      URL.revokeObjectURL(entry.url)
      urls.current.delete(key)
    }
  }, [sessionId])
  return useCallback(async (attachment: Pick<ImageRef, 'attachmentId'>): Promise<string> => {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof sessions?.binding !== 'function') throw new Error('Image session is unavailable')
    const key = `${sessionId}\0${attachment.attachmentId}`
    const cached = urls.current.get(key)
    if (cached !== undefined) return cached.url
    const inflight = pending.current.get(key)
    if (inflight !== undefined) return inflight
    const request = (async () => {
      const result = await sessions.binding(sessionId)?.session?.readAttachment?.(attachment.attachmentId)
      if (result?.ok !== true || result.value?.attachment.attachmentId !== attachment.attachmentId) throw new Error('Image attachment could not be read')
      if (disposed.current || activeSession.current !== sessionId) throw new Error('Image view is no longer active')
      const bytes = result.value.data.slice().buffer
      const url = URL.createObjectURL(new Blob([bytes], { type: result.value.attachment.mediaType }))
      urls.current.set(key, { sessionId, url })
      return url
    })().finally(() => {
      pending.current.delete(key)
    })
    pending.current.set(key, request)
    return request
  }, [sessionId, sessions])
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ImagineLightbox({ src, alt, onClose, t: translate }: { src: string; alt: string; onClose: () => void; t: ImagineTranslate }) {
  const t = translate ?? FALLBACK_TRANSLATE
  const dialog = useRef<HTMLDialogElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ pointerId: number; clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    const node = dialog.current
    if (node === null) return
    if (typeof node.showModal === 'function' && !node.open) node.showModal()
    const onCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    node.addEventListener('cancel', onCancel)
    return () => {
      node.removeEventListener('cancel', onCancel)
      if (node.open) node.close()
    }
  }, [onClose])
  useEffect(() => {
    if (zoom !== MIN_ZOOM || viewport.current === null) return
    viewport.current.scrollLeft = 0
    viewport.current.scrollTop = 0
  }, [zoom])
  const button: CSSProperties = {
    minWidth: 32,
    height: 32,
    padding: '0 8px',
    border: '1px solid rgba(255,255,255,0.35)',
    borderRadius: 7,
    background: 'rgba(0,0,0,0.35)',
    color: '#fff',
    font: 'inherit',
    cursor: 'pointer',
  }
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      style={{ padding: 0, border: 'none', background: 'transparent', maxWidth: '96vw', maxHeight: '96vh' }}
    >
      <div style={{ position: 'relative', width: 'min(96vw, 1200px)', height: 'min(90vh, 800px)', background: '#111', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 1, display: 'flex', alignItems: 'center', gap: 6, padding: 4, borderRadius: 9, background: 'rgba(0,0,0,0.55)', color: '#fff' }}>
          <button type="button" style={button} disabled={zoom === MIN_ZOOM} onClick={() => setZoom(value => Math.max(MIN_ZOOM, value - ZOOM_STEP))}>−</button>
          <span>{`${Math.round(zoom * 100)}%`}</span>
          <button type="button" style={button} disabled={zoom === MAX_ZOOM} onClick={() => setZoom(value => Math.min(MAX_ZOOM, value + ZOOM_STEP))}>+</button>
          <button type="button" style={button} disabled={zoom === MIN_ZOOM} onClick={() => setZoom(MIN_ZOOM)}>{t('imageUiZoomReset')}</button>
        </div>
        <button
          type="button"
          aria-label={t('imageUiClose')}
          onClick={onClose}
          style={{ ...button, position: 'absolute', top: 8, right: 8, zIndex: 1, width: 32, padding: 0 }}
        >
          ×
        </button>
        <div
          ref={viewport}
          onPointerDown={event => {
            if (zoom === MIN_ZOOM || event.button !== 0) return
            dragStart.current = {
              pointerId: event.pointerId,
              clientX: event.clientX,
              clientY: event.clientY,
              scrollLeft: event.currentTarget.scrollLeft,
              scrollTop: event.currentTarget.scrollTop,
            }
            event.currentTarget.setPointerCapture?.(event.pointerId)
            setDragging(true)
          }}
          onPointerMove={event => {
            const start = dragStart.current
            if (start === null || start.pointerId !== event.pointerId) return
            event.currentTarget.scrollLeft = start.scrollLeft - (event.clientX - start.clientX)
            event.currentTarget.scrollTop = start.scrollTop - (event.clientY - start.clientY)
            event.preventDefault()
          }}
          onPointerUp={event => {
            if (dragStart.current?.pointerId !== event.pointerId) return
            dragStart.current = null
            if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) event.currentTarget.releasePointerCapture(event.pointerId)
            setDragging(false)
          }}
          onPointerCancel={() => {
            dragStart.current = null
            setDragging(false)
          }}
          style={{ width: '100%', height: '100%', overflow: 'auto', cursor: zoom === MIN_ZOOM ? 'zoom-in' : dragging ? 'grabbing' : 'grab' }}
        >
          <div style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>
            <img src={src} alt={alt} draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
        </div>
      </div>
    </dialog>
  )
}

function ImagineFrame({ attachment, load, t: translate, onOpen }: {
  attachment: ImageRef
  load: (attachment: ImageRef) => Promise<string>
  t: ImagineTranslate
  onOpen: (value: { src: string; label: string }) => void
}) {
  const t = translate ?? FALLBACK_TRANSLATE
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    setError(false)
    setSrc(null)
    load(attachment).then(url => {
      if (live) setSrc(url)
    }).catch(() => {
      if (live) setError(true)
    })
    return () => {
      live = false
    }
  }, [attachment.attachmentId, attachment.bytes, attachment.height, attachment.mediaType, attachment.name, attachment.width, load])
  if (error) return <div style={mediaCardStyles.muted}>{t('imageUiImageUnavailable')}</div>
  if (src === null) return <div style={mediaCardStyles.muted}>{t('imageUiLoadingImage')}</div>
  const label = attachment.name ?? TOOL_NAME
  return (
    <button
      type="button"
      title={t('imageUiViewLarge')}
      aria-label={`${t('imageUiViewLarge')}: ${label}`}
      onClick={() => { onOpen({ src, label }) }}
      style={{
        display: 'block',
        padding: 0,
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 12,
        background: 'var(--dsw-alias-bg-secondary, transparent)',
        cursor: 'zoom-in',
        overflow: 'hidden',
        width: '100%',
        maxWidth: '100%',
      }}
    >
      <img src={src} alt={label} style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 360, objectFit: 'contain' }} />
    </button>
  )
}

function ActionButton({ t: translate, label, onClick, disabled, primary }: {
  t: ImagineTranslate
  label: string
  onClick: () => Promise<unknown>
  disabled?: boolean
  primary?: boolean
}) {
  const t = translate ?? FALLBACK_TRANSLATE
  const [state, setState] = useState<'idle' | 'pending' | 'failed'>('idle')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  return (
    <button
      type="button"
      style={primary === true ? { ...mediaCardStyles.action, ...mediaCardStyles.primaryAction } : mediaCardStyles.action}
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

/** Compact one-line technical summary of an image (media-first key specs). */
function imageSpecLine(images: ImageRef[]): string {
  return images
    .map(image => `${image.width}×${image.height} · ${formatMediaType(image.mediaType)} · ${formatBytes(image.bytes)}`)
    .join('  ·  ')
}

/** Full attachment refs and technical info; always folded into details. */
function ImageInfoSection({ images, t: translate }: { images: ImageRef[]; t: ImagineTranslate }) {
  const t = translate ?? FALLBACK_TRANSLATE
  if (images.length === 0) return null
  return (
    <section aria-label={t('imageUiImageInfo')} style={{ display: 'grid', gap: 6 }}>
      <strong style={sectionHeading}>{t('imageUiImageInfo')}</strong>
      {images.map((image, index) => (
        <div key={image.attachmentId} style={{ display: 'grid', gap: 2 }}>
          <span>{image.name ?? `${t('imageUiImage')} ${index + 1}`} · {formatMediaType(image.mediaType)} · {image.width}×{image.height} · {formatBytes(image.bytes)}</span>
          <span>{`attachmentId: ${image.attachmentId}`}</span>
        </div>
      ))}
    </section>
  )
}

function PromptSection({ prompt, t: translate }: { prompt: string; t: ImagineTranslate }) {
  const t = translate ?? FALLBACK_TRANSLATE
  if (prompt === '') return null
  return (
    <section aria-label={t('imageUiPrompt')} style={{ display: 'grid', gap: 6 }}>
      <strong style={sectionHeading}>{t('imageUiPrompt')}</strong>
      <pre style={blockStyle}>{prompt}</pre>
    </section>
  )
}

interface CardProps {
  block: unknown
  sessionId: string | undefined
  sessions: SessionsService | undefined
  openFile?: (path: string) => void
  /** Locale translator injected with the slot; English fallback when absent. */
  t?: ImagineTranslate
  owner?: { block: unknown; openFile?: (path: string) => void }
}

/**
 * Done card: media-first (bounded gallery + key specs + primary view and
 * download), everything long — prompt, raw result, full attachment refs,
 * technical info, local inputs — behind the collapsed details. A text-only
 * result (save_path fallback) has no media, so its text stays visible.
 */
function ImagineResultCard({ block, sessionId, sessions, openFile, t: translate }: CardProps) {
  const t = translate ?? FALLBACK_TRANSLATE
  const load = useImageLoader(sessionId, sessions)
  const images = imageAttachments(block)
  const prompt = promptOf(block)
  const resultText = textOf(block)
  const inputs = inputSources(block)
  const hasImages = images.length > 0
  const isEdit = toolNameOf(block) === 'grok_imagine_edit'
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [viewer, setViewer] = useState<{ src: string; label: string } | null>(null)
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => { setCopyState('idle') }, 2000)
    return () => { window.clearTimeout(timer) }
  }, [copyState])
  if (!hasImages && resultText === '') return null
  const canPrompt = prompt !== '' && typeof sessionId === 'string' && typeof sessions?.binding === 'function'
  const specLine = hasImages ? imageSpecLine(images) : ''
  const hasDetails = prompt !== '' || hasImages || inputs.length > 0
  const preview = hasImages
    ? (
        <div
          data-testid="grok-imagine-gallery"
          style={{
            ...mediaCardStyles.preview,
            display: 'grid',
            gridTemplateColumns: images.length === 1 ? '1fr' : 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
            gap: 10,
            boxSizing: 'border-box',
            width: '100%',
            maxWidth: '100%',
            padding: 12,
          }}
        >
          {images.map((attachment, index) => (
            <ImagineFrame
              key={`${attachment.attachmentId}:${index}`}
              attachment={attachment}
              load={load}
              t={t}
              onOpen={setViewer}
            />
          ))}
        </div>
      )
    : (
        <section aria-label={t('imageUiResult')} style={{ display: 'grid', gap: 6, maxWidth: GALLERY_MAX_WIDTH }}>
          <strong style={sectionHeading}>{t('imageUiResult')}</strong>
          <pre style={blockStyle}>{resultText}</pre>
        </section>
      )
  return (
    <>
      <MediaCardFrame
        testId="grok-imagine-result"
        ariaLabel="grok_imagine"
        title={t(isEdit ? 'imageUiEdited' : 'imageUiGenerated')}
        status={t('imageUiStatusDone')}
        statusTone="success"
        summary={(
          <>
            {sourceBadge(SOURCE_LABEL, SOURCE_TONES.grok)}
            {specLine === '' ? null : <span>{specLine}</span>}
          </>
        )}
        preview={preview}
        actions={(
          <>
            {images.map((image, index) => (
              <ActionButton
                key={`view:${image.attachmentId}`}
                t={t}
                label={images.length === 1 ? t('imageUiViewLarge') : `${t('imageUiViewLarge')} ${index + 1}`}
                onClick={async () => {
                  setViewer({ src: await load(image), label: image.name ?? TOOL_NAME })
                }}
              />
            ))}
            {images.map((image, index) => (
              <ActionButton
                key={`download:${image.attachmentId}`}
                t={t}
                primary
                label={images.length === 1 ? t('imageUiDownload') : `${t('imageUiDownload')} ${index + 1}`}
                onClick={async () => {
                  triggerDownload(await load(image), image.name ?? `grok-imagine.${extensionFor(image.mediaType)}`)
                }}
              />
            ))}
            {images.map((image, index) => (
              <ActionButton
                key={`copy:${image.attachmentId}`}
                t={t}
                label={images.length === 1 ? t('imageUiCopyImage') : `${t('imageUiCopyImage')} ${index + 1}`}
                onClick={async () => {
                  const blob = await (await fetch(await load(image))).blob()
                  await navigator.clipboard.write([new ClipboardItem({ [blob.type || image.mediaType]: blob })])
                }}
              />
            ))}
            {prompt !== '' ? (
              <ActionButton
                t={t}
                label={copyState === 'copied' ? t('imageUiCopied') : copyState === 'failed' ? t('imageUiCopyFailed') : t('imageUiCopyPrompt')}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(prompt)
                    setCopyState('copied')
                  } catch (error) {
                    setCopyState('failed')
                    throw error
                  }
                }}
              />
            ) : null}
            {canPrompt ? (
              <ActionButton
                t={t}
                label={t('imageUiRegenerate')}
                onClick={async () => {
                  const accepted = await sessions!.binding(sessionId!)?.session?.prompt?.([{
                    type: 'text',
                    text: regenerateText(toolNameOf(block), prompt, argsOf(block), t),
                  }], 'queue')
                  if (accepted?.ok !== true) throw new Error('regenerate failed')
                }}
              />
            ) : null}
          </>
        )}
        details={hasDetails
          ? (
              <>
                <PromptSection prompt={prompt} t={t} />
                {hasImages && resultText !== ''
                  ? (
                      <section aria-label={t('imageUiResult')} style={{ display: 'grid', gap: 6 }}>
                        <strong style={sectionHeading}>{t('imageUiResult')}</strong>
                        <pre style={blockStyle}>{resultText}</pre>
                      </section>
                    )
                  : null}
                <SourceImages block={block} sessionId={sessionId} sessions={sessions} openFile={openFile} t={t} />
                <ImageInfoSection images={images} t={t} />
              </>
            )
          : undefined}
        detailsLabel={t('imageUiDetails')}
      />
      {viewer === null
        ? null
        : <ImagineLightbox src={viewer.src} alt={viewer.label} t={t} onClose={() => setViewer(null)} />}
    </>
  )
}

function SourceImages({ block, sessionId, sessions, openFile, t: translate }: CardProps) {
  const t = translate ?? FALLBACK_TRANSLATE
  const load = useImageLoader(sessionId, sessions)
  const sources = inputSources(block)
  if (sources.length === 0) return null
  return <section aria-label={t('imageUiInputImages')} style={{ display: 'grid', gap: 8, width: '100%' }}>
    <strong style={sectionHeading}>{t('imageUiInputImages')}</strong>
    {sources.map((source, index) => {
      let ref: ImageRef | undefined
      try { ref = imageRef(JSON.parse(source.replace(/^attachment=/u, ''))) } catch { /* May be a path or handle. */ }
      const id = /sha256:[a-f0-9]{64}/u.exec(source)?.[0]
      if (ref !== undefined || id !== undefined) return <SourceAttachment key={index} id={ref?.attachmentId ?? id!} load={load} t={t} />
      if (/^data:image\/(png|jpeg|webp);base64,/iu.test(source)) return <img key={index} src={source} alt={`${t('imageUiInputImage')} ${index + 1}`} style={{ maxWidth: 240, maxHeight: 160, objectFit: 'contain' }} />
      if (/^https?:\/\//iu.test(source)) return <a key={index} href={source} target="_blank" rel="noreferrer">{`${t('imageUiInputImage')} ${index + 1} ${t('imageUiRemoteLink')}`}</a>
      return <div key={index} style={{ overflowWrap: 'anywhere' }}>{source}{openFile ? <button type="button" style={mediaCardStyles.action} onClick={() => openFile(source)}>{t('imageUiOpenInput')}</button> : null}</div>
    })}
  </section>
}

function SourceAttachment({ id, load, t: translate }: { id: string; load: (ref: Pick<ImageRef, 'attachmentId'>) => Promise<string>; t: ImagineTranslate }) {
  const t = translate ?? FALLBACK_TRANSLATE
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setSrc(null)
    setFailed(false)
    // Session readAttachment requires only the opaque id; display metadata is returned by the host.
    load({ attachmentId: id }).then(value => { if (live) setSrc(value) }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [id, load])
  return src
    ? <img src={src} alt={t('imageUiInputImages')} style={{ maxWidth: 240, maxHeight: 160, objectFit: 'contain' }} />
    : <div style={mediaCardStyles.muted}>{failed ? t('imageUiInputReadFailed') : t('imageUiLoadingInput')}{id}</div>
}

/**
 * Pending card: same frame, busy status, progress, local inputs, and the
 * stop-waiting action with its billing honesty note (pending only — a settled
 * card never offers it). A new request is only ever issued by an explicit
 * user click, never on render.
 */
function GeneratingCard({ block, sessionId, sessions, openFile, t: translate }: CardProps) {
  const t = translate ?? FALLBACK_TRANSLATE
  const prompt = promptOf(block)
  const isEdit = toolNameOf(block) === 'grok_imagine_edit'
  const canStop = typeof sessionId === 'string' && typeof sessions?.binding === 'function'
  return (
    <MediaCardFrame
      testId="grok-imagine-pending"
      title={t(isEdit ? 'imageUiEditing' : 'imageUiGenerating')}
      status={t('working')}
      statusTone="busy"
      summary={sourceBadge(SOURCE_LABEL, SOURCE_TONES.grok)}
      preview={(
        <div style={{ display: 'grid', gap: 10, width: '100%', maxWidth: GALLERY_MAX_WIDTH }}>
          {prompt !== ''
            ? <div style={{ ...mediaCardStyles.prompt, color: 'var(--dsw-alias-label-secondary)' }}>{prompt}</div>
            : <div style={mediaCardStyles.muted}>{t('imageUiReceivingArgs')}</div>}
          <progress style={{ width: '100%', height: 4 }} />
          <SourceImages block={block} sessionId={sessionId} sessions={sessions} openFile={openFile} t={t} />
        </div>
      )}
      notice={canStop ? t('imageUiStopNotice') : undefined}
      actions={canStop
        ? (
            <ActionButton
              t={t}
              label={t('imageUiStopWaiting')}
              onClick={async () => {
                const accepted = await sessions!.binding(sessionId!)?.session?.cancel?.()
                if (accepted?.ok !== true) throw new Error('cancel failed')
              }}
            />
          )
        : undefined}
      detailsLabel={t('imageUiDetails')}
    />
  )
}

/** Errored call: unified frame, error status, prompt and host text stay visible. */
function ImagineFailureCard({ block, sessionId, sessions, openFile, t: translate }: CardProps) {
  const t = translate ?? FALLBACK_TRANSLATE
  const prompt = promptOf(block)
  const text = textOf(block)
  const images = imageAttachments(block)
  const inputs = inputSources(block)
  const isEdit = toolNameOf(block) === 'grok_imagine_edit'
  const hasDetails = inputs.length > 0 || images.length > 0
  return (
    <MediaCardFrame
      testId="grok-imagine-failure"
      title={t(isEdit ? 'imageUiEditFailed' : 'imageUiGenerateFailed')}
      status={t('actionFailed')}
      statusTone="error"
      summary={sourceBadge(SOURCE_LABEL, SOURCE_TONES.grok)}
      preview={prompt !== '' || text !== ''
        ? (
            <div style={{ display: 'grid', gap: 8, width: '100%', maxWidth: GALLERY_MAX_WIDTH }}>
              {prompt !== '' ? <div style={{ ...mediaCardStyles.prompt, color: 'var(--dsw-alias-label-secondary)' }}>{prompt}</div> : null}
              {text !== '' ? <pre style={blockStyle}>{text}</pre> : null}
            </div>
          )
        : undefined}
      details={hasDetails
        ? (
            <>
              <SourceImages block={block} sessionId={sessionId} sessions={sessions} openFile={openFile} t={t} />
              <ImageInfoSection images={images} t={t} />
            </>
          )
        : undefined}
      detailsLabel={t('imageUiDetails')}
    />
  )
}

function GrokImagineToolView(rawProps: CardProps) {
  const props = rawProps.owner ? { ...rawProps, block: rawProps.owner.block, openFile: rawProps.owner.openFile } : rawProps
  const settled = isObject(props.block) && 'kind' in (props.block as Record<string, unknown>)
  if (!settled) {
    return <GeneratingCard {...props} />
  }
  if ((props.block as ToolCallBlock).isError === true) {
    return <ImagineFailureCard {...props} />
  }
  return <ImagineResultCard {...props} />
}

// ---------------------------------------------------------------------------
// Turn-tail summary (all grok images of the turn, plus a Codex count legend)
// ---------------------------------------------------------------------------

function walkTurnImageResults(rows: unknown, closingSeq: number, names: Set<string>): ToolCallBlock[] {
  if (!Array.isArray(rows)) return []
  const images: ToolCallBlock[] = []
  // Shared across every row: the same call may surface through more than one
  // node (legacy store and ChatNodeStore), and the tail must render it once.
  const visited = new Set<string>()
  for (const row of rows) {
    if (!isObject(row)) continue
    const pending: unknown[] = row.root === undefined ? [] : [row.root]
    while (pending.length > 0) {
      const block = pending.pop()
      if (block === undefined) continue
      const record = isObject(block) ? block as ToolCallBlock : undefined
      if (record === undefined) continue
      const callId = typeof record.callId === 'string' ? record.callId : ''
      if (callId !== '' && visited.has(callId)) continue
      if (callId !== '') visited.add(callId)
      const seq = typeof record.seq === 'number' ? record.seq : Number.POSITIVE_INFINITY
      const callName = record.call?.name
      if ('kind' in record && record.isError !== true && seq <= closingSeq && callName !== undefined && names.has(callName) && imageAttachments(record).length > 0) {
        images.push(record)
      }
      const children = Array.isArray(record.subCalls) ? record.subCalls : []
      for (let index = children.length - 1; index >= 0; index--) {
        if (children[index] !== undefined) pending.push(children[index])
      }
    }
  }
  return images.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))
}

function selectTurnImagineResults(rows: unknown, closingSeq: number): ToolCallBlock[] {
  return walkTurnImageResults(rows, closingSeq, TOOL_NAMES)
}

/** Codex-line image count this turn; legend only. */
function countTurnCodexResults(rows: unknown, closingSeq: number): number {
  return walkTurnImageResults(rows, closingSeq, CODEX_TOOL_NAMES).length
}

interface TurnTailProps {
  owner?: { turn: { turn: unknown }; seq: number; openFile?: (path: string) => void }
  turn?: { turn: unknown }
  seq?: number
  sessionId?: string
  sessions?: SessionsService
  openFile?: (path: string) => void
  /** Locale translator injected with the slot; English fallback when absent. */
  t?: ImagineTranslate
  useChat?: UseChat
}

function GrokImagineTurnTail(rawProps: TurnTailProps) {
  const props = rawProps.owner ? { ...rawProps, ...rawProps.owner } : rawProps
  const t = props.t ?? FALLBACK_TRANSLATE
  const empty = useMemo<ExternalStore<ToolCallBlock[]>>(() => {
    const rows: ToolCallBlock[] = []
    return { subscribe: () => () => undefined, getSnapshot: () => rows }
  }, [])
  const chat = typeof props.useChat === 'function' ? props.useChat(chat => chat) : undefined
  const source = useMemo<ExternalStore<ToolCallBlock[]>>(
    () => (props.turn !== undefined && typeof chat?.nodes.turnDataSource === 'function'
      ? chat.nodes.turnDataSource(props.turn.turn, 'tool-call')
      : empty),
    // Host turnDataSource may mint a fresh store per call; memoize so
    // useSyncExternalStore keeps stable subscribe/getSnapshot references.
    [chat, props.turn?.turn, empty])
  const legacyRows = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const rows = useMemo(() => typeof chat?.nodes.values === 'function'
    // ConversationLocation carries the TurnLocation object at `.turn`; the
    // numeric turn id lives one level deeper (location.turn.turn).
    ? chat.nodes.values().filter(node => node.kind === 'tool-call' && node.location?.turn?.turn === props.turn?.turn).map(node => node.data)
    : legacyRows, [chat, props.turn?.turn, legacyRows])
  const results = useMemo(() => selectTurnImagineResults(rows, props.seq ?? Number.POSITIVE_INFINITY), [rows, props.seq])
  const codexCount = useMemo(() => countTurnCodexResults(rows, props.seq ?? Number.POSITIVE_INFINITY), [rows, props.seq])
  if (results.length === 0) return null
  return (
    <section data-turn-image-results="grok-imagine" aria-label="grok_imagine" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {codexCount > 0 ? (
        <div style={{ ...mediaCardStyles.muted, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          {sourceBadge(SOURCE_LABEL, SOURCE_TONES.grok)}
          <span>{`${t('imageUiCodexLegendA')}${String(codexCount)}${t('imageUiCodexLegendB')}`}</span>
        </div>
      ) : null}
      {results.map(block => (
        <ImagineResultCard
          key={block.callId ?? String(block.seq)}
          block={block}
          sessionId={props.sessionId}
          sessions={props.sessions}
          openFile={props.openFile}
          t={t}
        />
      ))}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Slot wiring
// ---------------------------------------------------------------------------

/**
 * Register the toolview occupant for both grok image tools and the turn-tail
 * summary. Called from the client entry; requires the `sessions` service via
 * a child fiber so the registrations unload with it.
 *
 * The translator is bound from the plugin's existing settings locale namespace
 * (`settings.xai-oauth`, registered with zh + en by the client entry) so the
 * cards follow the host language. If the locale service is not available the
 * views fall back to the English copy — never to hardcoded Chinese.
 */
export function applyImagineViews(ctx: Context): void {
  const t: ImagineTranslate = typeof ctx.locale?.bind === 'function'
    ? ctx.locale.bind('settings.xai-oauth') as ImagineTranslate
    : FALLBACK_TRANSLATE
  ctx.inject(['sessions'], scope => {
    const sessions = scope.sessions as SessionsService
    for (const key of TOOL_NAMES) {
      scope.slots.inject('tool.call.toolview', () => scope.slots.register({
        name: 'tool.call.toolview',
        key,
        inject: () => ({ sessions, t }),
      }, GrokImagineToolView))
    }
    scope.slots.inject('conversation.chat.turnTail', () => scope.slots.register({
      name: 'conversation.chat.turnTail',
      id: 'dsh-grok-kit-imagine',
      order: 21,
      inject: () => ({ sessions, t }),
    }, GrokImagineTurnTail))
  })
}
