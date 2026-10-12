import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  ALLOWED_VIDEO_DOWNLOAD_HOSTS,
  VideoTaskManager,
  XAI_VIDEO_GENERATIONS_URL,
  isAllowedVideoDownloadUrl,
  type VideoCapabilityEvent,
} from '../src/video-core.ts'
import { MAX_VIDEO_MAX_BYTES } from '../src/video-config.ts'
import type { XaiOAuthTokenSource } from '../src/token-source.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
const PNG_REF = JSON.stringify({
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: PNG.byteLength,
  width: 2,
  height: 2,
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface FetchHandlers {
  submit?: (init?: RequestInit) => Response | Promise<Response>
  poll?: (init?: RequestInit) => Response | Promise<Response>
  download?: (init?: RequestInit) => Response | Promise<Response>
}

/** URL-routed fetch mock: submission / status poll / video download. */
function routeFetch(handlers: FetchHandlers) {
  return vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url === XAI_VIDEO_GENERATIONS_URL) return handlers.submit?.(init) ?? json({ request_id: 'req-1' })
    if (url.startsWith('https://api.x.ai/v1/videos/')) return handlers.poll?.(init) ?? json({ status: 'pending' })
    return handlers.download?.(init) ?? new Response(MP4, { status: 200 })
  })
}

/** saveFileStream mock that CONSUMES the stream like the real store does. */
function saver(options: { fail?: boolean } = {}) {
  const chunkCounts = { chunks: 0 }
  const fn = vi.fn(async (input: { data: AsyncIterable<Uint8Array>; name?: string; signal?: AbortSignal }) => {
    let bytes = 0
    for await (const chunk of input.data) {
      chunkCounts.chunks += 1
      bytes += chunk.byteLength
    }
    if (options.fail) throw new Error('attachment store write failed')
    return { attachmentId: `sha256:${'b'.repeat(64)}`, name: input.name ?? 'grok-video-test.mp4', bytes }
  })
  return Object.assign(fn, chunkCounts)
}

interface Harness {
  manager: VideoTaskManager
  fetchMock: ReturnType<typeof routeFetch>
  saveFileStream: ReturnType<typeof saver>
  refresh: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
  events: VideoCapabilityEvent[]
}

function makeHarness(overrides: {
  fetchMock?: ReturnType<typeof routeFetch>
  saveFileStream?: ReturnType<typeof saver>
  identity?: () => Promise<string | undefined>
  storePath?: string
  maxVideoBytes?: number
  resolveToken?: () => Promise<string | undefined>
  refresh?: (rejected: string) => Promise<string | undefined>
  attachments?: unknown
} = {}): Harness {
  const saveFileStream = overrides.saveFileStream ?? saver()
  const resolve = vi.fn(async () => overrides.resolveToken?.() ?? 'tok')
  const refresh = vi.fn(async (rejected: string) => overrides.refresh?.(rejected))
  const tokens: XaiOAuthTokenSource = {
    available: () => true,
    resolve,
    refresh,
  }
  const events: VideoCapabilityEvent[] = []
  const fetchMock = overrides.fetchMock ?? routeFetch({})
  const manager = new VideoTaskManager({
    tokens,
    resolveAttachments: () => (overrides.attachments ?? { saveFileStream }) as unknown as AttachmentStore,
    identity: overrides.identity ?? (async () => 'acc-a'),
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides.storePath === undefined ? {} : { storePath: overrides.storePath },
    ...overrides.maxVideoBytes === undefined ? {} : { maxVideoBytes: overrides.maxVideoBytes },
    onCapability: event => { events.push(event) },
  })
  return { manager, fetchMock, saveFileStream, refresh, resolve, events }
}

async function newStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grok-video-'))
  return join(dir, 'tasks.json')
}

