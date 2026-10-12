/** Task-scoped file downloads: never accept arbitrary paths or attachment ids. */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ServerResponse } from 'node:http'
import { isTrustedRequest } from './auth-routes.ts'
import { DEFAULT_VIDEO_MAX_BYTES } from './video-config.ts'

export const GROK_VIDEO_FILE_PATH = '/plugins/dsh-grok-kit/video/file'
interface DownloadTask {
  taskId: string
  state: string
  attachment?: FileAttachmentRef
}
export interface VideoFileRouteOptions {
  enabled: boolean
  identity: () => Promise<string | undefined>
  tasks: () => Promise<readonly DownloadTask[]>
  resolveAttachments: () => AttachmentStore | undefined
  maxBytes?: number
}

function fail(res: ServerResponse, status: number, error: string): void {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify({ error }))
}

async function drain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const clean = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = () => { clean(); resolve() }
    const onClose = () => { clean(); reject(new Error('download closed')) }
    const onAbort = () => { clean(); reject(signal.reason) }
    res.once('drain', onDrain)
    res.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    if (res.destroyed) onClose()
    else if (signal.aborted) onAbort()
  })
}

export function registerGrokVideoFileRoute(ctx: Context, options: VideoFileRouteOptions): void {
  const active = new Set<AbortController>()
  let disposed = false
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'exact',
      path: GROK_VIDEO_FILE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return fail(res, 405, 'method not allowed')
        if (!isTrustedRequest(req.socket.remoteAddress, req.headers, req.method)) return fail(res, 403, 'forbidden')
        if (disposed) return fail(res, 503, 'video downloads are unavailable')
        if (!options.enabled) return fail(res, 409, 'video generation is disabled')
        const controller = new AbortController()
        const signal = controller.signal
        active.add(controller)
        const onClose = () => { if (!res.writableEnded) controller.abort(new Error('client disconnected')) }
        res.on('close', onClose)
        try {
          const url = new URL(req.url ?? '', 'http://localhost')
          const ids = url.searchParams.getAll('taskId')
          if (ids.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'taskId')
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ids[0]!)) {
            return fail(res, 400, 'a single taskId UUID is required')
          }
          const identity = await options.identity()
          if (identity === undefined) return fail(res, 403, 'sign in with an identifiable xAI account')
          const task = (await options.tasks()).find(candidate => candidate.taskId === ids[0])
          signal.throwIfAborted()
          if (await options.identity() !== identity) return fail(res, 403, 'account changed')
          if (task === undefined) return fail(res, 404, 'video task not found')
          if (task.state !== 'done' || task.attachment === undefined) return fail(res, 409, 'video is not saved yet')
          const maxBytes = options.maxBytes ?? DEFAULT_VIDEO_MAX_BYTES
          const ref = task.attachment
          if (!Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > maxBytes) return fail(res, 413, 'video exceeds the download limit')
          const attachments = options.resolveAttachments()
          if (attachments === undefined) return fail(res, 503, 'file attachment storage is unavailable')
          let total = 0
          for await (const chunk of attachments.readFileStream(ref, signal)) {
            signal.throwIfAborted()
            if (await options.identity() !== identity) throw new Error('account changed')
            if (!(chunk instanceof Uint8Array)) throw new Error('invalid attachment chunk')
            total += chunk.byteLength
            if (total > maxBytes || total > ref.bytes) throw new Error('video exceeds the download limit')
            if (chunk.byteLength === 0) continue
            if (!res.headersSent) {
              res.writeHead(200, {
                'content-type': 'video/mp4',
                // Chunked completion waits for readFileStream's final digest verification.
                'content-disposition': `attachment; filename="grok-video-${task.taskId}.mp4"`,
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              })
            }
            if (!res.write(chunk)) await drain(res, signal)
          }
          signal.throwIfAborted()
          if (total !== ref.bytes || await options.identity() !== identity) throw new Error('video attachment verification failed')
          res.end()
        } catch {
          // Never expose storage paths, signed URLs, or credential diagnostics.
          fail(res, 500, 'video download failed; the saved task can be retried')
        } finally {
          active.delete(controller)
          res.off('close', onClose)
        }
      },
    })
    return () => {
      disposed = true
      unregister()
      for (const controller of active) controller.abort(new Error('video downloads disposed'))
      active.clear()
    }
  }, 'dsh-grok-kit: task-scoped video downloads')
}
