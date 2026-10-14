//

// Part of dsh-grok-kit, Apache-2.0.

//

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CapabilityTracker } from '../src/capabilities.ts'
import {
  GROK_CAPABILITIES_PATH,
  GROK_VIDEO_RESUME_PATH,
  GROK_VIDEO_TASKS_PATH,
  parseResumeBody,
  registerGrokCapabilityRoutes,
  type GrokCapabilityRouteOptions,
} from '../src/capability-routes.ts'

const UUID = '123e4567-e89b-42d3-a456-426614174000'
const HOST = '127.0.0.1:3080'
const ISO = '2026-01-02T03:04:05.000Z'
const TASK = { taskId: UUID, state: 'pending', model: 'grok-imagine-video-1.5', createdAt: ISO, updatedAt: ISO, prompt: 'animate' }

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function mockCtx(): {
  ctx: Parameters<typeof registerGrokCapabilityRoutes>[0]
  handlers: Map<string, RouteHandler>
  disposers: Array<() => void | Promise<void>>
} {
  const handlers = new Map<string, RouteHandler>()
  const disposers: Array<() => void | Promise<void>> = []
  const ctx = {
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn())
    },
    webServer: {
      register(route: { path: string; handler: RouteHandler }) {
        handlers.set(route.path, route.handler)
        return () => {
          handlers.delete(route.path)
        }
      },
    },
  }
  return { ctx: ctx as unknown as Parameters<typeof registerGrokCapabilityRoutes>[0], handlers, disposers }
}

interface RequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  remote?: string
}

function mockReq(init: RequestInit = {}): IncomingMessage {
  const req = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]) as unknown as IncomingMessage
  req.method = init.method ?? 'GET'
  req.headers = { host: HOST, ...init.headers }
  ;(req as { socket: { remoteAddress?: string } }).socket = { remoteAddress: init.remote ?? '127.0.0.1' }
  return req
}

class MockResponse extends EventEmitter {
  statusCode = 0
  headers: Record<string, unknown> = {}
  body = ''
  writableEnded = false
  writeHead(status: number, headers: Record<string, unknown>): void {
    this.statusCode = status
    this.headers = headers
  }
  end(body?: string): void {
    this.body = body ?? ''
    this.writableEnded = true
  }
}

function setup(overrides: Partial<GrokCapabilityRouteOptions> = {}, videoEnabled = true) {
  const tracker = new CapabilityTracker()
  const tasks = vi.fn(async () => [TASK])
  const resume = vi.fn(async (_taskId: string, _signal?: AbortSignal) => TASK)
  const authenticated = vi.fn(async () => true)
  const { ctx, handlers, disposers } = mockCtx()
  registerGrokCapabilityRoutes(ctx, { tracker, videoEnabled, authenticated, tasks, resume, ...overrides })
  return { tracker, tasks, resume, authenticated, handlers, disposers }
}

async function call(handler: RouteHandler, req: IncomingMessage, res: MockResponse) {
  await handler(req, res as unknown as ServerResponse)
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body === '' ? undefined : JSON.parse(res.body) as unknown,
  }
}

const POST_HEADERS = { origin: `http://${HOST}`, 'content-type': 'application/json' }