describe('isAllowedVideoDownloadUrl', () => {
  it('allows only the exact official https host', () => {
    expect(isAllowedVideoDownloadUrl('https://vidgen.x.ai/xai-vidgen-bucket/v.mp4')).toBe(true)
    expect(isAllowedVideoDownloadUrl('https://vidgen.x.ai:443/v.mp4')).toBe(true)
    expect(isAllowedVideoDownloadUrl('http://vidgen.x.ai/v.mp4')).toBe(false)
    expect(isAllowedVideoDownloadUrl('https://evil.example.com/v.mp4')).toBe(false)
    expect(isAllowedVideoDownloadUrl('https://vidgen.x.ai.evil.com/v.mp4')).toBe(false)
    expect(isAllowedVideoDownloadUrl('https://user:pass@vidgen.x.ai/v.mp4')).toBe(false)
    expect(isAllowedVideoDownloadUrl('https://vidgen.x.ai:8443/v.mp4')).toBe(false)
    expect(isAllowedVideoDownloadUrl('https://127.0.0.1/v.mp4')).toBe(false)
    expect(isAllowedVideoDownloadUrl('not a url')).toBe(false)
  })
  it('never includes a non-allowlisted host in the constant set', () => {
    expect([...ALLOWED_VIDEO_DOWNLOAD_HOSTS]).toEqual(['vidgen.x.ai'])
  })
})

