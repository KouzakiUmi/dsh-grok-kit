import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  alignExtension,
  buildEditRequestBody,
  decodeFirstImage,
  parseAttachmentSpec,
  resolveImageSources,
  runImageEdit,
  safeDetail,
  sniffEditableImageMediaType,
} from '../src/imagine-edit-core.ts'
import { applyGrokImagineEditTool } from '../src/imagine-edit.ts'
import type { XaiOAuthSession } from '../src/session.ts'
import type { XaiOAuthTokenSource } from '../src/token-source.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00')
const SHA = `sha256:${'a'.repeat(64)}`

describe('sniffEditableImageMediaType', () => {
  it('recognizes png/jpeg/webp and rejects gif (edits endpoint does not accept gif)', () => {
    expect(sniffEditableImageMediaType(PNG)).toBe('image/png')
    expect(sniffEditableImageMediaType(JPEG)).toBe('image/jpeg')
    expect(sniffEditableImageMediaType(GIF)).toBeUndefined()
    expect(sniffEditableImageMediaType(Uint8Array.from([1, 2, 3]))).toBeUndefined()
  })
})

describe('parseAttachmentSpec', () => {
  it('accepts the four handle shapes the model actually sees', () => {
    expect(parseAttachmentSpec(SHA)).toEqual({ attachmentId: SHA })
    expect(parseAttachmentSpec(`attachmentId=${SHA}`)).toEqual({ attachmentId: SHA })
    expect(parseAttachmentSpec(`[Codex Connect image 1 attachment={"attachmentId":"${SHA}","mediaType":"image/png","bytes":8,"width":1,"height":1}]`)).toEqual({
      attachmentId: SHA,
      ref: { attachmentId: SHA, mediaType: 'image/png', bytes: 8, width: 1, height: 1 },
    })
    expect(parseAttachmentSpec(JSON.stringify({ attachmentId: SHA, mediaType: 'image/png', bytes: 8, width: 1, height: 1 }))).toMatchObject({ attachmentId: SHA })
    expect(parseAttachmentSpec('not-a-handle.png')).toBeUndefined()
  })
})

describe('alignExtension', () => {
  it('rewrites a lying extension but keeps equivalent ones', () => {
    expect(alignExtension('out.png', 'image/jpeg')).toMatchObject({ path: 'out.jpg' })
    expect(alignExtension('out.jpeg', 'image/jpeg')).toEqual({ path: 'out.jpeg' })
    expect(alignExtension('out.png', 'image/png')).toEqual({ path: 'out.png' })
  })
})

describe('buildEditRequestBody', () => {
  it('uses image for one source and images for several (mutually exclusive)', () => {
    const one = buildEditRequestBody({ prompt: 'p', images: [{ url: 'u1', origin: 'url' }] })
    expect(one.image).toEqual({ url: 'u1', type: 'image_url' })
    expect(one.images).toBeUndefined()
    const two = buildEditRequestBody({ prompt: 'p', images: [{ url: 'u1', origin: 'url' }, { url: 'u2', origin: 'url' }], aspectRatio: '16:9' })
    expect(two.images).toEqual([{ url: 'u1', type: 'image_url' }, { url: 'u2', type: 'image_url' }])
    expect(two.image).toBeUndefined()
    expect(two.aspect_ratio).toBe('16:9')
  })
})

describe('decodeFirstImage', () => {
  it('returns the first image with its sniffed type and count', () => {
    const result = decodeFirstImage({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }, { b64_json: Buffer.from(PNG).toString('base64') }] })
    expect(result.mediaType).toBe('image/png')
    expect(result.returned).toBe(2)
  })

  it('fails on a missing b64 payload', () => {
    expect(() => decodeFirstImage({ data: [{}] })).toThrow(/no b64_json/)
  })
})