describe('GET /capabilities', () => {
  it('serves the tracker snapshot with no-store headers and no probe', async () => {
    const { tracker, handlers, resume, tasks } = setup()
    tracker.observe('video', { state: 'available', checkedAt: ISO, model: 'grok-video' })
    const res = new MockResponse()
    const { status, headers, body } = await call(handlers.get(GROK_CAPABILITIES_PATH)!, mockReq(), res)
    expect(status).toBe(200)
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(body).toMatchObject({
      videoEnabled: true,
      quota: { state: 'unavailable' },
      features: expect.arrayContaining([expect.objectContaining({ id: 'video', state: 'available' })]),
    })
    expect(resume).not.toHaveBeenCalled()
    expect(tasks).not.toHaveBeenCalled()
  })

  it('resets recorded history for a signed-out viewer (unverified + quota unreadable)', async () => {
    const { tracker, handlers } = setup({ authenticated: async () => false })
    tracker.observe('video', {
      state: 'restricted',
      checkedAt: ISO,
      model: 'grok-video',
      httpStatus: 403,
    })
    const { status, body } = await call(handlers.get(GROK_CAPABILITIES_PATH)!, mockReq(), new MockResponse())
    expect(status).toBe(200)
    expect(body).toMatchObject({
      features: expect.arrayContaining([expect.objectContaining({ id: 'video', state: 'unverified' })]),
      quota: { state: 'unavailable' },
    })
    // The reset is real: even an authenticated snapshot stays clean afterwards.
    expect(tracker.snapshot(true).features[0]!.state).toBe('unverified')
  })

  it('rejects untrusted requests and wrong methods', async () => {
    const { handlers } = setup()
    const handler = handlers.get(GROK_CAPABILITIES_PATH)!
    await expect(call(handler, mockReq({ remote: '192.168.1.10' }), new MockResponse()))
      .resolves.toMatchObject({ status: 403 })
    await expect(call(handler, mockReq({ headers: { host: 'evil.example' } }), new MockResponse()))
      .resolves.toMatchObject({ status: 403 })
    await expect(call(handler, mockReq({ headers: { 'sec-fetch-site': 'cross-site' } }), new MockResponse()))
      .resolves.toMatchObject({ status: 403 })
    await expect(call(handler, mockReq({ method: 'POST', headers: { origin: `http://${HOST}` } }), new MockResponse()))
      .resolves.toMatchObject({ status: 405 })
  })
})

describe('route account and response boundaries', () => {
  it('contains authentication failures without exposing credential diagnostics', async () => {
    const { handlers } = setup({ authenticated: async () => { throw new Error('private path api_key=supersecret') } })
    const { status, body } = await call(handlers.get(GROK_CAPABILITIES_PATH)!, mockReq(), new MockResponse())
    expect(status).toBe(500)
    expect(JSON.stringify(body)).not.toMatch(/private|supersecret|api_key/)
  })

  it('does not return a list after its account changes during the local read', async () => {
    let identity = 'account-a'
    const { handlers } = setup({ identity: async () => identity, tasks: async () => { identity = 'account-b'; return [TASK] } })
    const { status, body } = await call(handlers.get(GROK_VIDEO_TASKS_PATH)!, mockReq(), new MockResponse())
    expect(status).toBe(403)
    expect(JSON.stringify(body)).not.toContain('animate')
  })

  it('projects task and attachment fields without leaking internal handles or paths', async () => {
    const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'video.mp4', bytes: 16 }
    const { handlers } = setup({ tasks: async () => [{ ...TASK, requestId: 'secret-request', storePath: 'private-path', signedUrl: 'https://vidgen.x.ai/?sig=secret', attachment: { ...ref, token: 'secret-token' } }] })
    const { status, body } = await call(handlers.get(GROK_VIDEO_TASKS_PATH)!, mockReq(), new MockResponse())
    expect(status).toBe(200)
    expect(body).toEqual({ tasks: [{ ...TASK, attachment: ref }] })
  })

  it('does not return a resumed result to an account that changed while waiting', async () => {
    let identity = 'account-a'
    const { handlers } = setup({ identity: async () => identity, resume: async () => { identity = 'account-b'; return TASK } })
    const { status, body } = await call(handlers.get(GROK_VIDEO_RESUME_PATH)!, mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }), new MockResponse())
    expect(status).toBe(403)
    expect(JSON.stringify(body)).not.toContain('animate')
  })
})