describe('generate', () => {
  it('rejects missing file storage before a paid submission or token resolution', async () => {
    const harness = makeHarness({ storePath: await newStorePath(), attachments: {} })
    await expect(harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })).rejects.toThrow(/file attachment storage/)
    expect(harness.fetchMock).not.toHaveBeenCalled()
    expect(harness.resolve).not.toHaveBeenCalled()
    expect(await harness.manager.list()).toEqual([])
  })
  it('redacts transport credentials before returning or persisting an unknown submission', async () => {
    const storePath = await newStorePath()
    const harness = makeHarness({ storePath, fetchMock: routeFetch({ submit: () => {
      throw new Error('transport {"api_key":"private-api-key","key":"private-oauth-key"} https://vidgen.x.ai/v?sig=private-signature')
    } }) })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(result.state).toBe('submission-unknown')
    expect(JSON.stringify(result)).not.toMatch(/private-api-key|private-oauth-key|private-signature/)
    expect(await readFile(storePath, 'utf8')).not.toMatch(/private-api-key|private-oauth-key|private-signature/)
  })

  it('refuses streamless JSON without calling an unbounded text fallback', async () => {
    const text = vi.fn(async () => JSON.stringify({ request_id: 'req-unbounded' }))
    const streamless = { ok: true, status: 200, headers: new Headers(), body: null, text } as unknown as Response
    const harness = makeHarness({ storePath: await newStorePath(), fetchMock: routeFetch({ submit: () => streamless }) })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(result.state).toBe('submission-unknown')
    expect(result.error).toMatch(/not streamable/)
    expect(text).not.toHaveBeenCalled()
    await expect(harness.manager.status(result.taskId)).resolves.toMatchObject({ state: 'submission-unknown' })
    expect(harness.fetchMock).toHaveBeenCalledOnce()
  })

  it('submits once and files a pending task under the current identity', async () => {
    const storePath = await newStorePath()
    let sent: Record<string, unknown> | undefined
    let auth = ''
    const harness = makeHarness({
      storePath,
      fetchMock: routeFetch({
        submit: init => {
          sent = JSON.parse(String(init?.body))
          auth = String((init?.headers as Record<string, string>).authorization)
          return json({ request_id: 'req-1' })
        },
      }),
    })
    const result = await harness.manager.generate({ prompt: 'make it move', image: PNG_DATA_URI, duration: 6, resolution: '480p' })
    expect(result).toMatchObject({ state: 'pending', model: 'grok-imagine-video-1.5', prompt: 'make it move', duration: 6, resolution: '480p' })
    expect(result.taskId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(result.error).toBeUndefined()
    expect(auth).toBe('Bearer tok')
    expect(sent).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'make it move',
      image: { url: PNG_DATA_URI },
      duration: 6,
      resolution: '480p',
    })
    // Internal request id is persisted but never exposed on the result.
    expect(JSON.stringify(result)).not.toContain('req-1')
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { tasks: Array<Record<string, unknown>> }
    expect(stored.tasks).toHaveLength(1)
    expect(stored.tasks[0]).toMatchObject({ taskId: result.taskId, identity: 'acc-a', state: 'pending', requestId: 'req-1' })
    expect(stored.tasks[0]?.error).toBeUndefined()
    const listed = await harness.manager.list()
    expect(listed).toEqual([expect.objectContaining({ taskId: result.taskId, state: 'pending' })])
  })

  it('keeps one task id from the pre-POST placeholder to the final state (billing context)', async () => {
    const storePath = await newStorePath()
    const harness = makeHarness({ storePath })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { tasks: Array<{ taskId: string; state: string }> }
    expect(stored.tasks).toHaveLength(1)
    expect(stored.tasks[0].taskId).toBe(result.taskId)
    expect(stored.tasks[0].state).toBe('pending')
  })

  it.each([
    ['bad duration', { prompt: 'p', image: PNG_DATA_URI, duration: 7 }, /duration must be one of 6, 10/],
    ['bad resolution', { prompt: 'p', image: PNG_DATA_URI, resolution: '1080p' }, /resolution must be one of 480p, 720p/],
    ['empty prompt', { prompt: '  ', image: PNG_DATA_URI }, /prompt must be a non-empty string/],
    ['empty image', { prompt: 'p', image: '' }, /image must be a non-empty source/],
    ['remote image URL', { prompt: 'p', image: 'https://example.com/x.png' }, /not accepted in this version/],
    ['bare path without host fs', { prompt: 'p', image: 'input.png' }, /host filesystem/],
  ])('rejects %s before any token, network or store write', async (_name, input, error) => {
    const storePath = await newStorePath()
    const harness = makeHarness({ storePath })
    await expect(harness.manager.generate(input as { prompt: string; image: string })).rejects.toThrow(error as RegExp)
    expect(harness.fetchMock).not.toHaveBeenCalled()
    expect(harness.resolve).not.toHaveBeenCalled()
    expect((JSON.parse(await readFile(storePath, 'utf8').catch(() => '{"tasks":[]}')) as { tasks: unknown[] }).tasks ?? []).toHaveLength(0)
  })

  it('reads a full attachment reference through the store and sends a data URI', async () => {
    const readImage = vi.fn(async () => ({ data: PNG }))
    const saveFileStream = saver()
    let sent: Record<string, unknown> | undefined
    const harness = makeHarness({
      attachments: { readImage, saveFileStream },
      fetchMock: routeFetch({ submit: init => { sent = JSON.parse(String(init?.body)); return json({ request_id: 'req-1' }) } }),
    })
    await harness.manager.generate({ prompt: 'p', image: PNG_REF })
    expect(readImage).toHaveBeenCalledOnce()
    expect(sent?.image).toEqual({ url: PNG_DATA_URI })
  })

  it('refreshes exactly once after a 401 and retries the POST once (401 is an explicit rejection)', async () => {
    const seen: string[] = []
    const harness = makeHarness({
      refresh: async rejected => (rejected === 'tok1' ? 'tok2' : undefined),
      resolveToken: async () => 'tok1',
      fetchMock: routeFetch({
        submit: init => {
          seen.push(String((init?.headers as Record<string, string>).authorization))
          return seen.length === 1 ? new Response('expired', { status: 401 }) : json({ request_id: 'req-1' })
        },
      }),
    })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(result.state).toBe('pending')
    expect(seen).toEqual(['Bearer tok1', 'Bearer tok2'])
    expect(harness.refresh).toHaveBeenCalledWith('tok1', undefined)
  })

  it('maps a definite rejection to failed with a stable status-only message and no body echo', async () => {
    const storePath = await newStorePath()
    const harness = makeHarness({
      storePath,
      fetchMock: routeFetch({ submit: () => new Response('{"error":"secret-body-detail"}', { status: 403 }) }),
    })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(result).toMatchObject({ state: 'failed', error: 'xAI video submission failed (HTTP 403)' })
    expect(result.error).not.toContain('secret-body-detail')
    expect(harness.refresh).not.toHaveBeenCalled()
    expect(harness.events).toContainEqual(expect.objectContaining({ state: 'restricted', httpStatus: 403 }))
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { tasks: Array<Record<string, unknown>> }
    expect(stored.tasks[0]).toMatchObject({ taskId: result.taskId, state: 'failed' })
  })

  it('never treats 429 as a token fault', async () => {
    const harness = makeHarness({ fetchMock: routeFetch({ submit: () => new Response('rate limited', { status: 429 }) }) })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(result).toMatchObject({ state: 'failed', error: 'xAI video submission failed (HTTP 429)' })
    expect(harness.refresh).not.toHaveBeenCalled()
    expect(harness.events).toContainEqual(expect.objectContaining({ state: 'temporary-error', httpStatus: 429 }))
  })

  it('records submission-unknown on a network failure and never re-POSTs', async () => {
    const submit = vi.fn(async () => { throw new Error('socket hang up') })
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return submit()
      return json({ status: 'pending' })
    })
    const harness = makeHarness({ fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch> })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(result.state).toBe('submission-unknown')
    expect(result.error).toMatch(/never re-POSTed automatically/)
    expect(submit).toHaveBeenCalledTimes(1)
    // status must not POST again and cannot poll without a request id.
    const again = await harness.manager.status(result.taskId)
    expect(again.state).toBe('submission-unknown')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps submission-unknown when the response carries no usable request id', async () => {
    const harness = makeHarness({ fetchMock: routeFetch({ submit: () => json({}) }) })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(result.state).toBe('submission-unknown')
    expect(result.error).toMatch(/no usable request id/)
  })

  it('persists submission-unknown and rethrows when the caller aborts mid-submission', async () => {
    const storePath = await newStorePath()
    const controller = new AbortController()
    const harness = makeHarness({
      storePath,
      fetchMock: routeFetch({
        submit: init => new Promise<Response>((_resolvePromise, rejectPromise) => {
          init?.signal?.addEventListener('abort', () => rejectPromise((init.signal as AbortSignal).reason))
        }),
      }),
    })
    const pending = harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI }, controller.signal)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    controller.abort(new Error('cancelled by user'))
    await expect(pending).rejects.toThrow('cancelled by user')
    const listed = await harness.manager.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ state: 'submission-unknown' })
    expect(listed[0].error).toMatch(/never re-POSTed automatically/)
  })
})

