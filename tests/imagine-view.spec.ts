/**
 * Regression tests for the merged imagine views (formerly dsh-grok-imagine-ui),
 * redesigned onto the shared MediaCardFrame.
 *
 * Components are invoked directly against a fake react and their element trees
 * are RECURSIVELY EXPANDED — calling a component once only yields an
 * unrendered element, which would make assertions pass vacuously (the lesson
 * recorded in the former plugin's FIX-null-render-save-path.md).
 *
 * Covered here:
 *   1. the two production fixes carried over during the merge:
 *      save_path calls fall back to a visible text card, and both
 *      grok_imagine / grok_imagine_edit render with the right title verb.
 *   2. attachmentId dedup inside one result while distinct images survive.
 *   3. collapsed details: prompt / raw result / full attachment refs / tech
 *      info live behind <details> (closed by default), never in the preview;
 *      a text-only result stays visible without expanding anything.
 *   4. localisation: every operation and status label comes from the imageUi*
 *      locale — English fallback renders no Chinese, the zh translator renders
 *      Chinese. Existing Chinese expectations assert through locale keys.
 *   5. stop waiting is pending-only, fires session.cancel only on an explicit
 *      click, never auto-issues a request, and always carries the billing
 *      honesty note; regenerate likewise only runs on user click.
 *   6. slot registration contract (two toolviews + one tail, inject provides
 *      sessions + translator) and turn-tail protection: per-turn aggregation,
 *      cross-node callId dedup, null when empty, Codex source legend.
 *   7. lightbox lifecycle: an open viewer survives a later re-render of its
 *      own card (the close callback keeps a stable identity, so the modal
 *      effect is not torn down and re-opened on every unrelated state change).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Minimal stateful hook runtime, INERT unless a test installs it into
 * `hookRuntime`. With no runtime active every hook keeps its stateless
 * behaviour, so the rest of this file renders exactly as before. The runtime
 * exists for the effect/lifecycle regressions below: it keeps hook slots
 * across render passes, attaches host refs, and replays effect cleanups when
 * an effect's dependencies change — the behaviour React performs on a
 * re-render. It never re-renders by itself; the test drives the passes.
 */
interface HookRuntime {
  beginPass: () => void
  commit: (hosts: HostNode[]) => void
  useCallback: (fn: unknown, deps?: readonly unknown[]) => unknown
  useEffect: (fn: () => unknown, deps?: readonly unknown[]) => void
  useRef: (initial: unknown) => { current: unknown }
  useState: (initial: unknown) => [unknown, (next: unknown) => void]
}

interface HostNode {
  ref: unknown
  node: Record<string, unknown>
  onClose?: unknown
}

interface HookSlot {
  value?: unknown
  deps?: readonly unknown[]
  cleanup?: () => void
  fn?: () => unknown
}

const hookRuntime = vi.hoisted(() => ({ current: null as HookRuntime | null }))

vi.mock('react', () => ({
  useCallback: (fn: unknown, deps?: readonly unknown[]) => hookRuntime.current === null ? fn : hookRuntime.current.useCallback(fn, deps),
  useEffect: (fn: () => unknown, deps?: readonly unknown[]) => { hookRuntime.current?.useEffect(fn, deps) },
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => hookRuntime.current === null ? { current: initial } : hookRuntime.current.useRef(initial),
  useState: (initial: unknown) => hookRuntime.current === null
    ? [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined]
    : hookRuntime.current.useState(initial),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}))
vi.mock('react/jsx-runtime', () => {
  const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({ type, props: props ?? {}, key })
  return { jsx, jsxs: jsx, Fragment: Symbol.for('Fragment') }
})

import { applyImagineViews, regenerateText } from '../src/client/imagine-view.tsx'
import { en, zh } from '../src/client/locales.ts'

interface Registration {
  spec: { name: string; key?: string; id?: string; inject?: () => unknown }
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
  // No `locale` on this context on purpose: the views must fall back to
  // English copy when the host context lacks the locale service.
  applyImagineViews({ inject: (_deps: string[], cb: (s: typeof scope) => void) => { cb(scope) } } as never)
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
  const element = node as { type: unknown; props: Record<string, unknown> }
  if (typeof element.type === 'function') {
    renderDeep((element.type as (props: Record<string, unknown>) => unknown)(element.props), out)
    return out
  }
  if (typeof element.type === 'string') out.tags.push(element.type)
  renderDeep(element.props.children, out)
  return out
}