describe('GET /video/tasks', () => {
  it('disables capabilities, history and resume after the current media switch closes', async () => {
    let enabled = true
    const { handlers, tasks, resume } = setup({ videoEnabled: () => enabled })
    enabled = false
    expect((await call(handlers.get(GROK_CAPABILITIES_PATH)!, mockReq(), new MockResponse())).body).toMatchObject({ videoEnabled: false })
    expect((await call(handlers.get(GROK_VIDEO_TASKS_PATH)!, mockReq(), new MockResponse())).status).toBe(409)
    expect((await call(handlers.get(GROK_VIDEO_RESUME_PATH)!, mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }), new MockResponse())).status).toBe(409)
    expect(tasks).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('serves the local task list without any upstream probe', async () => {
    const { handlers, tasks, resume } = setup()
    const { status, body } = await call(handlers.get(GROK_VIDEO_TASKS_PATH)!, mockReq(), new MockResponse())
    expect(status).toBe(200)
    expect(body).toEqual({ tasks: [TASK] })
    expect(tasks).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })

  it('rejects a signed-out viewer with 403 and resets recorded history', async () => {
    const { tracker, handlers, tasks } = setup({ authenticated: async () => false })
    tracker.observe('video', { state: 'available', checkedAt: ISO, model: 'grok-video' })
    const { status } = await call(handlers.get(GROK_VIDEO_TASKS_PATH)!, mockReq(), new MockResponse())
    expect(status).toBe(403)
    expect(tasks).not.toHaveBeenCalled()
    expect(tracker.snapshot(true).features[0]!.state).toBe('unverified')
  })

  it('rejects untrusted requests and wrong methods', async () => {
    const { handlers, tasks } = setup()
    const handler = handlers.get(GROK_VIDEO_TASKS_PATH)!
    await expect(call(handler, mockReq({ remote: '::ffff:203.0.113.5' }), new MockResponse()))
      .resolves.toMatchObject({ status: 403 })
    await expect(call(handler, mockReq({ method: 'POST', headers: { origin: `http://${HOST}` } }), new MockResponse()))
      .resolves.toMatchObject({ status: 405 })
    expect(tasks).not.toHaveBeenCalled()
  })
})

