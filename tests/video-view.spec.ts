/**
 * Contract tests for the grok video views.
 *
 * Same discipline as tests/imagine-view.spec.ts: components run against a fake
 * react and their element trees are RECURSIVELY EXPANDED, so a component that
 * returns an unrendered element can never pass an assertion vacuously. Where a
 * test clicks buttons the tree is expanded exactly ONCE first (`expandTree`),
 * so the player and the download button really share one component instance
 * and one lazy media resource.
 *
 * Covered here:
 *   1. applyVideoViews occupies exactly the three frozen tool names.
 *   2. the media-first card: done shows play + download (download primary) and
 *      never the resume/query action; pending/downloading offer query,
 *      interrupted offers resume, failed / submission-unknown offer nothing
 *      that could POST again; "stop waiting" only cancels the local wait and
 *      keeps the billing notice.
 *   3. attachment dedupe: task.attachment + block.meta + file blocks collapse
 *      to one reference region per attachmentId (structured task wins) while
 *      different ids are all kept; technical ids, full refs, prompt, model and
 *      ISO times live in a `<details>` that is collapsed at first paint.
 *   4. localisation: without an injected translator the cards fall back to the
 *      English locale copy (an English UI can never show Chinese errors), and
 *      the zh copy renders the same keys in Chinese.
 *   5. the shared parsers accept only the frozen shapes.
 *   6. the download path hits only the plugin's same-origin file route and
 *      refuses oversized / non-done / length-mismatched responses.
 *   7. the shared lazy media blob: user action only, concurrent loads merged,
 *      dispose aborts + revokes, and the player/download buttons share one
 *      fetch through the UI.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const accountImportProbe = vi.hoisted(() => ({ active: false, generations: 0, statuses: [] as Array<{ status: string }> }))

vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => {
    const value = typeof initial === 'function' ? (initial as () => unknown)() : initial
    if (accountImportProbe.active && typeof value === 'object' && value !== null && 'status' in value) {
      return [{ status: 'signed-out', grokImportAvailable: true }, (next: { status: string }) => accountImportProbe.statuses.push(next)]
    }
    if (accountImportProbe.active && value === 0) {
      return [0, () => { accountImportProbe.generations += 1 }]
    }
    return [value, () => undefined]
  },
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))
vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({ type, props: props ?? {}, key })
  return { jsx, jsxs: jsx, Fragment: Symbol.for('Fragment') }
})

import {
  MAX_VIDEO_DOWNLOAD_BYTES,
  VIDEO_TOOL_NAMES,
  applyVideoViews,
  createVideoBlobResource,
  fetchVideoFile,
  formatBytes,
  parseResumePayload,
  parseVideoTask,
  parseVideoTasks,
  videoFileUrl,
} from '../src/client/video-view.tsx'
import { mediaCardStyles } from '../src/client/media-card.tsx'
import { en, zh } from '../src/client/locales.ts'
import { XaiSettings } from '../src/client/XaiSettings.tsx'
import { GROK_VIDEO_FILE_PATH } from '../src/video-config.ts'

interface Registration {
  spec: { name: string; key?: string; id?: string }
  component: (props: never) => unknown
}

function captureRegistrations(): Registration[] {
  const registrations: Registration[] = []
  const scope = {
    sessions: { binding: () => undefined },
    slots: {
      inject: (_name: string, setup: () => unknown) => { setup() },
      register: (spec: Registration['spec'], component: Registration['component']) => {
        registrations.push({ spec, component })
        return () => undefined
      },
      entries: () => [],
    },
  }
  applyVideoViews({ inject: (_deps: string[], cb: (s: typeof scope) => void) => { cb(scope) } } as never)
  return registrations
}

function toolViewFor(registrations: Registration[], key: string) {
  const found = registrations.find(entry => entry.spec.name === 'tool.call.toolview' && entry.spec.key === key)
  expect(found).toBeDefined()
  return found!.component as (props: Record<string, unknown>) => unknown
}

interface Expanded {
  texts: string[]
  tags: string[]
}

interface FakeElement {
  type: unknown
  props: Record<string, unknown>
}

function asElement(node: unknown): FakeElement | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
  const element = node as FakeElement
  return typeof element.props === 'object' && element.props !== null ? element : undefined
}

/** Recursively expand rendered elements down to DOM nodes and text. */
function renderDeep(node: unknown, out: Expanded = { texts: [], tags: [] }): Expanded {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) renderDeep(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node))
    return out
  }
  const element = node as FakeElement
  if (typeof element.type === 'function') {
    renderDeep((element.type as (props: Record<string, unknown>) => unknown)(element.props), out)
    return out
  }
  if (typeof element.type === 'string') out.tags.push(element.type)
  renderDeep(element.props.children, out)
  return out
}

