import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { applyGrokVideoTools } from '../src/video-tools.ts'
import { VideoTaskManager, XAI_VIDEO_GENERATIONS_URL } from '../src/video-core.ts'
import { DEFAULT_MAX_IMAGE_BYTES } from '../src/imagine-edit-core.ts'
import type { XaiOAuthTokenSource } from '../src/token-source.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])
const PNG_DATA_URI = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`

interface RenderedBlock {
  type: string
  text?: string
  attachment?: { attachmentId: string; name: string; bytes: number }
}

interface RegisteredTool {
  name: string
  description: string
  execute: (args: Record<string, unknown> | undefined, exec: Record<string, unknown>) => Promise<Record<string, unknown>>
  output: {
    render: (args: unknown, value: unknown) => RenderedBlock[]
    presentationMeta: (args: unknown, value: unknown) => unknown
  }
  presentResult: (args: unknown, result: Record<string, unknown>) => unknown
}

interface ToolValue extends Record<string, unknown> {
  text: string
  taskId: string
  state: string
  attachment?: { attachmentId: string; name: string; bytes: number }
  error?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function saver() {
  return vi.fn(async (input: { data: AsyncIterable<Uint8Array>; name?: string }) => {
    let bytes = 0
    for await (const chunk of input.data) bytes += chunk.byteLength
    return { attachmentId: `sha256:${'b'.repeat(64)}`, name: input.name ?? 'v.mp4', bytes }
  })
}

interface ToolHarness {
  tools: Map<string, RegisteredTool>
  fetchMock: ReturnType<typeof vi.fn>
  saveFileStream: ReturnType<typeof saver>
}

async function makeToolHarness(overrides: {
  fetchMock?: typeof fetch
  saveFileStream?: ReturnType<typeof saver>
  identity?: () => Promise<string | undefined>
} = {}): Promise<ToolHarness> {
  const tools = new Map<string, RegisteredTool>()
  const saveFileStream = overrides.saveFileStream ?? saver()
  const tokens: XaiOAuthTokenSource = { available: () => true, resolve: async () => 'tok' }
  const fetchMock = (overrides.fetchMock ?? vi.fn(async () => json({ request_id: 'req-1' }))) as typeof fetch & ReturnType<typeof vi.fn>
  const manager = new VideoTaskManager({
    tokens,
    resolveAttachments: () => ({ saveFileStream }) as unknown as AttachmentStore,
    identity: overrides.identity ?? (async () => 'acc-a'),
    fetch: fetchMock,
    storePath: join(await mkdtemp(join(tmpdir(), 'grok-video-tools-')), 'tasks.json'),
  })
  applyGrokVideoTools({
    tools: { register: (definition: unknown) => { const tool = definition as RegisteredTool; tools.set(tool.name, tool) } },
    logger: { info: () => undefined },
  } as never, { manager })
  return { tools, fetchMock, saveFileStream }
}

function execFixture(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: '/tmp/ws' } } },
    ...extra,
  }
}

describe('applyGrokVideoTools', () => {
  it('registers the three tools and states the billing/no-cancel contract', async () => {
    const { tools } = await makeToolHarness()
    expect([...tools.keys()].sort()).toEqual(['grok_video_generate', 'grok_video_resume', 'grok_video_status'])
    const generate = tools.get('grok_video_generate')!
    expect(generate.description).toMatch(/does NOT cancel/i)
    expect(generate.description).toMatch(/billing/i)
    expect(tools.get('grok_video_status')!.description).toMatch(/does NOT cancel/i)
    expect(tools.get('grok_video_resume')!.description).toMatch(/does NOT cancel/i)
  })

  it('submits through the manager and renders the pending task text', async () => {
    const { tools, fetchMock } = await makeToolHarness()
    const generate = tools.get('grok_video_generate')!
    const value = (await generate.execute({ prompt: 'make it move', image: PNG_DATA_URI, duration: 6, resolution: '720p' }, execFixture())) as ToolValue
    expect(value).toMatchObject({ state: 'pending', model: 'grok-imagine-video-1.5', duration: 6, resolution: '720p' })
    expect(value.taskId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(value.text).toContain(`Video task ${value.taskId} is pending`)
    expect(value.text).toMatch(/Stopping the wait is not cancelling/i)
    const blocks = generate.output.render({}, value)
    expect(blocks).toEqual([{ type: 'text', text: value.text }])
    // presentationMeta is exactly the VideoTaskResult: no text, no remote URL.
    const meta = generate.output.presentationMeta({}, value) as Record<string, unknown>
    expect(meta.taskId).toBe(value.taskId)
    expect(meta.text).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['empty image', { prompt: 'p', image: '' }, /image must be a non-empty source/],
    ['empty prompt', { prompt: '', image: PNG_DATA_URI }, /prompt must be a non-empty string/],
    ['bad duration', { prompt: 'p', image: PNG_DATA_URI, duration: 7 }, /duration must be one of 6, 10/],
    ['bad resolution', { prompt: 'p', image: PNG_DATA_URI, resolution: '1080p' }, /resolution must be one of 480p, 720p/],
  ])('rejects %s with a reasonable error before any network call', async (_name, args, error) => {
    const { tools, fetchMock } = await makeToolHarness()
    const generate = tools.get('grok_video_generate')!
    await expect(generate.execute(args, execFixture())).rejects.toThrow(error as RegExp)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lets defineTool schema validation reject a missing required argument', async () => {
    const { tools, fetchMock } = await makeToolHarness()
    const generate = tools.get('grok_video_generate')!
    await expect(generate.execute({ prompt: 'p' }, execFixture())).rejects.toThrow(/missing required property "image"/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes local source-image paths through the sandboxed host filesystem', async () => {
    const resolve = vi.fn(async () => ({ targetKey: 'image' }))
    const readBytes = vi.fn(async () => PNG)
    const { tools, fetchMock } = await makeToolHarness()
    let sent: Record<string, unknown> | undefined
    ;(fetchMock as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return json({ request_id: 'req-1' })
    })
    const generate = tools.get('grok_video_generate')!
    const signal = new AbortController().signal
    await generate.execute({ prompt: 'p', image: 'input.png' }, {
      signal,
      agent: { ctx: { fs: { resolve, readBytes } }, session: { header: { cwd: '/tmp/ws' } } },
    })
    expect(resolve).toHaveBeenCalledWith(expect.stringContaining('input.png'), { cwd: '/tmp/ws', signal })
    expect(readBytes).toHaveBeenCalledWith({ targetKey: 'image' }, signal, DEFAULT_MAX_IMAGE_BYTES)
    expect(sent?.image).toEqual({ url: PNG_DATA_URI })
  })

  it('keeps the tool abort signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by the operator'))
    const { tools, fetchMock } = await makeToolHarness()
    const generate = tools.get('grok_video_generate')!
    await expect(generate.execute({ prompt: 'p', image: PNG_DATA_URI }, { signal: controller.signal })).rejects.toThrow('cancelled by the operator')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires task_id for status and resume', async () => {
    const { tools } = await makeToolHarness()
    for (const name of ['grok_video_status', 'grok_video_resume']) {
      const tool = tools.get(name)!
      await expect(tool.execute({}, execFixture())).rejects.toThrow(/missing required property "task_id"/)
      await expect(tool.execute({ task_id: ' ' }, execFixture())).rejects.toThrow(/task_id must be a non-empty task id/)
    }
  })

  it('renders a done task with the full file reference and a real FileBlock', async () => {
    let phase = 0
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) return json({ request_id: 'req-1' })
      if (url.startsWith('https://api.x.ai/v1/videos/')) {
        return json({ status: 'done', video: { url: 'https://vidgen.x.ai/bucket/v.mp4' } })
      }
      return new Response(MP4, { status: 200 })
    }) as unknown as typeof fetch
    const { tools } = await makeToolHarness({ fetchMock })
    const generate = tools.get('grok_video_generate')!
    const submitted = (await generate.execute({ prompt: 'p', image: PNG_DATA_URI }, execFixture())) as ToolValue
    const status = tools.get('grok_video_status')!
    const value = (await status.execute({ task_id: submitted.taskId }, execFixture())) as ToolValue
    expect(value.state).toBe('done')
    expect(value.attachment).toMatchObject({ attachmentId: `sha256:${'b'.repeat(64)}`, bytes: MP4.byteLength })
    const blocks = status.output.render({}, value)
    expect(blocks[0]).toEqual({ type: 'text', text: value.text })
    expect(blocks[1]).toMatchObject({ type: 'file', attachment: { attachmentId: value.attachment!.attachmentId } })
    // The text still carries the full file attachment reference.
    expect(value.text).toContain(`attachmentId=${value.attachment!.attachmentId}`)
    expect(value.text).toContain(`attachment=${JSON.stringify(value.attachment)}`)
    expect(value.text).toMatch(/not exposed/)
    const meta = status.output.presentationMeta({}, value) as Record<string, unknown>
    expect(meta.attachment).toMatchObject({ attachmentId: value.attachment!.attachmentId })
    // presentResult hands the UI the same real file block.
    const view = status.presentResult({ task_id: submitted.taskId }, { isError: false, meta: value }) as Record<string, unknown>
    expect(view).toMatchObject({ card: 'generic' })
    expect(JSON.stringify(view)).toContain('"type":"file"')
    phase += 1
    expect(phase).toBe(1)
  })

  it('tells the model that submission-unknown cannot be recovered or polled', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url === XAI_VIDEO_GENERATIONS_URL) throw new Error('socket hang up')
      return json({ status: 'pending' })
    }) as unknown as typeof fetch
    const { tools } = await makeToolHarness({ fetchMock })
    const generate = tools.get('grok_video_generate')!
    const value = (await generate.execute({ prompt: 'p', image: PNG_DATA_URI }, execFixture())) as ToolValue
    expect(value.state).toBe('submission-unknown')
    expect(value.text).toMatch(/cannot recover or poll this task/)
    expect(value.text).toMatch(/Do NOT submit the same request again/)
    expect(value.text).not.toMatch(/call grok_video_status later \(one poll per call\)/u)
    const blocks = generate.output.render({}, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
  })
})