describe('POST /video/resume', () => {
  it('resumes an existing task with an abort signal and returns the task result directly', async () => {
    const { handlers, resume } = setup()
    const { status, body } = await call(
      handlers.get(GROK_VIDEO_RESUME_PATH)!,
      mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }),
      new MockResponse(),
    )
    expect(status).toBe(200)
    expect(body).toEqual(TASK)
    expect(resume).toHaveBeenCalledTimes(1)
    const [taskId, signal] = resume.mock.calls[0]!
    expect(taskId).toBe(UUID)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(false)
  })

  it('rejects unknown fields, malformed uuids, and bad bodies with 400', async () => {
    const { handlers, resume } = setup()
    const handler = handlers.get(GROK_VIDEO_RESUME_PATH)!
    const post = (body: string, headers = POST_HEADERS) =>
      call(handler, mockReq({ method: 'POST', headers, body }), new MockResponse())
    await expect(post(JSON.stringify({ taskId: UUID, extra: 1 }))).resolves.toMatchObject({ status: 400 })
    await expect(post(JSON.stringify({ taskId: 'not-a-uuid' }))).resolves.toMatchObject({ status: 400 })
    await expect(post(JSON.stringify({}))).resolves.toMatchObject({ status: 400 })
    await expect(post('{nope')).resolves.toMatchObject({ status: 400 })
    await expect(post('a=1', { ...POST_HEADERS, 'content-type': 'application/x-www-form-urlencoded' }))
      .resolves.toMatchObject({ status: 400 })
    expect(resume).not.toHaveBeenCalled()
  })

  it('rejects an oversized body with 413', async () => {
    const { handlers, resume } = setup()
    const big = JSON.stringify({ taskId: UUID }) + ' '.repeat(1024 * 1024)
    await expect(call(
      handlers.get(GROK_VIDEO_RESUME_PATH)!,
      mockReq({ method: 'POST', headers: POST_HEADERS, body: big }),
      new MockResponse(),
    )).resolves.toMatchObject({ status: 413 })
    expect(resume).not.toHaveBeenCalled()
  })

  it('returns 409 while the video feature flag is off', async () => {
    const { handlers, resume } = setup({}, false)
    const { status, body } = await call(
      handlers.get(GROK_VIDEO_RESUME_PATH)!,
      mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }),
      new MockResponse(),
    )
    expect(status).toBe(409)
    expect(String((body as { error: string }).error)).toMatch(/video/i)
    expect(resume).not.toHaveBeenCalled()
  })

  it('rejects a signed-out viewer with 403 and resets recorded history', async () => {
    const { tracker, handlers, resume } = setup({ authenticated: async () => false })
    tracker.observe('video', { state: 'available', checkedAt: ISO, model: 'grok-video' })
    const { status } = await call(
      handlers.get(GROK_VIDEO_RESUME_PATH)!,
      mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }),
      new MockResponse(),
    )
    expect(status).toBe(403)
    expect(resume).not.toHaveBeenCalled()
    expect(tracker.snapshot(true).features[0]!.state).toBe('unverified')
  })

  it('keeps the write gate for browser writes (sec-fetch-site present, no Origin → 403)', async () => {
    const { handlers, resume } = setup()
    const { status } = await call(
      handlers.get(GROK_VIDEO_RESUME_PATH)!,
      mockReq({ method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ taskId: UUID }) }),
      new MockResponse(),
    )
    expect(status).toBe(403)
    expect(resume).not.toHaveBeenCalled()
  })

  it('accepts shell-forwarded writes (no Origin, no sec-fetch-site, Fetch-Metadata marker → desktop shape)', async () => {
    const { handlers, resume } = setup()
    const { status } = await call(
      handlers.get(GROK_VIDEO_RESUME_PATH)!,
      mockReq({ method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-mode': 'cors' }, body: JSON.stringify({ taskId: UUID }) }),
      new MockResponse(),
    )
    expect(status).toBe(200)
    expect(resume).toHaveBeenCalled()
  })

  it('redacts upstream error messages', async () => {
    const { handlers } = setup({
      resume: async () => {
        throw new Error('upstream said Bearer supersecret123 denied')
      },
    })
    const { status, body } = await call(
      handlers.get(GROK_VIDEO_RESUME_PATH)!,
      mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }),
      new MockResponse(),
    )
    expect(status).toBe(500)
    const error = String((body as { error: string }).error)
    expect(error).toBe('video task request failed')
    expect(error).not.toContain('supersecret123')
  })

  it('aborts the in-flight resume when the client disconnects', async () => {
    let seen: AbortSignal | undefined
    const { handlers } = setup({
      resume: (_taskId, signal) => new Promise((_resolve, reject) => {
        const s = signal!
        seen = s
        s.addEventListener('abort', () => reject(s.reason), { once: true })
      }),
    })
    const res = new MockResponse()
    const pending = handlers.get(GROK_VIDEO_RESUME_PATH)!(
      mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }),
      res as unknown as ServerResponse,
    )
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect(res.listenerCount('close')).toBe(1)
    res.emit('close')
    // The handler owns the response: it catches the aborted resume and writes
    // the error response, so the handler promise resolves — the signal is the
    // observable that must be aborted.
    await pending
    expect(seen!.aborted).toBe(true)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('dispose aborts every in-flight resume and unregisters the routes', async () => {
    const seen: AbortSignal[] = []
    const { handlers, disposers } = setup({
      resume: (_taskId, signal) => new Promise((_resolve, reject) => {
        seen.push(signal!)
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      }),
    })
    const first = handlers.get(GROK_VIDEO_RESUME_PATH)!(
      mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }),
      new MockResponse() as unknown as ServerResponse,
    )
    const second = handlers.get(GROK_VIDEO_RESUME_PATH)!(
      mockReq({ method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ taskId: UUID }) }),
      new MockResponse() as unknown as ServerResponse,
    )
    await vi.waitFor(() => expect(seen.length).toBe(2))
    await disposers[0]!()
    await Promise.all([first, second])
    expect(seen.every(signal => signal.aborted)).toBe(true)
    expect(handlers.size).toBe(0)
  })
})

describe('parseResumeBody', () => {
  it('accepts exactly { taskId: <uuid> }', () => {
    expect(parseResumeBody({ taskId: UUID })).toEqual({ taskId: UUID })
    expect(parseResumeBody({ taskId: UUID.toUpperCase() })).toEqual({ taskId: UUID.toUpperCase() })
  })

  it('rejects everything else', () => {
    expect(parseResumeBody({ taskId: 'nope' })).toBeUndefined()
    expect(parseResumeBody({ taskId: UUID, extra: true })).toBeUndefined()
    expect(parseResumeBody({})).toBeUndefined()
    expect(parseResumeBody(null)).toBeUndefined()
    expect(parseResumeBody([UUID])).toBeUndefined()
    expect(parseResumeBody('x')).toBeUndefined()
  })
})