describe('status / resume', () => {
  async function pendingTask(overrides: Parameters<typeof makeHarness>[0] = {}): Promise<{ harness: Harness; storePath: string; taskId: string }> {
    const storePath = await newStorePath()
    const harness = makeHarness({ storePath, ...overrides })
    const result = await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(result.state).toBe('pending')
    return { harness, storePath, taskId: result.taskId }
  }

  it('recovers after restart: a fresh manager polls once, downloads once, stores the MP4', async () => {
    const { storePath, taskId } = await pendingTask()
    const inits: RequestInit[] = []
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      urls.push(String(input))
      inits.push(init ?? {})
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://api.x.ai/v1/videos/')) {
        return json({ status: 'done', video: { url: 'https://vidgen.x.ai/xai-vidgen-bucket/test.mp4' } })
      }
      return new Response(MP4, { status: 200 })
    })
    const restarted = makeHarness({ storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch> })
    const result = await restarted.manager.status(taskId)
    expect(result).toMatchObject({ state: 'done', taskId })
    expect(result.attachment).toMatchObject({ attachmentId: `sha256:${'b'.repeat(64)}`, bytes: MP4.byteLength })
    expect(result.attachment?.name).toMatch(/^grok-video-[0-9a-f-]*\.mp4$/u)
    expect(urls).toEqual([
      `https://api.x.ai/v1/videos/req-1`,
      'https://vidgen.x.ai/xai-vidgen-bucket/test.mp4',
    ])
    // The poll carries the bearer; the signed download must not.
    expect((inits[0].headers as Record<string, string>).authorization).toBe('Bearer tok')
    const downloadHeaders = inits[1].headers as Record<string, string>
    expect(downloadHeaders.authorization).toBeUndefined()
    expect(inits[1].redirect).toBe('error')
  })

  it('merges concurrent status calls into one poll and one download, then done never downloads again', async () => {
    let polls = 0
    let downloads = 0
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://api.x.ai/v1/videos/')) {
        polls += 1
        return json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
      }
      downloads += 1
      return new Response(MP4, { status: 200 })
    })
    const one = await pendingTask()
    const harness = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch> })
    const [first, second] = await Promise.all([harness.manager.status(one.taskId), harness.manager.status(one.taskId)])
    expect(first.taskId).toBe(one.taskId)
    expect(second.taskId).toBe(one.taskId)
    expect(first.state).toBe('done')
    expect(second.state).toBe('done')
    expect(polls).toBe(1)
    expect(downloads).toBe(1)
    const again = await harness.manager.status(one.taskId)
    expect(again.state).toBe('done')
    expect(polls).toBe(1)
    expect(downloads).toBe(1)
  })

  it('maps failed/expired to failed and terminal states never poll again', async () => {
    let polls = 0
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      polls += 1
      return json({ status: 'expired' })
    })
    const one = await pendingTask()
    const harness = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch> })
    const result = await harness.manager.status(one.taskId)
    expect(result).toMatchObject({ state: 'failed', error: 'video generation expired' })
    const again = await harness.manager.resume(one.taskId)
    expect(again.state).toBe('failed')
    expect(polls).toBe(1)
  })

  it('retries the poll once with a refreshed token after a 401', async () => {
    const seen: string[] = []
    let phase = 0
    const one = await pendingTask()
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://api.x.ai/v1/videos/')) {
        seen.push(String((init?.headers as Record<string, string>).authorization))
        phase += 1
        return phase === 1
          ? new Response('expired', { status: 401 })
          : json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
      }
      return new Response(MP4, { status: 200 })
    })
    const harness = makeHarness({
      storePath: one.storePath,
      fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch>,
      resolveToken: async () => 'tok1',
      refresh: async rejected => (rejected === 'tok1' ? 'tok2' : undefined),
    })
    const result = await harness.manager.status(one.taskId)
    expect(result.state).toBe('done')
    expect(seen).toEqual(['Bearer tok1', 'Bearer tok2'])
  })

  it('marks interrupted on a poll 429 without touching the token source, and resume retries', async () => {
    let polls = 0
    const one = await pendingTask()
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://vidgen.x.ai/')) return new Response(MP4, { status: 200 })
      polls += 1
      return polls === 1
        ? new Response('rate limited', { status: 429 })
        : json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
    })
    const harness = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch> })
    const result = await harness.manager.status(one.taskId)
    expect(result).toMatchObject({ state: 'interrupted' })
    expect(result.error).toBe('status check failed (HTTP 429); call resume to retry')
    expect(harness.refresh).not.toHaveBeenCalled()
    expect(harness.events).toContainEqual(expect.objectContaining({ state: 'temporary-error', httpStatus: 429 }))
    const resumed = await harness.manager.resume(one.taskId)
    expect(resumed.state).toBe('done')
  })

  it('rejects unknown task ids locally', async () => {
    const harness = makeHarness({ storePath: await newStorePath() })
    await expect(harness.manager.status('missing-task')).rejects.toThrow(/unknown video task/)
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses non-allowlisted download hosts without leaking the signed URL', async () => {
    const one = await pendingTask()
    const download = vi.fn()
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      return json({ status: 'done', video: { url: 'https://evil.example.com/signed.mp4?X-Amz-Signature=zzz' } })
    })
    const harness = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch> })
    const result = await harness.manager.status(one.taskId)
    expect(result.state).toBe('interrupted')
    expect(result.error).toMatch(/allowed official host/)
    expect(JSON.stringify(result)).not.toMatch(/evil\.example\.com|X-Amz|signed\.mp4/)
    expect(download).not.toHaveBeenCalled()
  })

  it('enforces the streamed download byte cap', async () => {
    const one = await pendingTask()
    const big = new Uint8Array(MP4.byteLength + 4096)
    big.set(MP4, 0)
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://api.x.ai/v1/videos/')) return json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
      return new Response(big, { status: 200 })
    })
    const harness = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch>, maxVideoBytes: 1024 })
    const result = await harness.manager.status(one.taskId)
    expect(result.state).toBe('interrupted')
    expect(result.error).toMatch(/byte download limit/)
    expect(result.attachment).toBeUndefined()
  })

  it('rejects non-MP4 payloads before the store sees a byte', async () => {
    const one = await pendingTask()
    const saveFileStream = saver()
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://api.x.ai/v1/videos/')) return json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
      return new Response(new TextEncoder().encode('hello world, definitely not an mp4!'), { status: 200 })
    })
    const harness = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch>, saveFileStream })
    const result = await harness.manager.status(one.taskId)
    expect(result.state).toBe('interrupted')
    expect(result.error).toMatch(/not an MP4/)
    expect(saveFileStream.chunks).toBe(0)
    expect(result.attachment).toBeUndefined()
  })

  it('keeps an attachment write failure recoverable through resume', async () => {
    const one = await pendingTask()
    const failing = saver({ fail: true })
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://vidgen.x.ai/')) return new Response(MP4, { status: 200 })
      return json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
    })
    const harness = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch>, saveFileStream: failing })
    const result = await harness.manager.status(one.taskId)
    expect(result).toMatchObject({ state: 'interrupted' })
    expect(result.error).toMatch(/attachment store write failed/)
    const okSaver = saver()
    const recovered = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch>, saveFileStream: okSaver })
    const resumed = await recovered.manager.resume(one.taskId)
    expect(resumed.state).toBe('done')
    expect(resumed.attachment).toMatchObject({ bytes: MP4.byteLength })
  })

  it('keeps tokens and signed URLs out of the store, results and errors', async () => {
    const one = await pendingTask()
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://vidgen.x.ai/')) return new Response(MP4, { status: 200 })
      return json({ status: 'done', video: { url: 'https://vidgen.x.ai/bucket/signed.mp4?X-Amz-Signature=super-secret' } })
    })
    const harness = makeHarness({ storePath: one.storePath, fetchMock: fetchMock as unknown as ReturnType<typeof routeFetch> })
    const result = await harness.manager.status(one.taskId)
    expect(result.state).toBe('done')
    const stored = await readFile(one.storePath, 'utf8')
    expect(stored).not.toMatch(/tok|Bearer|vidgen|X-Amz|super-secret|signed\.mp4/u)
    expect(JSON.stringify(result)).not.toMatch(/tok|Bearer|vidgen|X-Amz|super-secret/u)
    // Error text redacts URL-shaped strings and token-like strings alike.
    const network = makeHarness({
      storePath: await newStorePath(),
      fetchMock: vi.fn(async () => { throw new Error('probe https://vidgen.x.ai/signed.mp4?X-Amz-Signature=abc Bearer sekret-token') }) as unknown as ReturnType<typeof routeFetch>,
    })
    const unknown = await network.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    expect(unknown.state).toBe('submission-unknown')
    expect(unknown.error).toContain('[link redacted]')
    expect(unknown.error).not.toMatch(/sekret-token|X-Amz|abc/u)
    expect(unknown.error).toContain('[redacted]')
  })
})