/** Expand component elements to their final rendered value (null included). */
function expandValue(node: unknown): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const element = node as { type: unknown; props: Record<string, unknown> }
    if (typeof element.type === 'function') {
      return expandValue((element.type as (props: Record<string, unknown>) => unknown)(element.props))
    }
  }
  return node
}

/** All rendered text EXCEPT the contents of collapsed <details> subtrees. */
function textsOutsideDetails(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) textsOutsideDetails(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  const element = node as { type: unknown; props: Record<string, unknown> }
  if (typeof element.type === 'function') {
    textsOutsideDetails((element.type as (props: Record<string, unknown>) => unknown)(element.props), out)
    return out
  }
  if (element.type === 'details') return out
  textsOutsideDetails(element.props.children, out)
  return out
}

/** Collect every concrete (non-function) element in the expanded tree. */
function collectElements(node: unknown, out: Array<{ type: unknown; props: Record<string, unknown> }> = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') return out
  const element = node as { type: unknown; props: Record<string, unknown> }
  if (typeof element.type === 'function') {
    collectElements((element.type as (props: Record<string, unknown>) => unknown)(element.props), out)
    return out
  }
  out.push(element)
  collectElements(element.props.children, out)
  return out
}

/** Find a rendered <button> by its exact label and return its onClick. */
function findButton(node: unknown, label: string): (() => void) | undefined {
  if (node === null || node === undefined || typeof node === 'boolean') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node === 'string' || typeof node === 'number') return undefined
  const element = node as { type: unknown; props: Record<string, unknown> }
  if (typeof element.type === 'function') {
    return findButton((element.type as (props: Record<string, unknown>) => unknown)(element.props), label)
  }
  if (element.type === 'button' && element.props.children === label) {
    return element.props.onClick as () => void
  }
  return findButton(element.props.children, label)
}

const IMAGE_REF = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 1234,
  width: 2,
  height: 2,
  name: 'grok-imagine-edit.png',
}

const OTHER_IMAGE_REF = {
  attachmentId: `sha256:${'b'.repeat(64)}`,
  mediaType: 'image/jpeg',
  bytes: 4096,
  width: 8,
  height: 8,
  name: 'second-result.jpg',
}

function settledBlock(name: string, args: Record<string, unknown>, content: unknown[], isError = false): unknown {
  return { kind: 'call', call: { name, argsRaw: JSON.stringify(args) }, content, isError, callId: 'c1', seq: 1 }
}

const SESSIONS = { binding: () => undefined }
/** Chinese translator injected with the slot; absent in the English tests. */
const zhT = (key: keyof typeof zh): string => zh[key]

describe('edit regeneration', () => {
  it('retains all source images and rendering parameters', () => {
    const text = regenerateText('grok_imagine_edit', 'original prompt', {
      image: 'first.png', images: ['second.png', 'third.png'], aspect_ratio: '16:9', resolution: '2k', n: 1,
    })
    expect(text).toContain('["first.png","second.png","third.png"]')
    expect(text).toContain('"aspect_ratio":"16:9"')
    expect(text).toContain('"resolution":"2k"')
    expect(text).toContain('original prompt')
  })

  it('refers to all original inputs instead of copying a large data URI', () => {
    const args = { image: 'data:'.padEnd(1000, 'A'), images: ['extra.png'] }
    // Locale-driven copy: zh translator renders the Chinese phrase…
    const zhText = regenerateText('grok_imagine_edit', 'p', args, zhT)
    expect(zhText).toContain(zh.imageUiEditSourcesFallback)
    expect(zhText).not.toContain('A'.repeat(100))
    // …and the English fallback renders the English phrase, never Chinese.
    const enText = regenerateText('grok_imagine_edit', 'p', args)
    expect(enText).toContain(en.imageUiEditSourcesFallback)
    expect(enText).not.toContain(zh.imageUiEditSourcesFallback)
    expect(enText).not.toContain('A'.repeat(100))
  })

  it('trims sources before measuring and embedding them', () => {
    const text = regenerateText('grok_imagine_edit', 'p', { image: '  first.png  ', images: ['  second.png'] })
    expect(text).toContain('["first.png","second.png"]')
    expect(text).not.toContain('  first.png')
  })

  it('uses the locale phrase for text-to-image regeneration', () => {
    expect(regenerateText('grok_imagine', 'p', undefined)).toContain(en.imageUiRegenerateText)
    expect(regenerateText('grok_imagine', 'p', undefined, zhT)).toContain(zh.imageUiRegenerateText)
  })
})