describe('edit input and result contracts', () => {
  const dataUri = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
  const tokens: XaiOAuthTokenSource = { available: () => true, resolve: vi.fn(async () => 'tok') }

  it.each([
    ['oversized', `data:image/png;base64,${Buffer.alloc(64).toString('base64')}`, 8, /limit/],
    ['fake PNG', `data:image/png;base64,${Buffer.from('ordinary text').toString('base64')}`, 100, /not a PNG/],
    ['wrong MIME', `data:image/jpeg;base64,${Buffer.from(PNG).toString('base64')}`, 100, /does not match/],
    ['bad padding', `${dataUri}===`, 100, /valid base64/],
  ])('rejects %s before any OAuth or HTTP request', async (_name, image, maxBytes, error) => {
    const fetchImpl = vi.fn()
    const resolve = vi.fn(async () => 'tok')
    await expect(runImageEdit({ tokens: { ...tokens, resolve }, prompt: 'p', imageSpecs: [image as string],
      maxBytes: maxBytes as number, fetchImpl, save: vi.fn() })).rejects.toThrow(error as RegExp)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('accepts valid data URIs at the exact byte limit and normalizes whitespace', async () => {
    const result = await resolveImageSources([dataUri.replace(',', ',\n')], { maxBytes: PNG.byteLength })
    expect(result).toEqual([{ url: dataUri, origin: 'data-uri', mediaType: 'image/png', bytes: PNG.byteLength }])
  })

  it('keeps stored attachment metadata after JPEG-to-WebP reencoding', async () => {
    const saved = { attachmentId: SHA, mediaType: 'image/webp', bytes: 2, width: 1, height: 1, name: 'saved.webp' }
    const result = await runImageEdit({ tokens, prompt: 'p', imageSpecs: [dataUri],
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(JPEG).toString('base64') }] })),
      save: async () => saved })
    expect(result).toMatchObject(saved)
    expect(result.text).toContain('Image: image/webp, 2 bytes.')
  })

  it('redacts upstream errors before truncation', async () => {
    const detail = JSON.stringify({ access_token: 'access-secret', refresh_token: 'refresh-secret' }) + ' token=query-secret Authorization: Bearer opaque-secret'
    expect(safeDetail(detail)).not.toMatch(/access-secret|refresh-secret|query-secret|opaque-secret/)
    await expect(runImageEdit({ tokens, prompt: 'p', imageSpecs: [dataUri],
      fetchImpl: async () => new Response(detail, { status: 400 }), save: vi.fn() })).rejects.toThrow(/\[redacted\]/)
  })

  it('does not save an image if cancellation arrives while decoding the response', async () => {
    const controller = new AbortController()
    const save = vi.fn()
    const response = new Response()
    vi.spyOn(response, 'json').mockImplementation(async () => {
      controller.abort(new Error('cancelled'))
      return { data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }
    })
    await expect(runImageEdit({ tokens, prompt: 'p', imageSpecs: [dataUri], signal: controller.signal,
      fetchImpl: async () => response, save })).rejects.toThrow('cancelled')
    expect(save).not.toHaveBeenCalled()
  })
})