describe('identity partitioning', () => {
  it('fails closed when no stable identity is available', async () => {
    const storePath = await newStorePath()
    const harness = makeHarness({ storePath })
    const noIdentity = new VideoTaskManager({
      tokens: { available: () => true, resolve: async () => 'tok' },
      resolveAttachments: () => ({ saveFileStream: saver() }) as unknown as AttachmentStore,
      fetch: harness.fetchMock as unknown as typeof fetch,
      storePath,
    })
    await expect(noIdentity.generate({ prompt: 'p', image: PNG_DATA_URI })).rejects.toThrow(/stable OAuth identity/)
    await expect(noIdentity.status('any')).rejects.toThrow(/stable OAuth identity/)
    await expect(noIdentity.list()).resolves.toEqual([])
    expect(harness.fetchMock).not.toHaveBeenCalled()
  })

  it('never shows or resumes another account\'s tasks', async () => {
    const storePath = await newStorePath()
    const mine = makeHarness({ storePath, identity: async () => 'acc-a' })
    const result = await mine.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    const theirs = makeHarness({ storePath, identity: async () => 'acc-b' })
    await expect(theirs.manager.list()).resolves.toEqual([])
    await expect(theirs.manager.status(result.taskId)).rejects.toThrow(/unknown video task/)
    expect(theirs.fetchMock).not.toHaveBeenCalled()
  })

  it('aborts when the identity switches mid-operation and files nothing under the new identity', async () => {
    const storePath = await newStorePath()
    let calls = 0
    const harness = makeHarness({
      storePath,
      identity: async () => {
        calls += 1
        return calls <= 3 ? 'acc-a' : 'acc-b'
      },
    })
    await expect(harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })).rejects.toThrow(/identity changed during the operation/)
    const underB = makeHarness({ storePath, identity: async () => 'acc-b' })
    await expect(underB.manager.list()).resolves.toEqual([])
    const underA = makeHarness({ storePath, identity: async () => 'acc-a' })
    const listed = await underA.manager.list()
    // The pre-POST billing placeholder stays under the original identity only.
    expect(listed).toHaveLength(1)
    expect(listed[0].state).toBe('submission-unknown')
  })

  it('does not hand a joined poll result to an account that switched away', async () => {
    const storePath = await newStorePath()
    const submit = makeHarness({ storePath, identity: async () => 'acc-a' })
    const result = await submit.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    let current = 'acc-a'
    const harness = makeHarness({
      storePath,
      identity: async () => current,
      fetchMock: routeFetch({
        poll: () => {
          // The signed-in account flips while the poll is on the wire.
          current = 'acc-b'
          return json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } })
        },
      }),
    })
    await expect(harness.manager.status(result.taskId)).rejects.toThrow(/identity changed during the operation/)
  })
})

