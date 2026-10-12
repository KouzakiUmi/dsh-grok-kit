import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGrokVideoFileRoute, GROK_VIDEO_FILE_PATH } from '../src/video-file-route.ts'

const ID = 'a067d873-d64a-4e67-a9d5-d80c3e7a56b3'
const servers: Server[] = []
const disposers: Array<() => void> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

async function fixture(options: { enabled?: boolean; bytes?: number; maxBytes?: number; state?: string } = {}) {
  let identity: string | undefined = 'account-a'
  const data = new Uint8Array(options.bytes ?? 16)
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'unsafe-name.mp4', bytes: data.byteLength } as FileAttachmentRef
  const readFileStream = vi.fn((_ref: FileAttachmentRef, _signal?: AbortSignal): AsyncIterable<Uint8Array> => (async function* () { yield data })())
  const tasks = vi.fn(async () => [{ taskId: ID, state: options.state ?? 'done', attachment: ref }])
  let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const unregister = vi.fn()
  let dispose!: () => void
  const ctx = {
    webServer: { register: (spec: { handler: typeof handler }) => { handler = spec.handler; return unregister } },
    effect: (setup: () => () => void) => { dispose = setup(); disposers.push(dispose) },
  } as unknown as Context
  registerGrokVideoFileRoute(ctx, {
    enabled: options.enabled ?? true,
    identity: async () => identity,
    tasks,
    maxBytes: options.maxBytes,
    resolveAttachments: () => ({ readFileStream }) as unknown as AttachmentStore,
  })
  const server = createServer((req, res) => { void handler(req, res).catch(() => { res.statusCode = 500; res.end() }) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = (query = `?taskId=${ID}`, init?: RequestInit) => fetch(`${base}${GROK_VIDEO_FILE_PATH}${query}`, init)
  const rawStatus = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}${GROK_VIDEO_FILE_PATH}?taskId=${ID}`, { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
    req.on('error', reject)
    req.end()
  })
  return { request, rawStatus, readFileStream, tasks, dispose, unregister, ref, data, setIdentity: (next: string | undefined) => { identity = next } }
}

describe('task-scoped video download route', () => {
  it('streams only the owned saved attachment with attachment-only headers and backpressure', async () => {
    const f = await fixture({ bytes: 256 * 1024 })
    const response = await f.request()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="grok-video-${ID}.mp4"`)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.data)
    expect(f.readFileStream).toHaveBeenCalledOnce()
    expect(f.readFileStream.mock.calls[0]![0]).toEqual(f.ref)
  })

  it('rejects arbitrary paths, ids, duplicate ids and foreign hosts before attachment reads', async () => {
    const f = await fixture()
    for (const query of ['?path=C:/private', '?attachmentId=sha256:abc', `?taskId=${ID}&taskId=${ID}`, `?taskId=${ID}&path=x`, '?taskId=../secret']) {
      expect((await f.request(query)).status).toBe(400)
    }
    // Native HTTP preserves Host; fetch may normalize this forbidden wire header.
    expect(await f.rawStatus({ host: 'evil.example' })).toBe(403)
    expect(await f.rawStatus({ 'sec-fetch-site': 'cross-site' })).toBe(403)
    expect(f.readFileStream).not.toHaveBeenCalled()
  })

  it('blocks disabled, unidentified, unknown and unfinished tasks', async () => {
    expect((await (await fixture({ enabled: false })).request()).status).toBe(409)
    const f = await fixture()
    f.setIdentity(undefined)
    expect((await f.request()).status).toBe(403)
    expect(f.tasks).not.toHaveBeenCalled()
    f.setIdentity('account-a')
    expect((await f.request('?taskId=b067d873-d64a-4e67-a9d5-d80c3e7a56b3')).status).toBe(404)
    expect((await (await fixture({ state: 'pending' })).request()).status).toBe(409)
    expect(f.readFileStream).not.toHaveBeenCalled()
  })

  it('checks stored byte limits before streaming and masks storage diagnostics', async () => {
    const oversized = await fixture({ bytes: 16, maxBytes: 15 })
    expect((await oversized.request()).status).toBe(413)
    expect(oversized.readFileStream).not.toHaveBeenCalled()
    const broken = await fixture()
    broken.readFileStream.mockImplementation(() => (async function* () { throw new Error('C:/private Bearer secret https://vidgen.x.ai/v?sig=secret') })())
    const response = await broken.request()
    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).not.toMatch(/private|Bearer|vidgen|sig=|secret/)
  })

  it('does not complete a download when final storage integrity verification fails', async () => {
    const f = await fixture()
    f.readFileStream.mockImplementation(() => (async function* () {
      yield f.data
      throw new Error('attachment digest mismatch')
    })())
    // No Content-Length shortcut: completion requires the final verified stream terminator.
    await expect(f.request().then(response => response.arrayBuffer())).rejects.toThrow()
  })

  it('does not stream after an identity change between task lookup and file read', async () => {
    const f = await fixture()
    f.tasks.mockImplementation(async () => {
      f.setIdentity('account-b')
      return [{ taskId: ID, state: 'done', attachment: f.ref }]
    })
    expect((await f.request()).status).toBe(403)
    expect(f.readFileStream).not.toHaveBeenCalled()
  })

  it('aborts all active file reads and unregisters on dispose', async () => {
    const f = await fixture()
    const signals: AbortSignal[] = []
    f.readFileStream.mockImplementation((_ref, signal) => (async function* () {
      signals.push(signal!)
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
      yield new Uint8Array()
    })())
    const first = f.request()
    const second = f.request()
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    f.dispose()
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(f.unregister).toHaveBeenCalled()
    expect((await first).status).toBe(500)
    expect((await second).status).toBe(500)
  })
})
