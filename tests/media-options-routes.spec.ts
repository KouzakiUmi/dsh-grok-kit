import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerXaiOAuthAuthRoutes, XAI_OAUTH_AUTH_OPTIONS_PATH } from '../src/auth-routes.ts'
import { readStoredOptions, writeStoredOptions } from '../src/options.ts'
import { restoreEnv } from './restore-env.ts'

const originalHome = process.env.DSH_HOME
let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'grok-media-options-routes-'))
  process.env.DSH_HOME = home
})
afterEach(async () => {
  restoreEnv('DSH_HOME', originalHome)
  await rm(home, { recursive: true, force: true })
})

function routeFixture(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  registerXaiOAuthAuthRoutes({
    effect: (fn: () => unknown) => fn(),
    webServer: { register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
      handlers.set(route.path, route.handler)
      return () => undefined
    } },
  } as never, {} as never, config)
  return async (method: string, body?: unknown) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    req.method = method
    req.headers = { host: 'localhost:19387', origin: 'http://localhost:19387', 'content-type': 'application/json' }
    Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1' } })
    let status = 0
    let value: Record<string, unknown> = {}
    const res = {
      writeHead: (code: number) => { status = code },
      end: (text: string) => { value = JSON.parse(text) },
    } as unknown as ServerResponse
    await handlers.get(XAI_OAUTH_AUTH_OPTIONS_PATH)!(req, res)
    return { status, value }
  }
}

const OFF = { imagineTool: false, editTool: false, videoTool: false }

describe('media options POST admission', () => {
  it('shows fresh and legacy unconfirmed media as off without deleting the stored choices', async () => {
    const request = routeFixture()
    expect((await request('GET')).value.effective).toMatchObject(OFF)
    await writeStoredOptions({ imagineTool: true, editTool: true, videoTool: true })
    expect((await request('GET')).value.effective).toMatchObject(OFF)
    expect(readStoredOptions()).toEqual({ imagineTool: true, editTool: true, videoTool: true })
  })

  it.each(['imagineTool', 'editTool', 'videoTool'] as const)('rejects turning on %s without confirmation in that POST, including a stored older consent', async key => {
    await writeStoredOptions({ ...OFF, mediaRiskAcknowledged: true })
    const request = routeFixture()
    const denied = await request('POST', { [key]: true })
    expect(denied.status).toBe(400)
    expect(denied.value.error).toMatch(/mediaRiskAcknowledged/)
    expect(readStoredOptions()).toEqual({ ...OFF, mediaRiskAcknowledged: true })
    const accepted = await request('POST', { [key]: true, mediaRiskAcknowledged: true })
    expect(accepted.status).toBe(200)
    expect(accepted.value.effective).toMatchObject({ [key]: true })
  })

  it('rejects a raw true POST when no consent exists', async () => {
    const request = routeFixture()
    const response = await request('POST', { imagineTool: true, editTool: true, videoTool: true })
    expect(response.status).toBe(400)
    expect(readStoredOptions()).toEqual({})
  })

  it('opens both image tools explicitly without waking a hidden legacy video switch', async () => {
    const request = routeFixture({ imagineTool: true, editTool: true, videoTool: true })
    const response = await request('POST', { imagineTool: true, editTool: true, videoTool: false, mediaRiskAcknowledged: true })
    expect(response.status).toBe(200)
    expect(response.value.effective).toMatchObject({ imagineTool: true, editTool: true, videoTool: false, mediaRiskAcknowledged: true })
  })

  it('starts first confirmation from all off and selects only imagine despite old stored and Cordis true switches', async () => {
    const legacy = { imagineTool: true, editTool: true, videoTool: true }
    await writeStoredOptions({ ...legacy, backendSearch: true, searchMaxResults: 12 })
    const config = { ...legacy, searchModel: 'grok-build-0.1', nestedSearchTools: false }
    const request = routeFixture(config)
    const response = await request('POST', { imagineTool: true, mediaRiskAcknowledged: true })
    expect(response.status).toBe(200)
    expect(response.value.effective).toMatchObject({ imagineTool: true, editTool: false, videoTool: false, backendSearch: true, nestedSearchTools: false })
    expect(readStoredOptions()).toEqual({ imagineTool: true, editTool: false, videoTool: false, mediaRiskAcknowledged: true, backendSearch: true, searchMaxResults: 12 })
    // Reloaded routes and unrelated saves retain the new confirmed choices.
    expect((await routeFixture(config)('GET')).value.effective).toMatchObject({ imagineTool: true, editTool: false, videoTool: false })
    expect((await request('POST', { searchMaxResults: 13 })).status).toBe(200)
    expect(readStoredOptions()).toMatchObject({ imagineTool: true, editTool: false, videoTool: false, mediaRiskAcknowledged: true, searchMaxResults: 13 })
  })

  it('does not activate any old switch when first confirmation contains only acknowledgement', async () => {
    const legacy = { imagineTool: true, editTool: true, videoTool: true }
    await writeStoredOptions({ ...legacy, statefulResponses: true })
    const response = await routeFixture(legacy)('POST', { mediaRiskAcknowledged: true })
    expect(response.status).toBe(200)
    expect(response.value.effective).toMatchObject({ ...OFF, mediaRiskAcknowledged: true, statefulResponses: true })
    expect(readStoredOptions()).toEqual({ ...OFF, mediaRiskAcknowledged: true, statefulResponses: true })
  })

  it('allows closing and unrelated saves, but asks for confirmation on reopening', async () => {
    await writeStoredOptions({ imagineTool: true, editTool: true, mediaRiskAcknowledged: true })
    const request = routeFixture()
    expect((await request('POST', { backendSearch: true })).status).toBe(200)
    expect((await request('POST', { imagineTool: false, editTool: false })).status).toBe(200)
    expect((await request('POST', { imagineTool: true, editTool: true })).status).toBe(400)
    expect((await request('POST', { imagineTool: true, editTool: true, mediaRiskAcknowledged: true })).status).toBe(200)
    expect(readStoredOptions().backendSearch).toBe(true)
  })

  it.each(['imagineTool', 'editTool', 'videoTool'] as const)('rejects null-reset resurrecting a Cordis %s without current confirmation', async key => {
    await writeStoredOptions({ [key]: false, mediaRiskAcknowledged: true })
    const request = routeFixture({ [key]: true, mediaRiskAcknowledged: true })
    expect((await request('POST', { [key]: null })).status).toBe(400)
    expect(readStoredOptions()[key]).toBe(false)
    const reset = await request('POST', { [key]: null, mediaRiskAcknowledged: null })
    expect(reset.status).toBe(200)
    expect(reset.value.effective).toMatchObject(OFF)
    expect(readStoredOptions().mediaRiskAcknowledged).toBe(false)
  })

  it('serializes a close with a concurrent unrelated save without resurrecting media', async () => {
    await writeStoredOptions({ imagineTool: true, editTool: true, mediaRiskAcknowledged: true })
    const request = routeFixture()
    const results = await Promise.all([
      request('POST', { imagineTool: false, editTool: false }),
      request('POST', { searchMaxResults: 12 }),
    ])
    expect(results.map(result => result.status)).toEqual([200, 200])
    expect(readStoredOptions()).toMatchObject({ imagineTool: false, editTool: false, searchMaxResults: 12 })
  })
})