/**
 * Like {@link renderDeep}, but a `<details>` body is hidden until opened: only
 * its `<summary>` label counts towards the first, initially visible view.
 */
function renderVisible(node: unknown, out: Expanded = { texts: [], tags: [] }): Expanded {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) renderVisible(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node))
    return out
  }
  const element = node as FakeElement
  if (typeof element.type === 'function') {
    renderVisible((element.type as (props: Record<string, unknown>) => unknown)(element.props), out)
    return out
  }
  if (typeof element.type === 'string') out.tags.push(element.type)
  const children = element.props.children
  if (element.type === 'details') {
    for (const child of Array.isArray(children) ? children : [children]) {
      const inner = asElement(child)
      if (inner !== undefined && inner.type === 'summary') renderVisible(child, out)
    }
    return out
  }
  renderVisible(children, out)
  return out
}

/**
 * Expand every component exactly once into a static element tree, so handlers
 * found later in the tree belong to ONE component instance (and one shared
 * lazy media resource).
 */
function expandTree(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(child => expandTree(child))
  const element = asElement(node)
  if (element === undefined) return node
  if (typeof element.type === 'function') {
    return expandTree((element.type as (props: Record<string, unknown>) => unknown)(element.props))
  }
  return { type: element.type, props: { ...element.props, children: expandTree(element.props.children) } }
}

function findElements(node: unknown, match: (element: FakeElement) => boolean, out: FakeElement[] = []): FakeElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, match, out)
    return out
  }
  const element = asElement(node)
  if (element === undefined) return out
  if (typeof element.type === 'function') {
    findElements((element.type as (props: Record<string, unknown>) => unknown)(element.props), match, out)
    return out
  }
  if (match(element)) out.push(element)
  findElements(element.props.children, match, out)
  return out
}

function clickButton(node: unknown, label: string): void {
  const button = findElements(node, element => element.type === 'button' && (element.props.children === label || element.props['aria-label'] === label))[0]
  expect(button).toBeDefined()
  const onClick = button!.props.onClick as (() => void) | undefined
  expect(typeof onClick).toBe('function')
  onClick!()
}

/** Expand component elements to their final rendered value (null included). */
function expandValue(node: unknown): unknown {
  const element = asElement(node)
  if (element !== undefined && typeof element.type === 'function') {
    return expandValue((element.type as (props: Record<string, unknown>) => unknown)(element.props))
  }
  return node
}

const TASK_ID = '11111111-2222-3333-4444-555555555555'
const ATTACHMENT_A = { attachmentId: `sha256:${'b'.repeat(64)}`, name: 'clip.mp4', bytes: 2048 }
/** Chinese translator injected with the slot; absent in the English tests. */
const zhT = (key: keyof typeof zh): string => zh[key]

function taskJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    taskId: TASK_ID,
    state: 'done',
    model: 'grok-imagine-video-1.5',
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:01:00.000Z',
    prompt: 'a cat surfing',
    duration: 5,
    resolution: '720p',
    attachment: ATTACHMENT_A,
    ...overrides,
  })
}

function settledBlock(name: string, args: Record<string, unknown>, content: unknown[], isError = false): Record<string, unknown> {
  return { kind: 'call', call: { name, argsRaw: JSON.stringify(args) }, content, isError, callId: 'c1', seq: 1 }
}

const SESSIONS = { binding: () => undefined }

