/** Same-origin observed capabilities and account-scoped local video task routes. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { errorStatus, isTrustedRequest, readJson } from './auth-routes.ts'
import { sanitizeDiagnosticMessage, type CapabilityTracker } from './capabilities.ts'

export const GROK_CAPABILITIES_PATH = '/plugins/dsh-grok-kit/capabilities'
export const GROK_VIDEO_TASKS_PATH = '/plugins/dsh-grok-kit/video/tasks'
export const GROK_VIDEO_RESUME_PATH = '/plugins/dsh-grok-kit/video/resume'
export const GROK_VIDEO_CLEAR_PATH = '/plugins/dsh-grok-kit/video/tasks/clear'

export interface GrokCapabilityRouteOptions {
  tracker: CapabilityTracker
  videoEnabled: boolean | (() => boolean)
  authenticated: () => Promise<boolean>
  /** Optional for legacy callers; production supplies the stable OAuth partition. */
  identity?: () => Promise<string | undefined>
  /** Local-only, already account-partitioned task summaries; never performs upstream probes. */
  tasks: () => Promise<unknown[]>
  /** Queries/downloads one task already owned by the current account, never generates. */
  resume: (taskId: string, signal?: AbortSignal) => Promise<unknown>
  /**
   * Removes finished (`scope: 'done'`) or all (`scope: 'all'`) tasks of the
   * signed-in identity from the local store; never contacts the upstream and
   * never touches another account's records. Returns the count removed.
   */
  clear: (scope: 'done' | 'all') => Promise<number>
}

function trustedRequest(req: IncomingMessage): boolean {
  return isTrustedRequest(req.socket.remoteAddress, req.headers, req.method ?? 'GET')
}
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
function guarded(handler: Handler): Handler {
  return async (req, res) => {
    try { await handler(req, res) } catch (error) {
      const status = errorStatus(error)
      const message = status === 413 ? 'request body too large'
        : status === 400 ? 'invalid video task request'
          : 'video task request failed'
      // Never echo JSON parse snippets, store paths, or arbitrary upstream errors.
      json(res, status, { error: message })
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function parseResumeBody(body: unknown): { taskId: string } | undefined {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !('taskId' in body)) return undefined
  return typeof body.taskId === 'string' && UUID_PATTERN.test(body.taskId) ? { taskId: body.taskId } : undefined
}

/** Body of the clear route: exactly `{ scope: 'done' | 'all' }`. */
export function parseClearBody(body: unknown): { scope: 'done' | 'all' } | undefined {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !('scope' in body)) return undefined
  const scope = body.scope
  return scope === 'done' || scope === 'all' ? { scope } : undefined
}

/** Defense-in-depth projection: adding internal task fields must never expand the Web response. */
function publicTask(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.taskId !== 'string' || !UUID_PATTERN.test(value.taskId)) {
    throw new Error('invalid task summary')
  }
  const result: Record<string, unknown> = {}
  for (const key of ['taskId', 'state', 'model', 'createdAt', 'updatedAt', 'prompt', 'resolution'] as const) {
    if (typeof value[key] === 'string') result[key] = value[key]
  }
  if (typeof value.duration === 'number' && Number.isSafeInteger(value.duration)) result.duration = value.duration
  if (typeof value.error === 'string') result.error = sanitizeDiagnosticMessage(value.error)
  const ref = value.attachment
  if (isRecord(ref) && typeof ref.attachmentId === 'string' && typeof ref.name === 'string'
    && typeof ref.bytes === 'number' && Number.isSafeInteger(ref.bytes) && ref.bytes > 0) {
    result.attachment = { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes }
  }
  return result
}

export function registerGrokCapabilityRoutes(ctx: Context, options: GrokCapabilityRouteOptions): void {
  const { tracker } = options
  const videoEnabled = (): boolean => typeof options.videoEnabled === 'function' ? options.videoEnabled() : options.videoEnabled
  const resumeAborts = new Set<AbortController>()
  const unchanged = async (identity: string | undefined): Promise<boolean> =>
    options.identity === undefined || (identity !== undefined && await options.identity() === identity)
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact', path: GROK_CAPABILITIES_PATH,
        handler: guarded(async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (!await options.authenticated()) tracker.reset()
          json(res, 200, tracker.snapshot(videoEnabled()))
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: GROK_VIDEO_TASKS_PATH,
        handler: guarded(async (req, res) => {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (!videoEnabled()) return json(res, 409, { error: 'video is disabled by the plugin configuration' })
          if (!await options.authenticated()) {
            tracker.reset()
            return json(res, 403, { error: 'forbidden' })
          }
          const identity = await options.identity?.()
          const tasks = await options.tasks()
          if (!await unchanged(identity)) return json(res, 403, { error: 'account changed or cannot be identified' })
          json(res, 200, { tasks: tasks.map(publicTask) })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: GROK_VIDEO_RESUME_PATH,
        handler: guarded(async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (!videoEnabled()) return json(res, 409, { error: 'video is disabled by the plugin configuration' })
          if (!await options.authenticated()) {
            tracker.reset()
            return json(res, 403, { error: 'forbidden' })
          }
          const parsed = parseResumeBody(await readJson(req))
          if (parsed === undefined) return json(res, 400, { error: 'body must be exactly { taskId: <uuid> }' })
          const identity = await options.identity?.()
          if (!await unchanged(identity)) return json(res, 403, { error: 'account cannot be identified' })
          if (!videoEnabled()) return json(res, 409, { error: 'video is disabled by the plugin configuration' })
          const abort = new AbortController()
          resumeAborts.add(abort)
          const onClose = () => { if (!res.writableEnded) abort.abort(new Error('client disconnected')) }
          res.on('close', onClose)
          try {
            const result = await options.resume(parsed.taskId, abort.signal)
            if (!await unchanged(identity)) return json(res, 403, { error: 'account changed' })
            json(res, 200, publicTask(result))
          } finally {
            res.off('close', onClose)
            resumeAborts.delete(abort)
          }
        }),
      }),
      ctx.webServer.register({
        kind: 'exact', path: GROK_VIDEO_CLEAR_PATH,
        handler: guarded(async (req, res) => {
          if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          if (!videoEnabled()) return json(res, 409, { error: 'video is disabled by the plugin configuration' })
          if (!await options.authenticated()) {
            tracker.reset()
            return json(res, 403, { error: 'forbidden' })
          }
          const parsed = parseClearBody(await readJson(req))
          if (parsed === undefined) return json(res, 400, { error: 'body must be exactly { scope: "done" | "all" }' })
          const identity = await options.identity?.()
          if (!await unchanged(identity)) return json(res, 403, { error: 'account cannot be identified' })
          // Re-check like resume: config may have changed while the async
          // identity read was in flight.
          if (!videoEnabled()) return json(res, 409, { error: 'video is disabled by the plugin configuration' })
          const removed = await options.clear(parsed.scope)
          if (!await unchanged(identity)) return json(res, 403, { error: 'account changed' })
          json(res, 200, { removed })
        }),
      }),
    ]
    return () => {
      for (const abort of resumeAborts) abort.abort(new Error('capability routes disposed'))
      resumeAborts.clear()
      for (const dispose of routes) dispose()
    }
  }, 'dsh-grok-kit: capability routes')
}