describe('imagine views (merged from dsh-grok-imagine-ui)', () => {
  const registrations = captureRegistrations()

  it('registers toolview occupants for both grok tools and one turn tail', () => {
    const keys = registrations.filter(entry => entry.spec.name === 'tool.call.toolview').map(entry => entry.spec.key)
    expect(keys).toEqual(expect.arrayContaining(['grok_imagine', 'grok_imagine_edit']))
    expect(keys).toHaveLength(2)
    expect(registrations.some(entry => entry.spec.name === 'conversation.chat.turnTail')).toBe(true)
  })

  it('slot inject provides the sessions service and an English translator', () => {
    const toolview = registrations.find(entry => entry.spec.name === 'tool.call.toolview')!
    expect(typeof toolview.spec.inject).toBe('function')
    const injected = toolview.spec.inject!() as { sessions: unknown; t: (key: keyof typeof en) => string }
    expect(injected.sessions).toBeDefined()
    expect(typeof injected.t).toBe('function')
    expect(injected.t('imageUiGenerated')).toBe(en.imageUiGenerated)
    const tail = registrations.find(entry => entry.spec.name === 'conversation.chat.turnTail')!
    expect(typeof tail.spec.inject!()).toBe('object')
  })

  it('keeps save_path calls visible as a text card instead of returning null (FIX-null-render-save-path)', () => {
    const view = toolViewFor(registrations, 'grok_imagine_edit')
    const block = settledBlock('grok_imagine_edit', { prompt: 'sketch it', image: 'x', save_path: 'out.png' }, [
      { type: 'text', text: 'Saved to /tmp/ws/out.jpg' },
    ])
    const result = view({ block, sessionId: 's1', sessions: SESSIONS })
    expect(result).not.toBeNull()
    const out = renderDeep(result)
    expect(out.texts).toContain(en.imageUiResult)
    expect(out.texts).toContain('Saved to /tmp/ws/out.jpg')
    expect(out.texts).toContain('sketch it')
    expect(out.texts).toContain(en.imageUiEdited)
    // No media means no hiding: the fallback text is readable without expanding details.
    const outside = textsOutsideDetails(result)
    expect(outside).toContain('Saved to /tmp/ws/out.jpg')
    expect(outside).toContain(en.imageUiResult)
  })

  it('renders image results for both tools with the right title verb', () => {
    const editView = toolViewFor(registrations, 'grok_imagine_edit')
    const editOut = renderDeep(editView({
      block: settledBlock('grok_imagine_edit', { prompt: 'p', image: 'x' }, [{ type: 'image', attachment: IMAGE_REF }]),
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    expect(editOut.texts).toContain(en.imageUiEdited)

    const genView = toolViewFor(registrations, 'grok_imagine')
    const genTree = genView({
      block: settledBlock('grok_imagine', { prompt: 'p' }, [{ type: 'image', attachment: IMAGE_REF }]),
      sessionId: 's1',
      sessions: SESSIONS,
    })
    const genOut = renderDeep(genTree)
    expect(genOut.texts).toContain(en.imageUiGenerated)
    // effects are stubbed out, so frames stay on their loading placeholder
    expect(genOut.texts).toContain(en.imageUiLoadingImage)
    // media-first: the gallery exists and the key specs sit outside details
    expect(collectElements(genTree).some(element => (element.props as Record<string, unknown>)['data-testid'] === 'grok-imagine-gallery')).toBe(true)
    expect(genOut.texts.join(' ')).toContain('2×2 · PNG · 1.2 KB')
    expect(textsOutsideDetails(genTree).join(' ')).toContain('2×2 · PNG · 1.2 KB')
    // primary actions: view large and download
    expect(findButton(genTree, en.imageUiViewLarge)).toBeDefined()
    expect(findButton(genTree, en.imageUiDownload)).toBeDefined()
    // English UI must never leak Chinese copy.
    expect(genOut.texts.join(' ')).not.toMatch(/[一-鿿]/u)
  })

  it('returns null only when there are neither images nor text', () => {
    const view = toolViewFor(registrations, 'grok_imagine')
    const result = view({ block: settledBlock('grok_imagine', { prompt: 'p' }, []), sessionId: 's1', sessions: SESSIONS })
    // Expand to the final value: the wrapper returns an element whose inner
    // card returns null (asserting on the wrapper element would false-pass).
    expect(expandValue(result)).toBeNull()
  })

  it('shows a failure card for errored calls and a generating card for pending ones', () => {
    const view = toolViewFor(registrations, 'grok_imagine')
    const failed = renderDeep(view({ block: settledBlock('grok_imagine', { prompt: 'p' }, [], true), sessionId: 's1', sessions: SESSIONS }))
    expect(failed.texts).toContain(en.imageUiGenerateFailed)
    const pendingTree = view({ block: { phase: 'start', argsRaw: JSON.stringify({ prompt: 'p' }) }, sessionId: 's1', sessions: SESSIONS })
    const pending = renderDeep(pendingTree)
    expect(pending.texts).toContain(en.imageUiGenerating)
    expect(pending.texts.join(' ')).toContain('p')
    expect(pending.tags).toContain('progress')
  })

  it('shows an edit-specific failure title for errored grok_imagine_edit calls', () => {
    const view = toolViewFor(registrations, 'grok_imagine_edit')
    const failed = renderDeep(view({ block: settledBlock('grok_imagine_edit', { prompt: 'p', image: 'x' }, [], true), sessionId: 's1', sessions: SESSIONS }))
    expect(failed.texts).toContain(en.imageUiEditFailed)
    expect(failed.texts).not.toContain(en.imageUiGenerateFailed)
  })

  it('dedupes repeated attachmentIds inside one result but keeps distinct images', () => {
    const view = toolViewFor(registrations, 'grok_imagine')
    const duplicated = renderDeep(view({
      block: settledBlock('grok_imagine', { prompt: 'p' }, [
        { type: 'image', attachment: IMAGE_REF },
        { type: 'image', attachment: IMAGE_REF },
      ]),
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    expect(duplicated.texts.filter(text => text === en.imageUiLoadingImage)).toHaveLength(1)
    expect(duplicated.texts.filter(text => text.startsWith('attachmentId: '))).toHaveLength(1)

    const distinct = renderDeep(view({
      block: settledBlock('grok_imagine', { prompt: 'p' }, [
        { type: 'image', attachment: IMAGE_REF },
        { type: 'image', attachment: OTHER_IMAGE_REF },
      ]),
      sessionId: 's1',
      sessions: SESSIONS,
    }))
    expect(distinct.texts.filter(text => text === en.imageUiLoadingImage)).toHaveLength(2)
    expect(distinct.texts.filter(text => text.startsWith('attachmentId: '))).toHaveLength(2)
    expect(distinct.texts.join(' ')).toContain('second-result.jpg')
  })

  it('folds prompt, raw result, full refs and tech info into a closed details element', () => {
    const view = toolViewFor(registrations, 'grok_imagine')
    const tree = view({
      block: settledBlock('grok_imagine', { prompt: 'secret prompt' }, [
        { type: 'image', attachment: IMAGE_REF },
        { type: 'text', text: 'raw upstream payload' },
      ]),
      sessionId: 's1',
      sessions: SESSIONS,
    })
    const out = renderDeep(tree)
    const details = collectElements(tree).find(element => element.type === 'details')
    expect(details).toBeDefined()
    // closed by default — content only renders after the user expands it
    expect(details!.props.open === undefined || details!.props.open === false).toBe(true)
    expect(out.texts).toContain(en.imageUiDetails)
    // everything long lives inside the details subtree…
    expect(out.texts).toContain('secret prompt')
    expect(out.texts).toContain('raw upstream payload')
    expect(out.texts.join(' ')).toContain(`attachmentId: ${IMAGE_REF.attachmentId}`)
    const outside = textsOutsideDetails(tree)
    expect(outside).not.toContain('secret prompt')
    expect(outside).not.toContain('raw upstream payload')
    expect(outside.join(' ')).not.toContain(`attachmentId: ${IMAGE_REF.attachmentId}`)
    // …while the media stays in the preview area.
    expect(outside.join(' ')).toContain(en.imageUiLoadingImage)
  })

  it('stop waiting is pending-only, fires only on click, and never claims billing stops', async () => {
    const cancel = vi.fn(async () => ({ ok: true }))
    const prompt = vi.fn(async () => ({ ok: true }))
    const sessions = { binding: () => ({ session: { cancel, prompt } }) }
    const view = toolViewFor(registrations, 'grok_imagine')

    const pendingTree = view({ block: { phase: 'start', argsRaw: JSON.stringify({ prompt: 'p' }) }, sessionId: 's1', sessions })
    const pending = renderDeep(pendingTree)
    // Billing honesty note is present in both locales' copy…
    expect(pending.texts.join(' ')).toContain(en.imageUiStopNotice)
    expect(en.imageUiStopNotice).toMatch(/does not cancel upstream generation or stop billing/u)
    expect(zh.imageUiStopNotice).toContain('计费')
    // …and nothing runs until the user actually clicks.
    expect(cancel).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    const stop = findButton(pendingTree, en.imageUiStopWaiting)
    expect(stop).toBeDefined()
    stop!()
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(cancel).toHaveBeenCalledWith()
    expect(prompt).not.toHaveBeenCalled()

    // Settled cards must not offer stop waiting at all.
    const doneTree = view({
      block: settledBlock('grok_imagine', { prompt: 'p' }, [{ type: 'image', attachment: IMAGE_REF }]),
      sessionId: 's1',
      sessions,
    })
    expect(findButton(doneTree, en.imageUiStopWaiting)).toBeUndefined()
    expect(renderDeep(doneTree).texts.join(' ')).not.toContain(en.imageUiStopNotice)
  })

  it('regenerates only after an explicit click, never on render', async () => {
    const prompt = vi.fn(async (_parts: Array<{ type: string; text: string }>, _mode: string) => ({ ok: true }))
    const sessions = { binding: () => ({ session: { prompt } }) }
    const view = toolViewFor(registrations, 'grok_imagine')
    const tree = view({
      block: settledBlock('grok_imagine', { prompt: 'p' }, [{ type: 'image', attachment: IMAGE_REF }]),
      sessionId: 's1',
      sessions,
    })
    renderDeep(tree)
    expect(prompt).not.toHaveBeenCalled()
    const regenerate = findButton(tree, en.imageUiRegenerate)
    expect(regenerate).toBeDefined()
    regenerate!()
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    const [parts, mode] = prompt.mock.calls[0]!
    expect(mode).toBe('queue')
    expect(parts[0]!.text).toContain('p')
    expect(parts[0]!.text).toContain(en.imageUiRegenerateText)
  })

  it('renders the zh translator for actions and statuses', () => {
    const view = toolViewFor(registrations, 'grok_imagine')
    const done = renderDeep(view({
      block: settledBlock('grok_imagine', { prompt: 'p' }, [{ type: 'image', attachment: IMAGE_REF }]),
      sessionId: 's1',
      sessions: SESSIONS,
      t: zhT,
    }))
    expect(done.texts).toContain(zh.imageUiGenerated)
    expect(done.texts).toContain(zh.imageUiStatusDone)
    expect(done.texts).toContain(zh.imageUiDownload)
    expect(done.texts).toContain(zh.imageUiDetails)

    const pending = renderDeep(view({
      block: { phase: 'start', argsRaw: JSON.stringify({ prompt: 'p' }) },
      sessionId: 's1',
      sessions: SESSIONS,
      t: zhT,
    }))
    expect(pending.texts).toContain(zh.imageUiGenerating)
    expect(pending.texts).toContain(zh.imageUiStopWaiting)
    expect(pending.texts.join(' ')).toContain(zh.imageUiStopNotice)

    const failed = renderDeep(view({
      block: settledBlock('grok_imagine', { prompt: 'p' }, [], true),
      sessionId: 's1',
      sessions: SESSIONS,
      t: zhT,
    }))
    expect(failed.texts).toContain(zh.imageUiGenerateFailed)
  })

  it('turn tail aggregates the turn image results and falls back to null when empty', () => {
    const tail = registrations.find(entry => entry.spec.name === 'conversation.chat.turnTail')!.component as (props: Record<string, unknown>) => unknown
    const useChat = (selector: (chat: unknown) => unknown) => selector({
      nodes: { turnDataSource: () => ({ subscribe: () => () => undefined, getSnapshot: () => [{ root: settledBlock('grok_imagine', { prompt: 'turn' }, [{ type: 'image', attachment: IMAGE_REF }]) }] }) },
    })
    const out = renderDeep(tail({ turn: { turn: {} }, sessionId: 's1', sessions: SESSIONS, useChat }))
    expect(out.texts).toContain(en.imageUiGenerated)
    expect(out.texts.join(' ')).toContain('turn')

    const emptyUseChat = (selector: (chat: unknown) => unknown) => selector({
      nodes: { turnDataSource: () => ({ subscribe: () => () => undefined, getSnapshot: () => [] }) },
    })
    expect(tail({ turn: { turn: {} }, sessionId: 's1', sessions: SESSIONS, useChat: emptyUseChat })).toBeNull()
  })

  it('renders one card per callId even when two nodes carry the same call', () => {
    const tail = registrations.find(entry => entry.spec.name === 'conversation.chat.turnTail')!.component as (props: Record<string, unknown>) => unknown
    const block = settledBlock('grok_imagine', { prompt: 'dupe prompt' }, [{ type: 'image', attachment: IMAGE_REF }])
    const useChat = (selector: (chat: unknown) => unknown) => selector({
      nodes: { values: () => [
        { kind: 'tool-call', location: { kind: 'turn', turn: { turn: 1, status: 'closed' } }, data: { root: block } },
        { kind: 'tool-call', location: { kind: 'turn', turn: { turn: 1, status: 'closed' } }, data: { root: block } },
      ] },
    })
    const out = renderDeep(tail({ owner: { turn: { turn: 1 }, seq: 5 }, useChat }))
    expect(out.texts.filter(text => text === 'dupe prompt')).toHaveLength(1)
  })

  it('keeps the purple source legend for Codex images of the same turn', () => {
    const tail = registrations.find(entry => entry.spec.name === 'conversation.chat.turnTail')!.component as (props: Record<string, unknown>) => unknown
    const grok = settledBlock('grok_imagine', { prompt: 'grok p' }, [{ type: 'image', attachment: IMAGE_REF }])
    const codex = {
      kind: 'call',
      call: { name: 'codex_connect_image_generate', argsRaw: '{}' },
      content: [{ type: 'image', attachment: OTHER_IMAGE_REF }],
      callId: 'codex-1',
      seq: 2,
    }
    const useChat = (selector: (chat: unknown) => unknown) => selector({
      nodes: { turnDataSource: () => ({ subscribe: () => () => undefined, getSnapshot: () => [{ root: grok }, { root: codex }] }) },
    })
    const out = renderDeep(tail({ turn: { turn: {} }, sessionId: 's1', sessions: SESSIONS, useChat }))
    expect(out.texts.join(' ')).toContain(`${en.imageUiCodexLegendA}1${en.imageUiCodexLegendB}`)
    // without Codex images the legend is not rendered at all
    const grokOnly = (selector: (chat: unknown) => unknown) => selector({
      nodes: { turnDataSource: () => ({ subscribe: () => () => undefined, getSnapshot: () => [{ root: grok }] }) },
    })
    const plain = renderDeep(tail({ turn: { turn: {} }, sessionId: 's1', sessions: SESSIONS, useChat: grokOnly }))
    expect(plain.texts.join(' ')).not.toContain(en.imageUiCodexLegendA)
  })
})

describe('actual DSH owner contract', () => {
  it('shows prompt and all local inputs for a running call without phase', () => {
    const view = toolViewFor(captureRegistrations(), 'grok_imagine_edit')
    const rendered = renderDeep(view({ sessionId: 's', sessions: SESSIONS, owner: {
      block: { name: 'grok_imagine_edit', argsRaw: JSON.stringify({ prompt: 'snow scene', image: 'input.png', images: ['second.png'] }) },
      openFile: () => undefined,
    } }))
    expect(rendered.texts.join(' ')).toContain('snow scene')
    expect(rendered.texts.join(' ')).toContain('input.png')
    expect(rendered.texts.join(' ')).toContain('second.png')
    expect(rendered.tags).toContain('progress')
  })
  it('renders settled results from owner.block', () => {
    const view = toolViewFor(captureRegistrations(), 'grok_imagine')
    const rendered = renderDeep(view({ owner: { block: settledBlock('grok_imagine', { prompt: 'test prompt' }, [{ type: 'image', attachment: IMAGE_REF }]) } }))
    expect(rendered.texts.join(' ')).toContain('test prompt')
    expect(rendered.tags).toContain('details')
  })
})

it('aggregates the actual DSH ChatNodeStore values from owner turn', () => {
  const tail = captureRegistrations().find(entry => entry.spec.name === 'conversation.chat.turnTail')!.component as (props: Record<string, unknown>) => unknown
  const block = settledBlock('grok_imagine', { prompt: 'tail prompt' }, [{ type: 'image', attachment: IMAGE_REF }])
  // Real node.location is a ConversationLocation: the turn branch carries a
  // TurnLocation object, so the numeric id lives at location.turn.turn.
  const useChat = (select: Function) => select({ nodes: { values: () => [
    { kind: 'tool-call', location: { kind: 'turn', turn: { turn: 1, status: 'closed' } }, data: { root: block } },
    { kind: 'tool-call', location: { kind: 'turn', turn: { turn: 2, status: 'closed' } }, data: { root: block } },
  ] } })
  const out = renderDeep(tail({ owner: { turn: { turn: 1 }, seq: 5 }, useChat }))
  expect(out.texts.filter(text => text === 'tail prompt')).toHaveLength(1)
})

// ---------------------------------------------------------------------------
// Effect / lifecycle harness (used only by the lightbox regression below)
// ---------------------------------------------------------------------------

function createHookRuntime(): HookRuntime {
  const slots: HookSlot[] = []
  let cursor = 0
  let pending: HookSlot[] = []
  let effects: HookSlot[] = []
  const changed = (before: readonly unknown[] | undefined, after: readonly unknown[] | undefined): boolean => {
    if (before === undefined || after === undefined) return true
    return before.length !== after.length || after.some((value, index) => !Object.is(value, before[index]))
  }
  const slot = (): HookSlot => {
    const index = cursor++
    slots[index] ??= {} as HookSlot
    return slots[index]!
  }
  return {
    beginPass: () => { cursor = 0; pending = [] },
    commit: hosts => {
      for (const host of hosts) {
        host.node['onclose'] = host.onClose
        const ref = host.ref
        if (typeof ref === 'function') (ref as (node: unknown) => void)(host.node)
        else if (ref !== null && typeof ref === 'object') (ref as { current: unknown }).current = host.node
      }
      for (const [index, next] of pending.entries()) {
        const previous = effects[index]
        // React keeps a mounted effect in place while its dependencies hold.
        if (previous !== undefined && !changed(previous.deps, next.deps)) continue
        previous?.cleanup?.()
        const returned = next.fn?.()
        next.cleanup = typeof returned === 'function' ? (returned as () => void) : undefined
      }
      effects = pending
    },
    useCallback: (fn, deps) => {
      const current = slot()
      if (!('deps' in current) || deps === undefined || changed(current.deps, deps)) {
        current.deps = deps
        current.value = fn
      }
      return current.value
    },
    useEffect: (fn, deps) => { pending.push({ fn, deps }) },
    useRef: initial => {
      const current = slot()
      if (!('value' in current)) current.value = { current: initial }
      return current.value as { current: unknown }
    },
    useState: initial => {
      const current = slot()
      if (!('value' in current)) current.value = typeof initial === 'function' ? (initial as () => unknown)() : initial
      return [current.value, (next: unknown) => {
        current.value = typeof next === 'function' ? (next as (previous: unknown) => unknown)(current.value) : next
      }]
    },
  }
}

interface FakeDialog {
  open: boolean
  closes: number
  showModal: () => void
  close: () => void
  addEventListener: () => void
  removeEventListener: () => void
  onclose?: () => void
}

function createFakeDialog(): FakeDialog {
  const dialog: FakeDialog = {
    open: false,
    closes: 0,
    showModal: () => { dialog.open = true },
    close: () => {
      if (!dialog.open) return
      dialog.open = false
      dialog.closes += 1
      dialog.onclose?.()
    },
    addEventListener: () => { undefined },
    removeEventListener: () => { undefined },
  }
  return dialog
}

interface Pass {
  dialog: (FakeDialog & Record<string, unknown>) | undefined
  button: (label: string) => (() => void) | undefined
}

/**
 * One render pass: expand every component exactly once, then attach the host
 * refs and replay the effects. Host nodes are keyed by their position in the
 * tree and kept between passes, the way React reuses the DOM nodes it already
 * created — a re-render therefore acts on the very same `<dialog>` the viewer
 * opened, which is what makes the lifecycle assertion meaningful.
 */
function renderPass(runtime: HookRuntime, view: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>, nodes: Map<string, Record<string, unknown>>): Pass {
  runtime.beginPass()
  const hosts: HostNode[] = []
  const buttons = new Map<string, () => void>()
  const expand = (node: unknown, path: string): void => {
    if (Array.isArray(node)) { node.forEach((child, index) => { expand(child, `${path}.${String(index)}`) }); return }
    if (node === null || node === undefined || typeof node !== 'object') return
    const element = node as { type: unknown; props: Record<string, unknown>; ref?: unknown }
    if (typeof element.type === 'function') { expand((element.type as (inner: Record<string, unknown>) => unknown)(element.props), path); return }
    const key = `${path}:${String(element.type)}`
    if (element.type === 'button' && typeof element.props.children === 'string' && typeof element.props.onClick === 'function') {
      buttons.set(element.props.children, element.props.onClick as () => void)
    }
    const host = nodes.get(key) ?? (element.type === 'dialog' ? createFakeDialog() as unknown as Record<string, unknown> : {})
    nodes.set(key, host)
    hosts.push({
      // The automatic JSX runtime keeps `ref` beside props, not inside them.
      ref: element.ref ?? element.props.ref,
      node: host,
      onClose: element.props.onClose,
    })
    expand(element.props.children, key)
  }
  expand(view(props), '')
  runtime.commit(hosts)
  const dialog = hosts.find(host => host.node['open'] !== undefined)?.node
  return {
    dialog: dialog as (FakeDialog & Record<string, unknown>) | undefined,
    button: label => buttons.get(label),
  }
}

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('image lightbox lifecycle', () => {
  afterEach(() => {
    hookRuntime.current = null
    vi.restoreAllMocks()
  })

  it('keeps an open lightbox open when its own card re-renders', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:imagine/1')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => { undefined })
    const sessions = {
      binding: () => ({
        session: {
          readAttachment: (attachmentId: string) => Promise.resolve({
            ok: true,
            value: { attachment: { attachmentId, mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3]) },
          }),
        },
      }),
    }
    const runtime = createHookRuntime()
    const nodes = new Map<string, Record<string, unknown>>()
    hookRuntime.current = runtime
    const view = toolViewFor(captureRegistrations(), 'grok_imagine')
    const props = {
      block: settledBlock('grok_imagine', { prompt: 'a lighthouse' }, [{ type: 'image', attachment: IMAGE_REF }]),
      sessionId: 's1',
      sessions,
    }

    // First paint: the result card, no viewer yet.
    const first = renderPass(runtime, view, props, nodes)
    expect(first.dialog).toBeUndefined()

    // Explicit user action opens the viewer.
    const open = first.button(en.imageUiViewLarge)
    expect(open).toBeDefined()
    open!()
    await settle()

    const opened = renderPass(runtime, view, props, nodes)
    expect(opened.dialog?.['open']).toBe(true)

    // An unrelated re-render of the same card (a second image finishing its
    // load, the copy hint resetting, a turn-store update) must leave the open
    // viewer alone: its modal effect is keyed on a stable close callback.
    const again = renderPass(runtime, view, props, nodes)
    expect(again.dialog?.['closes']).toBe(0)
    expect(again.dialog?.['open']).toBe(true)
  })
})