describe('account import boundary', () => {
  afterEach(() => {
    accountImportProbe.active = false
    accountImportProbe.generations = 0
    accountImportProbe.statuses = []
    vi.unstubAllGlobals()
  })

  it('hides old account data while import is pending and remounts again after commit', async () => {
    accountImportProbe.active = true
    let finish!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { finish = resolve })
    const fetchMock = vi.fn(() => pending)
    vi.stubGlobal('fetch', fetchMock)
    const tree = XaiSettings({ t: key => en[key] })
    const findImport = (node: unknown): (() => void) | undefined => {
      if (Array.isArray(node)) {
        for (const child of node) { const found = findImport(child); if (found !== undefined) return found }
      } else if (typeof node === 'object' && node !== null && 'props' in node) {
        const element = node as { type?: unknown; props: Record<string, unknown> }
        if (element.type === 'button' && element.props.children === en.importGrok) return element.props.onClick as () => void
        return findImport(element.props.children)
      }
      return undefined
    }
    const click = findImport(tree)
    expect(click).toBeDefined()
    click!()
    expect(accountImportProbe.generations).toBe(1)
    expect(accountImportProbe.statuses).toEqual([{ status: 'loading' }])
    expect(fetchMock).toHaveBeenCalledOnce()
    finish(new Response(JSON.stringify({ status: 'signed-in', models: ['grok-4.6'] }), { status: 200 }))
    await vi.waitFor(() => expect(accountImportProbe.statuses).toHaveLength(2))
    expect(accountImportProbe.generations).toBe(2)
    expect(accountImportProbe.statuses[1]!.status).toBe('signed-in')
  })
})

describe('slot registration', () => {
  it('occupies exactly the three frozen video tool names', () => {
    const keys = captureRegistrations()
      .filter(entry => entry.spec.name === 'tool.call.toolview')
      .map(entry => entry.spec.key)
    expect(keys).toHaveLength(3)
    expect(new Set(keys)).toEqual(new Set(VIDEO_TOOL_NAMES))
  })
})