describe('dispose and restart', () => {
  it('dispose cancels only local work, keeps the record, and restart resumes it', async () => {
    const storePath = await newStorePath()
    const submitHarness = makeHarness({ storePath })
    const { taskId } = await submitHarness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    await submitHarness.manager.dispose()

    const hanging = makeHarness({
      storePath,
      fetchMock: routeFetch({
        poll: () => json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } }),
        download: init => new Promise<Response>((_resolvePromise, rejectPromise) => {
          init?.signal?.addEventListener('abort', () => rejectPromise((init.signal as AbortSignal).reason))
        }),
      }),
    })
    const inFlight = hanging.manager.status(taskId)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
    await hanging.manager.dispose()
    await expect(inFlight).rejects.toThrow(/disposed/)
    await expect(hanging.manager.list()).rejects.toThrow(/disposed/)

    const restarted = makeHarness({
      storePath,
      fetchMock: routeFetch({ poll: () => json({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } }) }),
    })
    const result = await restarted.manager.status(taskId)
    expect(result.state).toBe('done')
  })
})

describe('store bounds', () => {
  it('shards the default store under DSH_HOME/dsh-grok-kit per identity', async () => {
    const harness = makeHarness({ identity: async () => 'acc-shard' })
    await harness.manager.generate({ prompt: 'p', image: PNG_DATA_URI })
    const dir = join(process.env.DSH_HOME ?? '', 'dsh-grok-kit')
    const files = await readdir(dir)
    expect(files).toContainEqual(expect.stringMatching(/^video-tasks-[0-9a-f]{16}\.json$/u))
  })

  it('retains only the newest 50 tasks', async () => {
    const storePath = await newStorePath()
    const harness = makeHarness({
      storePath,
      fetchMock: routeFetch({ submit: init => {
        const body = JSON.parse(String(init?.body)) as { prompt: string }
        return json({ request_id: `req-${body.prompt}` })
      } }),
    })
    for (let index = 0; index < 55; index += 1) {
      await harness.manager.generate({ prompt: `p${String(index)}`, image: PNG_DATA_URI })
    }
    const listed = await harness.manager.list()
    expect(listed).toHaveLength(50)
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { tasks: Array<{ prompt: string }> }
    expect(stored.tasks).toHaveLength(50)
    expect(stored.tasks.some(task => task.prompt === 'p54')).toBe(true)
    expect(stored.tasks.some(task => task.prompt === 'p0')).toBe(false)
  })

  it('does not evict another account when an explicit storePath is shared', async () => {
    const storePath = await newStorePath()
    let identity = 'acc-b'
    const harness = makeHarness({ storePath, identity: async () => identity })
    const protectedTask = await harness.manager.generate({ prompt: 'keep-b', image: PNG_DATA_URI })
    identity = 'acc-a'
    for (let index = 0; index < 55; index += 1) {
      await harness.manager.generate({ prompt: `a${String(index)}`, image: PNG_DATA_URI })
    }
    expect(await harness.manager.list()).toHaveLength(50)
    identity = 'acc-b'
    expect(await harness.manager.list()).toEqual([protectedTask])
    const stored = JSON.parse(await readFile(storePath, 'utf8')) as { tasks: unknown[] }
    expect(stored.tasks).toHaveLength(51)
  })

  it('rejects oversized store files instead of reading them unbounded', async () => {
    const storePath = await newStorePath()
    await writeFile(storePath, `{"version":1,"tasks":[${'"x",'.repeat(700_000)}"x"]}`)
    const harness = makeHarness({ storePath })
    await expect(harness.manager.list()).rejects.toThrow(/read limit/)
  })
})

describe('maxVideoBytes bounds', () => {
  it('accepts the configured range and rejects values above the shared cap', async () => {
    expect(() => makeHarness({ maxVideoBytes: 1 })).not.toThrow()
    expect(() => makeHarness({ maxVideoBytes: MAX_VIDEO_MAX_BYTES })).not.toThrow()
    expect(() => makeHarness({ maxVideoBytes: MAX_VIDEO_MAX_BYTES + 1 })).toThrow(/maxVideoBytes/)
    expect(() => makeHarness({ maxVideoBytes: 0 })).toThrow(/maxVideoBytes/)
  })
})
