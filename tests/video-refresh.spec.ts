import { afterEach, describe, expect, it, vi } from 'vitest'

interface Slot { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }
const hooks = vi.hoisted(() => ({ slots: [] as Slot[], cursor: 0, effects: [] as Array<() => void> }))
vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    const slot = hooks.slots[index] ??= { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
    return [slot.value, (value: unknown) => { slot.value = typeof value === 'function' ? (value as (old: unknown) => unknown)(slot.value) : value }]
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++
    return (hooks.slots[index] ??= { value: { current: initial } }).value
  },
  useEffect: (setup: () => (() => void) | undefined, deps?: readonly unknown[]) => {
    const index = hooks.cursor++
    const slot = hooks.slots[index] ??= {}
    if (deps !== undefined && slot.deps !== undefined && deps.length === slot.deps.length && deps.every((value, i) => Object.is(value, slot.deps![i]))) return
    slot.deps = deps
    hooks.effects.push(() => { slot.cleanup?.(); slot.cleanup = setup() })
  },
}))
vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} })
  return { jsx, jsxs: jsx, Fragment: Symbol.for('Fragment') }
})
import { parseVideoTask, VideoMediaCard } from '../src/client/video-view.tsx'
import { en } from '../src/client/locales.ts'

interface Element { type: unknown; props: Record<string, unknown> }
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (typeof node !== 'object' || node === null || !('props' in node)) return []
  const element = node as Element
  return [element, ...elements(element.props.children)]
}
function draw(props: Parameters<typeof VideoMediaCard>[0]): Element {
  hooks.cursor = 0
  hooks.effects = []
  const tree = VideoMediaCard(props)
  expect(tree).not.toBeNull()
  for (const effect of hooks.effects) effect()
  return tree as unknown as Element
}
/** Flush every pending microtask chain: ActionButton.onClick returns void, so
 *  the caller's promise cannot be awaited — a macrotask turn is what actually
 *  lets the card's async load settle. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
const taskId = '11111111-2222-3333-4444-555555555555'
const otherTaskId = '11111111-2222-3333-4444-555555555556'
const doneTask = (id: string) => parseVideoTask({ taskId: id, state: 'done', attachment: { attachmentId: `file-${id}`, name: `${id}.mp4`, bytes: 4 } })!

/** The action button rendered with this label (or undefined). */
function action(tree: Element, label: string): Element | undefined {
  return elements(tree.props.actions).find(node => node.props.label === label)
}
/** The player's "load the bytes" preview button. */
function playButton(tree: Element): Element {
  const button = elements(tree.props.preview).find(node => node.props['data-testid'] === 'grok-video-preview')
  expect(button).toBeDefined()
  return button!
}
const noticeOf = (tree: Element): string => tree.props.notice === undefined ? '' : JSON.stringify(tree.props.notice)

afterEach(() => {
  for (const slot of hooks.slots) slot.cleanup?.()
  hooks.slots = []
  hooks.effects = []
  vi.unstubAllGlobals()
})