describe('video media card', () => {
  const registrations = captureRegistrations()
  const view = toolViewFor(registrations, 'grok_video_generate')

  const doneBlock = (overrides: Record<string, unknown> = {}, content?: unknown[]) => settledBlock(
    'grok_video_generate',
    { prompt: 'a cat surfing' },
    content ?? [{ type: 'text', text: taskJson(overrides) }],
  )

  afterEach(() => { vi.unstubAllGlobals() })

  it('done: media-first card with play + primary download and never a resume/query action (English fallback)', () => {
    const tree = expandTree(view({ block: doneBlock(), sessionId: 's1', sessions: SESSIONS }))
    const out = renderDeep(tree)
    expect(out.texts).toContain(en.taskStateDone)
    expect(out.texts).toContain(en.videoDownload)
    expect(out.texts).toContain(en.videoUiPlay)
    const previewButton = findElements(tree, element => element.props['data-testid'] === 'grok-video-preview')[0]
    expect(previewButton?.props.title).toBe(en.videoUiLoadVideo)
    expect(out.texts.join(' ')).toContain('clip.mp4')
    expect(out.texts).toContain(formatBytes(2048))
    expect(out.texts).toContain('720p')
    expect(out.texts).toContain('5s')
    // done never offers restore / query — and no CJK in English mode.
    expect(out.texts).not.toContain(en.videoUiResume)
    expect(out.texts).not.toContain(en.videoUiQuery)
    expect(out.texts).not.toContain(en.resumeQuery)
    expect(out.texts.join(' ')).not.toMatch(/[一-鿿]/u)
    // Download is the primary action.
    const downloadButton = findElements(tree, element => element.type === 'button' && element.props.children === en.videoDownload)[0]
    expect(downloadButton).toBeDefined()
    const style = downloadButton!.props.style as Record<string, unknown>
    expect(style.background).toBe(mediaCardStyles.primaryAction.background)
  })

  it('folds ids, full ref, prompt, model and ISO times into one collapsed details section', () => {
    const tree = expandTree(view({ block: doneBlock(), sessionId: 's1', sessions: SESSIONS }))
    const details = findElements(tree, element => element.type === 'details')
    expect(details).toHaveLength(1)
    expect(details[0]!.props.open).toBeUndefined()

    const visible = renderVisible(tree)
    const out = renderDeep(tree)
    for (const raw of [TASK_ID, 'a cat surfing', 'grok-imagine-video-1.5', '2026-10-12T00:00:00.000Z', '2026-10-12T00:01:00.000Z', 'attachmentId', JSON.stringify(ATTACHMENT_A), en.videoCardCopyRef, en.resumeHint, en.videoCardDownloadNote]) {
      expect(visible.texts.join(' ')).not.toContain(raw)
      expect(out.texts.join(' ')).toContain(raw)
    }
  })

  it('collapses task.attachment + block.meta + file blocks to one reference per attachmentId', () => {
    const duplicate = { ...ATTACHMENT_A, name: 'DUPLICATE.mp4', bytes: 1 }
    const tree = expandTree(view({
      block: {
        ...doneBlock({}, [
          { type: 'file', attachment: duplicate },
          { type: 'file', attachment: ATTACHMENT_A },
        ]),
        meta: JSON.parse(taskJson()),
      },
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    // The structured task's attachment wins and the same id never renders twice.
    const refs = findElements(tree, element => element.props['data-testid'] === 'grok-video-attachment-ref')
    expect(refs).toHaveLength(1)
    const out = renderDeep(tree)
    expect(out.texts.join(' ')).toContain('clip.mp4')
    expect(out.texts.join(' ')).not.toContain('DUPLICATE.mp4')
  })

  it('keeps genuinely different attachments side by side', () => {
    const other = { attachmentId: 'file-9', name: 'clip2.mp4', bytes: 4096 }
    const tree = expandTree(view({
      block: {
        ...doneBlock({}, [
          { type: 'file', attachment: other },
          { type: 'file', attachment: ATTACHMENT_A },
        ]),
        meta: JSON.parse(taskJson()),
      },
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    const refs = findElements(tree, element => element.props['data-testid'] === 'grok-video-attachment-ref')
    expect(refs).toHaveLength(2)
    const out = renderDeep(tree)
    expect(out.texts.join(' ')).toContain('file-9')
    expect(out.texts.join(' ')).toContain(`sha256:${'b'.repeat(64)}`)
    expect(out.texts).toContain(formatBytes(4096))
    expect(out.texts).toContain(formatBytes(2048))
  })

  it('state actions: query on pending/downloading, resume on interrupted, none on failed/submission-unknown', () => {
    const labelsFor = (state: string, extra: Record<string, unknown> = {}): string[] => renderDeep(expandTree(view({
      block: doneBlock({ state, attachment: undefined, ...extra }),
      sessionId: 's1',
      sessions: SESSIONS,
    }))).texts

    for (const state of ['pending', 'downloading']) {
      const texts = labelsFor(state)
      expect(texts).toContain(en.videoUiQuery)
      expect(texts).not.toContain(en.videoUiResume)
      expect(texts).not.toContain(en.videoDownload)
    }
    const interrupted = labelsFor('interrupted')
    expect(interrupted).toContain(en.videoUiResume)
    expect(interrupted).not.toContain(en.videoUiQuery)
    for (const state of ['failed', 'submission-unknown']) {
      const texts = labelsFor(state, state === 'failed' ? { error: 'upstream 502' } : {})
      expect(texts).not.toContain(en.videoUiQuery)
      expect(texts).not.toContain(en.videoUiResume)
      expect(texts).not.toContain(en.videoDownload)
    }
    expect(labelsFor('failed', { error: 'upstream 502' })).toContain('upstream 502')
  })

  it('failed and submission-unknown cards never issue a request from any button', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const state of ['failed', 'submission-unknown']) {
      const tree = expandTree(view({
        block: doneBlock({ state, error: 'upstream 502' }),
        sessionId: 's1',
        sessions: SESSIONS,
      }))
      for (const button of findElements(tree, element => element.type === 'button')) {
        const onClick = button.props.onClick as (() => void) | undefined
        onClick?.()
      }
    }
    await new Promise<void>(resolve => { setTimeout(() => { resolve() }, 20) })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders every frozen state label and a progress bar while running', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ state: 'pending', attachment: undefined }, en.taskStatePending],
      [{ state: 'downloading', attachment: undefined }, en.taskStateDownloading],
      [{ state: 'done' }, en.taskStateDone],
      [{ state: 'failed', error: 'upstream 502', attachment: undefined }, en.taskStateFailed],
      [{ state: 'interrupted', attachment: undefined }, en.taskStateInterrupted],
      [{ state: 'submission-unknown', attachment: undefined }, en.taskStateSubmissionUnknown],
    ]
    for (const [overrides, label] of cases) {
      const out = renderDeep(view({ block: doneBlock(overrides), sessionId: 's1', sessions: SESSIONS }))
      expect(out.texts).toContain(label)
    }
    for (const state of ['pending', 'downloading']) {
      const out = renderDeep(view({ block: doneBlock({ state, attachment: undefined }), sessionId: 's1', sessions: SESSIONS }))
      expect(out.tags).toContain('progress')
    }
  })

  it('keeps a file-only result referenced without inventing a download action', () => {
    const tree = expandTree(view({
      block: settledBlock('grok_video_generate', { prompt: 'p' }, [
        { type: 'file', attachment: { attachmentId: 'file-9', name: 'clip.mp4', bytes: 4096 } },
      ]),
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    const out = renderDeep(tree)
    expect(out.texts).toContain(en.videoCardStateUnknown)
    expect(out.texts.join(' ')).toContain('file-9')
    expect(out.texts).toContain(formatBytes(4096))
    expect(out.texts).not.toContain(en.videoDownload)
    expect(out.texts).not.toContain(en.videoUiPlay)
    expect(findElements(tree, element => element.type === 'details')).toHaveLength(1)
    expect(findElements(tree, element => element.props['data-testid'] === 'grok-video-attachment-ref')).toHaveLength(1)
  })

  it('keeps failure and pending cards visible, and vanishes only when empty', () => {
    const failed = renderDeep(view({
      block: settledBlock('grok_video_generate', { prompt: 'p' }, [], true),
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    expect(failed.texts).toContain(en.videoCardFailureTitle)
    expect(failed.texts.join(' ')).toContain('p')

    const pending = renderDeep(view({
      block: { phase: 'start', argsRaw: JSON.stringify({ prompt: 'go' }) },
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    expect(pending.texts).toContain(en.videoCardPendingGenerate)
    expect(pending.texts.join(' ')).toContain('go')
    expect(pending.texts).toContain(en.videoCardStopWaiting)
    expect(pending.texts.join(' ')).toContain('Stopping the wait does not stop upstream billing')

    const statusPending = renderDeep(view({
      block: { phase: 'start', call: { name: 'grok_video_status', argsRaw: JSON.stringify({ taskId: TASK_ID }) } },
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    expect(statusPending.texts).toContain(en.videoCardPendingStatus)

    expect(expandValue(view({
      block: settledBlock('grok_video_generate', { prompt: 'p' }, []),
      sessionId: 's1',
      sessions: SESSIONS,
    }))).toBeNull()
  })

  it('stop waiting only cancels the local wait and keeps the billing notice', async () => {
    const cancel = vi.fn(async () => ({ ok: true }))
    const sessions = { binding: () => ({ session: { cancel } }) }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const tree = expandTree(view({
      block: { phase: 'start', argsRaw: JSON.stringify({ prompt: 'go' }) },
      sessionId: 's1',
      sessions,
    }))
    clickButton(tree, en.videoCardStopWaiting)
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(fetchMock).not.toHaveBeenCalled()
    const out = renderDeep(tree)
    expect(out.texts).toContain(en.videoCardStopWaiting)
    expect(out.texts.join(' ')).toContain('Stopping the wait does not stop upstream billing')
  })

  it('renders from the host owner contract (owner.block)', () => {
    const out = renderDeep(view({
      owner: { block: settledBlock('grok_video_status', { taskId: TASK_ID }, [{ type: 'text', text: taskJson({ state: 'downloading', attachment: undefined }) }]) },
    }))
    expect(out.texts).toContain(en.taskStateDownloading)
  })

  it('prefers the persisted presentationMeta (block.meta) over the prose result text', () => {
    const out = renderDeep(view({
      block: {
        ...settledBlock('grok_video_status', { taskId: TASK_ID }, [
          { type: 'text', text: `Video task ${TASK_ID} is done (model grok-imagine-video-1.5).` },
        ]),
        meta: JSON.parse(taskJson({ state: 'interrupted', attachment: undefined })),
      },
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    expect(out.texts).toContain(en.taskStateInterrupted)
    expect(out.texts).not.toContain(en.taskStateDone)
  })

  it('falls back to the host prose summary, including its attachment reference', () => {
    const attachment = { attachmentId: `sha256:${'c'.repeat(64)}`, name: 'clip.mp4', bytes: 2048 }
    const prose = [
      `Video task ${TASK_ID} is done (model grok-imagine-video-1.5).`,
      'Prompt: a cat surfing.',
      `Video saved. attachmentId=${attachment.attachmentId} attachment=${JSON.stringify(attachment)}`,
      'Stopping the wait is not cancelling: the remote generation keeps running and may still bill.',
    ].join(' ')
    const tree = expandTree(view({
      block: settledBlock('grok_video_status', { taskId: TASK_ID }, [{ type: 'text', text: prose }]),
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    const out = renderDeep(tree)
    expect(out.texts).toContain(en.taskStateDone)
    expect(out.texts.join(' ')).toContain(TASK_ID)
    expect(out.texts.join(' ')).toContain('clip.mp4')
    expect(out.texts).toContain(en.videoDownload)
    // The prose itself stays hidden once the structured task is recovered.
    expect(out.texts.join(' ')).not.toContain('Stopping the wait is not cancelling')
    // …and the recovered reference is still deduplicated to one region.
    expect(findElements(tree, element => element.props['data-testid'] === 'grok-video-attachment-ref')).toHaveLength(1)
  })

  it('falls back to English copy without a translator and renders the same keys in Chinese with zh bound', () => {
    const block = doneBlock()
    const english = renderDeep(view({ block, sessionId: 's1', sessions: SESSIONS }))
    expect(english.texts.join(' ')).not.toMatch(/[一-鿿]/u)
    expect(english.texts).toContain(en.videoUiPlay)
    expect(english.texts).toContain(en.videoDownload)
    expect(english.texts).toContain(en.videoUiDetails)

    const chinese = renderDeep(view({ block, sessionId: 's1', sessions: SESSIONS, t: zhT }))
    expect(chinese.texts).toContain(zh.videoUiPlay)
    expect(chinese.texts).toContain(zh.videoDownload)
    expect(chinese.texts).toContain(zh.taskStateDone)
    expect(chinese.texts).toContain(zh.videoUiDetails)

    const pending = renderDeep(view({
      block: { phase: 'start', argsRaw: JSON.stringify({ prompt: 'go' }) },
      sessionId: 's1',
      sessions: SESSIONS,
      t: zhT,
    }))
    expect(pending.texts).toContain(zh.videoCardStopWaiting)
    expect(pending.texts).toContain(zh.videoCardPendingGenerate)
    expect(pending.texts.join(' ')).toContain('停止等待不会停止上游计费')
  })
})

describe('frozen task parsers', () => {
  it('accepts a full task and defaults optional fields', () => {
    const task = parseVideoTask(JSON.parse(taskJson()))
    expect(task?.state).toBe('done')
    expect(task?.attachment?.name).toBe('clip.mp4')
    const bare = parseVideoTask(JSON.parse(taskJson({ attachment: undefined })))
    expect(bare?.prompt).toBe('a cat surfing')
    expect(bare?.attachment).toBeUndefined()
  })

  it('rejects malformed tasks instead of coercing them', () => {
    expect(parseVideoTask(undefined)).toBeUndefined()
    expect(parseVideoTask({ state: 'done' })).toBeUndefined()
    expect(parseVideoTask({ taskId: TASK_ID, state: 'finished' })).toBeUndefined()
    expect(parseVideoTask({ taskId: TASK_ID, state: 'done', attachment: { attachmentId: 'x' } })?.attachment).toBeUndefined()
  })

  it('parses the task list and skips broken entries', () => {
    const tasks = parseVideoTasks({ tasks: [JSON.parse(taskJson()), { nope: true }] })
    expect(tasks).toHaveLength(1)
    expect(() => parseVideoTasks({ items: [] })).toThrow()
  })

  it('accepts the direct resume payload and the transitional wrapper', () => {
    expect(parseResumePayload(JSON.parse(taskJson()))?.taskId).toBe(TASK_ID)
    expect(parseResumePayload({ result: JSON.parse(taskJson()) })?.taskId).toBe(TASK_ID)
    expect(parseResumePayload({ error: 'nope' })).toBeUndefined()
  })
})

describe('download contract', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('only ever targets the plugin file route by taskId', () => {
    expect(videoFileUrl(TASK_ID)).toBe(`${GROK_VIDEO_FILE_PATH}?taskId=${TASK_ID}`)
    expect(videoFileUrl(TASK_ID)).toBe(`/plugins/dsh-grok-kit/video/file?taskId=${TASK_ID}`)
    expect(videoFileUrl('../etc/passwd')).toBe(`/plugins/dsh-grok-kit/video/file?taskId=${encodeURIComponent('../etc/passwd')}`)
    expect(videoFileUrl(TASK_ID)).not.toMatch(/^https?:/)
  })

  it('refuses a task that is not done without issuing a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const task = parseVideoTask(JSON.parse(taskJson({ state: 'pending' })))!
    await expect(fetchVideoFile(task, new AbortController().signal))
      .rejects.toThrow('only finished (done) tasks can be downloaded')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an oversized reported file before reading anything', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const task = parseVideoTask(JSON.parse(taskJson({
      attachment: { attachmentId: 'a', name: 'big.mp4', bytes: MAX_VIDEO_DOWNLOAD_BYTES + 1 },
    })))!
    await expect(fetchVideoFile(task, new AbortController().signal))
      .rejects.toThrow(/exceeds the .* client limit/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the bytes when the length matches the reported size', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const fetchMock = vi.fn(async () => new Response(payload, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const task = parseVideoTask(JSON.parse(taskJson({
      attachment: { attachmentId: 'a', name: 'clip.mp4', bytes: payload.byteLength },
    })))!
    const blob = await fetchVideoFile(task, new AbortController().signal)
    expect(blob.size).toBe(payload.byteLength)
    expect(blob.type).toBe('video/mp4')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(videoFileUrl(TASK_ID))
    expect(init.credentials).toBe('same-origin')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({ accept: 'application/octet-stream' })
  })

  it('fails loudly when the returned length does not match', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 200 })))
    const task = parseVideoTask(JSON.parse(taskJson({
      attachment: { attachmentId: 'a', name: 'clip.mp4', bytes: 9 },
    })))
    await expect(fetchVideoFile(task!, new AbortController().signal))
      .rejects.toThrow(/length mismatch: expected 9 bytes, received 2 bytes/)
  })

  it('surfaces a non-2xx response as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })))
    const task = parseVideoTask(JSON.parse(taskJson()))!
    await expect(fetchVideoFile(task, new AbortController().signal)).rejects.toThrow('HTTP 403')
  })
})

describe('shared lazy media blob', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Count object URL minting/revoking without replacing the whole URL class. */
  function stubObjectUrls(): { created: string[]; revoked: string[] } {
    const created: string[] = []
    const revoked: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:test/${String(created.length)}`
      created.push(url)
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { revoked.push(url) })
    return { created, revoked }
  }

  it('keeps one play action and hides obsolete errors in healthy task states', () => {
    const registrations = captureRegistrations()
    const view = toolViewFor(registrations, 'grok_video_generate')
    const obsolete = 'submission started; outcome not recorded yet'
    for (const state of ['pending', 'downloading', 'done']) {
      const tree = expandTree(view({
        block: settledBlock('grok_video_generate', { prompt: 'p' }, [{ type: 'text', text: taskJson({ state, error: obsolete }) }]),
        sessionId: 's1', sessions: SESSIONS,
      }))
      expect(renderDeep(tree).texts.join(' ')).not.toContain(obsolete)
      if (state === 'done') {
        expect(findElements(tree, node => node.type === 'button' && (node.props.children === en.videoUiPlay || node.props['aria-label'] === en.videoUiPlay))).toHaveLength(1)
      }
    }
    const failed = renderDeep(view({
      block: settledBlock('grok_video_generate', { prompt: 'p' }, [{ type: 'text', text: taskJson({ state: 'failed', error: 'real upstream failure' }) }]),
      sessionId: 's1', sessions: SESSIONS,
    }))
    expect(failed.texts.join(' ')).toContain('real upstream failure')
  })

  it('merges concurrent loads into one request, caches the blob and mints one object URL', async () => {
    const { created, revoked } = stubObjectUrls()
    let calls = 0
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    const resource = createVideoBlobResource(() => {
      calls += 1
      return Promise.resolve(blob)
    })
    const [first, second] = await Promise.all([resource.load(), resource.load()])
    expect(calls).toBe(1)
    expect(first).toBe(blob)
    expect(second).toBe(blob)
    const url = resource.objectUrl()
    expect(url).toBe(created[0])
    expect(resource.objectUrl()).toBe(url)
    expect(created).toHaveLength(1)
    expect(revoked).toHaveLength(0)
    resource.dispose()
    expect(revoked).toEqual([url])
  })

  it('dispose aborts the in-flight request (unmount / task / account switch)', () => {
    let started: AbortSignal | undefined
    const resource = createVideoBlobResource((signal: AbortSignal) => {
      started = signal
      return new Promise<Blob>(() => undefined)
    })
    void resource.load().catch(() => undefined)
    resource.dispose()
    expect(started).toBeDefined()
    expect(started!.aborted).toBe(true)
  })

  it('does not revive cached bytes when an aborted loader resolves after dispose', async () => {
    const { created } = stubObjectUrls()
    let finish!: (blob: Blob) => void
    const resource = createVideoBlobResource(() => new Promise<Blob>(resolve => { finish = resolve }))
    const pending = resource.load()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resource.dispose()
    finish(new Blob(['old account bytes']))
    await rejected
    expect(resource.objectUrl()).toBeUndefined()
    expect(created).toHaveLength(0)
  })

  it('a late old rejection does not clear the new generation in-flight load', async () => {
    let calls = 0
    let failOld!: (error: Error) => void
    let finishNew!: (blob: Blob) => void
    const resource = createVideoBlobResource(() => {
      calls += 1
      return new Promise<Blob>((resolve, reject) => {
        if (calls === 1) failOld = reject
        else finishNew = resolve
      })
    })
    const old = resource.load()
    const rejection = expect(old).rejects.toThrow('old failed')
    resource.dispose()
    const current = resource.load()
    failOld(new Error('old failed'))
    await rejection
    expect(resource.load()).toBe(current)
    const blob = new Blob(['new account bytes'])
    finishNew(blob)
    await expect(current).resolves.toBe(blob)
    expect(calls).toBe(2)
  })

  it('the player and the download button share one user-triggered fetch', async () => {
    const payload = new Uint8Array([1, 2, 3])
    const fetchMock = vi.fn(async () => new Response(payload, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { created } = stubObjectUrls()
    vi.stubGlobal('document', {
      createElement: () => ({ href: '', download: '', rel: '', click: () => undefined, remove: () => undefined }),
      body: { append: () => undefined },
    })
    const registrations = captureRegistrations()
    const view = toolViewFor(registrations, 'grok_video_generate')
    const tree = expandTree(view({
      block: settledBlock('grok_video_generate', { prompt: 'p' }, [
        { type: 'text', text: taskJson({ attachment: { attachmentId: 'a', name: 'clip.mp4', bytes: payload.byteLength } }) },
      ]),
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    // Nothing is fetched before a user action.
    expect(fetchMock).not.toHaveBeenCalled()
    clickButton(tree, en.videoUiPlay)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // Download reuses the very same blob — no second request, one object URL.
    clickButton(tree, en.videoDownload)
    await new Promise<void>(resolve => { setTimeout(() => { resolve() }, 20) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
  })
})