describe('applyGrokImagineEditTool', () => {
  const tokens: XaiOAuthTokenSource = { available: () => true, resolve: async () => 'tok' }
  const session = { liveModelIds: () => ['grok-imagine-image-2.0'] } as unknown as XaiOAuthSession

  function register(fetchImpl: typeof fetch, saveImage = vi.fn(async () => ({
    attachmentId: 'att_1',
    mediaType: 'image/png',
    bytes: PNG.byteLength,
    width: 1,
    height: 1,
    name: 'grok-imagine-edit.png',
  })), overrides: { tokens?: XaiOAuthTokenSource; resolveAttachments?: () => unknown; maxImageBytes?: number } = {}) {
    let registered: { execute: Function; output: { render: Function }; presentResult: Function } | undefined
    applyGrokImagineEditTool({
      tools: { register: (definition: typeof registered) => { registered = definition } },
    } as never, {
      tokens: overrides.tokens ?? tokens,
      session,
      resolveAttachments: (overrides.resolveAttachments ?? (() => ({ saveImage }))) as never,
      fetch: fetchImpl,
      maxImageBytes: overrides.maxImageBytes,
    })
    return { registered, saveImage }
  }

  it('edits from a data-URI source and renders an ImageBlock via saveImage', async () => {
    const dataUri = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
    const { registered, saveImage } = register(async () => new Response(
      JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const value = await registered!.execute(
      { prompt: 'sketch', image: dataUri },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: '/tmp/ws' } } } },
    )
    expect(saveImage).toHaveBeenCalledOnce()
    const rendered = registered!.output.render({}, value)
    expect(rendered.some((block: { type: string }) => block.type === 'image')).toBe(true)
    // presentResult is schema-gated by defineTool: args must validate (image is required).
    expect(registered!.presentResult({ prompt: 'sketch', image: 'src' }, { isError: false, meta: value })).toMatchObject({ card: 'generic' })
  })

  it('reads local inputs through the agent filesystem with a byte limit', async () => {
    const resolve = vi.fn(async () => ({ targetKey: 'image' }))
    const readBytes = vi.fn(async () => PNG)
    const { registered } = register(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })))
    const signal = new AbortController().signal
    await registered!.execute({ prompt: 'edit', image: 'input.png' }, {
      signal, agent: { ctx: { fs: { resolve, readBytes } }, session: { header: { cwd: '/tmp/ws' } } },
    })
    expect(resolve).toHaveBeenCalledWith(expect.stringContaining('input.png'), { cwd: '/tmp/ws', signal })
    expect(readBytes).toHaveBeenCalledWith({ targetKey: 'image' }, signal, 20 * 1024 * 1024)
  })

  it('rejects more than five sources before any network call', async () => {
    let called = false
    const { registered } = register(async () => { called = true; return new Response('{}', { status: 200 }) })
    await expect(registered!.execute(
      { prompt: 'x', image: 'a.png', images: ['b.png', 'c.png', 'd.png', 'e.png', 'f.png'] },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/too many source images/)
    expect(called).toBe(false)
  })

  it('requires an attachment store even with a workspace, before network calls', async () => {
    const fetchImpl = vi.fn()
    const { registered } = register(fetchImpl, undefined, { resolveAttachments: () => undefined })
    await expect(registered!.execute({ prompt: 'p', image: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}` },
      { agent: { session: { header: { cwd: '/tmp/ws' } } } })).rejects.toThrow(/attachment service/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([0, 1.5, 5])('rejects invalid n=%s before network calls', async n => {
    const fetchImpl = vi.fn()
    const { registered } = register(fetchImpl)
    await expect(registered!.execute({ prompt: 'p', image: 'https://example.com/image.png', n }, {})).rejects.toThrow(/integer/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps a non-OK edit response to an error with the status', async () => {
    const { registered } = register(async () => new Response('{"error":"bad"}', { status: 400 }))
    const dataUri = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
    await expect(registered!.execute(
      { prompt: 'x', image: dataUri },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/HTTP 400/)
  })

  it.each(['out.png', '../outside.png'])('rejects save_path %s before requesting an edit', async save_path => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-edit-'))
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ b64_json: Buffer.from(JPEG).toString('base64') }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const { registered, saveImage } = register(fetchImpl)
    const dataUri = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
    await expect(registered!.execute(
      { prompt: 'x', image: dataUri, save_path },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: dir } } } },
    )).rejects.toThrow(/save_path is unsupported/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('retries once with a refreshed token after a 401', async () => {
    const seen: string[] = []
    const retryTokens: XaiOAuthTokenSource = {
      available: () => true,
      resolve: async () => 'tok1',
      refresh: async rejected => (rejected === 'tok1' ? 'tok2' : undefined),
    }
    const { registered } = register(async (_input: unknown, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).authorization))
      return seen.length === 1
        ? new Response('expired', { status: 401 })
        : new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }), { status: 200 })
    }, undefined, { tokens: retryTokens })
    const dataUri = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`
    await registered!.execute(
      { prompt: 'x', image: dataUri },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: '/tmp/ws' } } } },
    )
    expect(seen).toEqual(['Bearer tok1', 'Bearer tok2'])
  })

  it('reads a full attachment reference through the store and sends it as a data URI', async () => {
    const readImage = vi.fn(async () => ({ data: PNG }))
    const saveImage = vi.fn(async () => ({ attachmentId: 'att_2', mediaType: 'image/png', bytes: 12, width: 1, height: 1, name: 'x.png' }))
    let sent: Record<string, unknown> | undefined
    const { registered } = register(async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }), { status: 200 })
    }, saveImage, { resolveAttachments: () => ({ saveImage, readImage }) })
    const ref = JSON.stringify({ attachmentId: SHA, mediaType: 'image/png', bytes: 12, width: 1, height: 1 })
    await registered!.execute(
      { prompt: 'x', image: ref },
      { signal: new AbortController().signal, agent: { session: { header: { cwd: '/tmp/ws' } } } },
    )
    expect(readImage).toHaveBeenCalledOnce()
    expect(sent?.image).toEqual({ url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`, type: 'image_url' })
  })

  it('verifies a bare attachmentId against the host object sha256 and rejects a mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-edit-'))
    const hostPath = join(dir, 'obj.bin')
    await writeFile(hostPath, PNG)
    const goodId = `sha256:${createHash('sha256').update(PNG).digest('hex')}`
    const saveImage = vi.fn(async () => ({ attachmentId: 'att_3', mediaType: 'image/png', bytes: 12, width: 1, height: 1, name: 'x.png' }))
    const resolveAttachments = () => ({ saveImage, imageHostPath: () => hostPath })
    const { registered } = register(async () => new Response(
      JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] }),
      { status: 200 },
    ), saveImage, { resolveAttachments })
    const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: dir } } } }
    await expect(registered!.execute({ prompt: 'x', image: SHA }, exec)).rejects.toThrow(/integrity verification/)
    await registered!.execute({ prompt: 'x', image: goodId }, exec)
    expect(saveImage).toHaveBeenCalledOnce()
  })
})
