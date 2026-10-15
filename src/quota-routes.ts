//

// Part of dsh-grok-kit, Apache-2.0.

//

/** Same-origin SuperGrok quota route over the shared OAuth session. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isTrustedRequest } from './auth-routes.ts'
import type { SuperGrokQuotaClient } from './quota.ts'

export const GROK_QUOTA_PATH = '/plugins/dsh-grok-kit/quota'

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

/**
 * Register GET /plugins/dsh-grok-kit/quota. The client performs its own
 * identity partitioning and never returns another account's data; this route
 * only adds the same-origin gate, the disconnect abort, and a fixed error
 * body — no upstream diagnostic, response body, or credential ever reaches
 * the response.
 */
export function registerGrokQuotaRoute(ctx: Context, client: SuperGrokQuotaClient): void {
  ctx.effect(() => {
    const inFlight = new Set<AbortController>()
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: GROK_QUOTA_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
          const abort = new AbortController()
          inFlight.add(abort)
          const onClose = () => { if (!res.writableEnded) abort.abort(new Error('client disconnected')) }
          res.on('close', onClose)
          try {
            // Signed-out and error states are legitimate snapshot values: the
            // response is always 200 with the state union the UI renders.
            json(res, 200, await client.get(abort.signal))
          } finally {
            res.off('close', onClose)
            inFlight.delete(abort)
          }
        } catch {
          // Disconnects land here after the response is gone; never echo the
          // abort reason or anything the client threw.
          json(res, 503, { error: 'quota request failed' })
        }
      },
    })
    return () => {
      for (const abort of inFlight) abort.abort(new Error('quota route disposed'))
      inFlight.clear()
      dispose()
    }
  }, 'dsh-grok-kit: quota route')
}
