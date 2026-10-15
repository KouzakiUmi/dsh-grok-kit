//

// Part of dsh-grok-kit, Apache-2.0.

//

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GROK_QUOTA_PATH, registerGrokQuotaRoute } from '../src/quota-routes.ts'
import type { QuotaSnapshot, SuperGrokQuotaClient } from '../src/quota.ts'

const HOST = '127.0.0.1:3080'
const ISO = '2026-01-02T03:04:05.000Z'
const AVAILABLE: QuotaSnapshot = {
  state: 'available',
  usedPercent: 42.5,
  remainingPercent: 57.5,
  period: 'week',
  checkedAt: ISO,
  plan: 'SuperGrok',
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function mockCtx(): {
  ctx: Parameters<typeof registerGrokQuotaRoute>[0]
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
  return { ctx: ctx as unknown as Parameters<typeof registerGrokQuotaRoute>[0], handlers, disposers }
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
  destroyed = false
  writeHead(status: number, headers: Record<string, unknown>): void {
    this.statusCode = status
    this.headers = headers
  }
  end(body?: string): void {
    this.body = body ?? ''
    this.writableEnded = true
  }
}

type ClientStubs = {
  get?: (signal?: AbortSignal) => Promise<QuotaSnapshot>
}

function mockClient(stubs: ClientStubs = {}): SuperGrokQuotaClient & { getSpy: ReturnType<typeof vi.fn> } {
  const getSpy = vi.fn(stubs.get ?? (async () => AVAILABLE))
  return { get: getSpy as unknown as SuperGrokQuotaClient['get'], getSpy } as unknown as SuperGrokQuotaClient & { getSpy: ReturnType<typeof vi.fn> }
}

function setup(stubs: ClientStubs = {}) {
  const client = mockClient(stubs)
  const { ctx, handlers, disposers } = mockCtx()
  registerGrokQuotaRoute(ctx, client)
  return { client, handlers, disposers }
}

async function call(handler: RouteHandler, req: IncomingMessage, res: MockResponse) {
  await handler(req, res as unknown as ServerResponse)
  return {
    status: res.statusCode,
    headers: res.headers,
    body: res.body === '' ? undefined : JSON.parse(res.body) as unknown,
  }
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('GET /plugins/dsh-grok-kit/quota', () => {
  it('serves the snapshot with no-store and nosniff headers', async () => {
    const { handlers } = setup()
    const res = new MockResponse()
    const { status, headers, body } = await call(handlers.get(GROK_QUOTA_PATH)!, mockReq(), res)
    expect(status).toBe(200)
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['content-type']).toBe('application/json; charset=utf-8')
    expect(body).toEqual(AVAILABLE)
  })

  it('serves signed-out and fixed error states as 200 snapshot values', async () => {
    const { handlers } = setup({ get: async () => ({ state: 'signed-out' }) })
    const signedOut = await call(handlers.get(GROK_QUOTA_PATH)!, mockReq(), new MockResponse())
    expect(signedOut.status).toBe(200)
    expect(signedOut.body).toEqual({ state: 'signed-out' })

    const { handlers: errorHandlers } = setup({ get: async () => ({ state: 'error', reason: 'temporary' }) })
    const error = await call(errorHandlers.get(GROK_QUOTA_PATH)!, mockReq(), new MockResponse())
    expect(error.status).toBe(200)
    expect(error.body).toEqual({ state: 'error', reason: 'temporary' })
  })

  it('rejects wrong methods and untrusted peers', async () => {
    const { handlers } = setup()
    expect((await call(handlers.get(GROK_QUOTA_PATH)!, mockReq({ method: 'POST', headers: { origin: `http://${HOST}` } }), new MockResponse())).status).toBe(405)
    expect((await call(handlers.get(GROK_QUOTA_PATH)!, mockReq({ remote: '192.168.1.5' }), new MockResponse())).status).toBe(403)
    expect((await call(handlers.get(GROK_QUOTA_PATH)!, mockReq({ headers: { 'sec-fetch-site': 'cross-site' } }), new MockResponse())).status).toBe(403)
    expect((await call(handlers.get(GROK_QUOTA_PATH)!, mockReq({ headers: { host: 'attacker.example' } }), new MockResponse())).status).toBe(403)
  })

  it('returns a fixed error body when the client throws, without echoing diagnostics', async () => {
    const { handlers } = setup({
      get: async () => { throw new Error('Bearer eyJaaa.bbb.ccc failed for https://host/path?token=secret') },
    })
    const { status, body } = await call(handlers.get(GROK_QUOTA_PATH)!, mockReq(), new MockResponse())
    expect(status).toBe(503)
    expect(body).toEqual({ error: 'quota request failed' })
    expect(JSON.stringify(body)).not.toContain('eyJaaa')
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('aborts the in-flight get when the client disconnects and writes nothing after close', async () => {
    const client = mockClient({
      get: (signal?: AbortSignal) => new Promise<QuotaSnapshot>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    const { handlers } = setup(client)
    const res = new MockResponse()
    const pending = handlers.get(GROK_QUOTA_PATH)!(mockReq(), res as unknown as ServerResponse)
    await tick()
    expect(client.getSpy).toHaveBeenCalledWith(expect.any(AbortSignal))
    res.destroyed = true
    res.emit('close')
    await pending
    expect(res.statusCode).toBe(0)
    expect(res.body).toBe('')
  })

  it('dispose aborts every in-flight get and unregisters the route', async () => {
    const client = mockClient({
      get: (signal?: AbortSignal) => new Promise<QuotaSnapshot>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    const { handlers, disposers } = setup(client)
    const res = new MockResponse()
    const pending = handlers.get(GROK_QUOTA_PATH)!(mockReq(), res as unknown as ServerResponse)
    await tick()
    await disposers[0]!()
    await pending
    expect(handlers.has(GROK_QUOTA_PATH)).toBe(false)
    // The response was still open, so the fixed 503 body is written; a
    // disconnected client skips the write via the destroyed check instead.
    expect(res.statusCode).toBe(503)
    expect(JSON.parse(res.body)).toEqual({ error: 'quota request failed' })
  })
})