describe('video refresh wins over an older query', () => {
  it.each(['refresh', 'replace'] as const)('keeps the newer reported task after %s even if an aborted fetch resolves late', async change => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      // Deliberately ignore cancellation to exercise the late-success guard.
      return new Promise<Response>(resolve => { finish = resolve })
    })
    vi.stubGlobal('fetch', fetch)
    const pending = parseVideoTask({ taskId, state: 'pending' })!
    const first = draw({ task: pending, resetToken: 0 })
    const query = action(first, en.videoUiQuery)
    expect(query).toBeDefined()
    ;(query!.props.onClick as () => void)()
    expect(fetch).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(false)
    const done = parseVideoTask({ taskId: change === 'replace' ? otherTaskId : taskId, state: 'done' })!
    const props = { task: done, resetToken: change === 'refresh' ? 1 : 0 }
    expect(draw(props).props.status).toBe(en.taskStateDone)
    const abortedOnRefresh = signal?.aborted
    finish(new Response(JSON.stringify({ taskId, state: 'interrupted' })))
    await settle()
    const final = draw(props)
    expect(final.props.status).toBe(en.taskStateDone)
    expect(abortedOnRefresh).toBe(true)
    expect(final.props.actions).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

/**
 * The lazy media resource is bound to ONE task. Replacing the task disposes it,
 * so a load the user started before the replacement can only end in an error —
 * and that error belongs to a task the card no longer shows. The card must not
 * paint it (nor a "downloaded" mark) onto the replacement task.
 */
describe('a late media load never leaks into the replacement task', () => {
  it('drops the aborted download of a replaced task without a spurious error', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const first = draw({ task: doneTask(taskId) })
    const download = action(first, en.videoDownload)
    expect(download).toBeDefined()
    ;(download!.props.onClick as () => void)()
    expect(fetch).toHaveBeenCalledOnce()
    // The card is rebound to another task while the bytes are still loading.
    const next = { task: doneTask(otherTaskId) }
    draw(next)
    finish(new Response(new Uint8Array([1, 2, 3, 4])))
    await settle()
    const after = draw(next)
    expect(after.props.status).toBe(en.taskStateDone)
    expect(after.props.notice).toBeUndefined()
    expect(action(after, en.videoCardRedownload)).toBeUndefined()
    expect(action(after, en.videoDownload)).toBeDefined()
  })

  it('drops a late download rejection that is not an abort', async () => {
    let fail!: (error: Error) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject })))
    const first = draw({ task: doneTask(taskId) })
    ;(action(first, en.videoDownload)!.props.onClick as () => void)()
    const next = { task: doneTask(otherTaskId) }
    draw(next)
    fail(new Error('upstream exploded'))
    await settle()
    const after = draw(next)
    expect(after.props.notice).toBeUndefined()
    expect(action(after, en.videoCardRedownload)).toBeUndefined()
  })

  it('drops a late play rejection from the replaced task', async () => {
    let fail!: (error: Error) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject })))
    const first = draw({ task: doneTask(taskId) })
    ;(playButton(first).props.onClick as () => void)()
    const next = { task: doneTask(otherTaskId) }
    draw(next)
    fail(new Error('playback bytes vanished'))
    await settle()
    const after = draw(next)
    expect(after.props.status).toBe(en.taskStateDone)
    expect(after.props.notice).toBeUndefined()
    // The replacement task is still waiting for its own user action.
    expect(elements(after.props.preview).some(node => node.props['data-testid'] === 'grok-video-player')).toBe(false)
    expect(playButton(after)).toBeDefined()
  })

  it('still reports a failure for the task the card is actually showing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('HTTP 503') }))
    const props = { task: doneTask(taskId) }
    ;(action(draw(props), en.videoDownload)!.props.onClick as () => void)()
    await settle()
    const after = draw(props)
    expect(noticeOf(after)).toContain(en.videoDownloadFailed)
    expect(noticeOf(after)).toContain('HTTP 503')
    expect(action(after, en.videoCardRedownload)).toBeUndefined()
  })

  it('still downloads the task the card is showing', async () => {
    const clicks: Array<{ href: string; download: string }> = []
    vi.stubGlobal('document', {
      createElement: () => ({
        href: '', download: '', rel: '',
        click(this: { href: string; download: string }) { clicks.push({ href: this.href, download: this.download }) },
        remove: () => undefined,
      }),
      body: { append: () => undefined },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))))
    const props = { task: doneTask(taskId) }
    ;(action(draw(props), en.videoDownload)!.props.onClick as () => void)()
    // Reading the body crosses more than one microtask turn, so wait it out.
    // Reading the body crosses more than one microtask turn, so wait it out.
    await vi.waitFor(() => expect(clicks).toHaveLength(1))
    const after = draw(props)
    expect(clicks).toEqual([{ href: expect.stringContaining('blob:'), download: `${taskId}.mp4` }])
    expect(action(after, en.videoCardRedownload)).toBeDefined()
  })
})
