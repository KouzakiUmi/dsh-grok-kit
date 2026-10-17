import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessageEventStream, type Provider } from '@earendil-works/pi-ai'
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai'
import * as ts from 'typescript'
import {
  assertBearerDestination,
  BearerDestinationError,
  fetchWithBearer,
  guardBearerFetch,
  isBearerDestination,
  OAUTH_BEARER_EXACT_URL,
  OAUTH_BEARER_HOSTS,
} from '../src/bearer-guard.ts'
import { GROK_46_MODEL, XAI_MODELS_URL } from '../src/catalog.ts'
import { GROK_GRPC_CREDITS_URL } from '../src/grok-credits.ts'
import { XAI_IMAGES_URL } from '../src/imagine.ts'
import { XAI_IMAGES_EDIT_URL } from '../src/imagine-edit-core.ts'
import { GROK_BILLING_URL, GROK_SETTINGS_URL } from '../src/quota.ts'
import { wrapXaiResponsesProvider } from '../src/responses.ts'
import { XAI_RESPONSES_URL } from '../src/search.ts'
import { XAI_VIDEO_GENERATIONS_URL, xaiVideoStatusUrl } from '../src/video-core.ts'

const EXACT_PATH = '/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'

const ALLOWED = [
  'https://api.x.ai/v1/models',
  'https://API.X.AI/v1/responses',
  'https://api.x.ai:443/v1/images/generations',
  'https://api.x.ai/v1/videos/req_123',
  'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  'https://cli-chat-proxy.grok.com/v1/settings',
  `https://grok.com${EXACT_PATH}`,
  `https://grok.com${EXACT_PATH}?`,
  XAI_MODELS_URL,
  XAI_IMAGES_URL,
  XAI_IMAGES_EDIT_URL,
  XAI_RESPONSES_URL,
  XAI_VIDEO_GENERATIONS_URL,
  xaiVideoStatusUrl('req_123'),
  xaiVideoStatusUrl('a/b c'),
  GROK_BILLING_URL,
  GROK_SETTINGS_URL,
  GROK_GRPC_CREDITS_URL,
]

const REFUSED = [
  'http://api.x.ai/v1/models',
  'http://grok.com' + EXACT_PATH,
  'https://www.grok.com' + EXACT_PATH,
  'https://grok.com.evil.example' + EXACT_PATH,
  'https://grok.com' + EXACT_PATH + '/extra',
  'https://grok.com' + EXACT_PATH + 'extra',
  'https://grok.com/grok_api_v2.GrokBuildBilling/getgrokcreditsconfig',
  'https://grok.com/',
  'https://grok.com/other',
  'https://grok.com' + EXACT_PATH + '?extra=1',
  'https://grok.com' + EXACT_PATH + '#frag',
  'https://grok.com//' + EXACT_PATH.slice(1),
  'https://evil.example/v1/models',
  'https://api.x.ai.evil.example/v1/models',
  'https://notapi.x.ai/v1/models',
  'https://api.x.ai./v1/models',
  'https://api.x.ai:444/v1/models',
  'https://user:pass@api.x.ai/v1/models',
  'https://api.x.ai@evil.example/v1/models',
  'https://auth.x.ai/oauth2/token',
  'https://vidgen.x.ai/signed.mp4',
  'https://x.ai/v1/models',
  'https://cli-chat-proxy.grok.com.evil.example/v1/billing',
  'https://evilcli-chat-proxy.grok.com/v1/billing',
  'https://www.api.x.ai/v1/models',
  'https://аpi.x.ai/v1/models',
  'not a url',
  '//api.x.ai/v1/models',
  'file:///etc/passwd',
]

describe('OAuth bearer destinations', () => {
  it('locks the allowlist to the official hosts and the one grok.com path', () => {
    expect([...OAUTH_BEARER_HOSTS]).toEqual(['api.x.ai', 'cli-chat-proxy.grok.com'])
    expect(OAUTH_BEARER_EXACT_URL).toBe(`https://grok.com${EXACT_PATH}`)
    expect(GROK_GRPC_CREDITS_URL).toBe(OAUTH_BEARER_EXACT_URL)
  })

  it('accepts the endpoints this plugin calls and parser-equivalent forms', () => {
    for (const url of ALLOWED) {
      expect(isBearerDestination(url), url).toBe(true)
      expect(isBearerDestination(new URL(url)), url).toBe(true)
    }
  })

  it('refuses look-alikes, other hosts, non-https, and non-absolute URLs', () => {
    const accepted = REFUSED.filter(url => isBearerDestination(url))
    expect(accepted).toEqual([])
    for (const url of REFUSED) {
      expect(() => assertBearerDestination(url), url).toThrow(BearerDestinationError)
    }
  })

  it('does not put the token or the query in a refusal', () => {
    const token = 'super-secret-token'
    expect(() => assertBearerDestination(`https://evil.example/path?access_token=${token}#${token}`)).toThrow(
      /https:\/\/evil\.example\/path$/u,
    )
    try {
      assertBearerDestination(`https://user:${token}@evil.example/path?q=${token}`)
      expect.fail('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(BearerDestinationError)
      expect((error as Error).message).not.toContain(token)
      expect((error as Error).message).toBe('refusing to send the OAuth bearer to https://evil.example/path')
    }
  })
})

describe('fetchWithBearer', () => {
  it('sends the bearer only after the destination is accepted', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const signal = new AbortController().signal
    const response = await fetchWithBearer(fetchImpl as typeof fetch, XAI_RESPONSES_URL, 'oauth-secret', {
      method: 'POST',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: 'Bearer stale' },
      body: '{"n":1}',
      signal,
    })
    expect(await response.text()).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(XAI_RESPONSES_URL)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.body).toBe('{"n":1}')
    expect(init.signal).toBe(signal)
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer oauth-secret')
    expect(headers.accept).toBe('application/json')
  })

  it('does not call fetch when the destination is refused', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope'))
    const token = 'super-secret-token'
    const refused = 'https://www.grok.com' + EXACT_PATH
    expect(() => fetchWithBearer(fetchImpl as typeof fetch, refused, token)).toThrow(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(() => fetchWithBearer(fetchImpl as typeof fetch, refused, token)).toThrow(
      /^refusing to send the OAuth bearer to https:\/\/www\.grok\.com/u,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('overrides a caller redirect of follow', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const init: RequestInit = { method: 'GET', redirect: 'follow', headers: { accept: 'application/json' } }
    await fetchWithBearer(fetchImpl as typeof fetch, XAI_MODELS_URL, 'oauth-secret', init)
    expect(init.redirect).toBe('follow')
    const [, sent] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit]
    expect(sent.redirect).toBe('error')
    expect(sent.method).toBe('GET')
    expect((sent.headers as Record<string, string>).authorization).toBe('Bearer oauth-secret')
  })
})

describe('guardBearerFetch', () => {
  const inner = () => vi.fn(async () => new Response('ok'))

  it('sends an allowlisted bearer with redirect error', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    const init: RequestInit = {
      method: 'POST',
      redirect: 'follow',
      headers: { Authorization: 'Bearer secret', 'content-type': 'application/json' },
    }
    await guarded('https://api.x.ai/v1/responses', init)
    expect(init.redirect).toBe('follow')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, sent] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.x.ai/v1/responses')
    expect(sent.method).toBe('POST')
    expect(sent.redirect).toBe('error')
    expect(sent.headers).toBe(init.headers)
  })

  it('refuses a bearer on a look-alike before fetch runs', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    await expect(guarded('https://grok.com' + EXACT_PATH + '/extra', {
      headers: [['authorization', 'bearer secret-token']],
    })).rejects.toBeInstanceOf(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses duplicate and mixed-case authorization off the allowlist', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    const cases: RequestInit[] = [
      { headers: [['authorization', 'Basic x'], ['authorization', 'Bearer s']] },
      { headers: [['Authorization', 'bEaReR secret-token']] },
      { redirect: 'follow', headers: { authorization: 'Basic x, Bearer s' } },
    ]
    const appended = new Headers()
    appended.append('authorization', 'Basic x')
    appended.append('Authorization', 'Bearer s')
    cases.push({ headers: appended, redirect: 'follow' })
    for (const init of cases) {
      await expect(guarded('https://evil.example/steal', init)).rejects.toBeInstanceOf(BearerDestinationError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    const allowed = new Headers()
    allowed.append('authorization', 'Basic x')
    allowed.append('authorization', 'Bearer s')
    await guarded('https://api.x.ai/v1/models', { headers: allowed, redirect: 'manual' })
    const [, sent] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit]
    expect(sent.redirect).toBe('error')
    expect(sent.headers).toBe(allowed)
  })

  it('refuses a Request that already carries the bearer', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    const request = new Request('https://evil.example/steal', {
      headers: { authorization: 'Bearer secret-token' },
      redirect: 'follow',
    })
    await expect(guarded(request)).rejects.toBeInstanceOf(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('treats either the Request or init.headers as credentialed', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    const bearerOnRequest = new Request('https://evil.example/steal', {
      headers: { authorization: 'Bearer secret-token' },
      redirect: 'follow',
    })
    await expect(guarded(bearerOnRequest, {
      redirect: 'follow',
      headers: { accept: 'text/plain' },
    })).rejects.toBeInstanceOf(BearerDestinationError)

    const bearerOnInit = new Request('https://evil.example/steal', {
      headers: { accept: 'text/plain' },
    })
    await expect(guarded(bearerOnInit, {
      redirect: 'follow',
      headers: { authorization: 'bEaReR secret-token' },
    })).rejects.toBeInstanceOf(BearerDestinationError)

    const basicOnInit = new Request('https://evil.example/steal', {
      headers: [['authorization', 'Basic x'], ['authorization', 'Bearer s']],
    })
    await expect(guarded(basicOnInit, {
      headers: { authorization: 'Basic only' },
    })).rejects.toBeInstanceOf(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()

    const allowed = new Request('https://api.x.ai/v1/models', {
      headers: { authorization: 'Bearer secret-token' },
      redirect: 'follow',
    })
    const init: RequestInit = { redirect: 'follow', headers: { accept: 'application/json' } }
    await guarded(allowed, init)
    expect(init.redirect).toBe('follow')
    expect(allowed.redirect).toBe('follow')
    const [sentRequest, sentInit] = fetchImpl.mock.calls[0] as unknown as [Request, RequestInit]
    expect(sentRequest).toBe(allowed)
    expect(sentInit.redirect).toBe('error')
    expect(sentInit.headers).toEqual({ accept: 'application/json' })
  })

  it('forwards token-free requests and keeps their redirect mode', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    const download: RequestInit = { headers: { accept: 'video/mp4' }, redirect: 'follow' }
    const login: RequestInit = {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }
    await guarded('https://vidgen.x.ai/signed.mp4', download)
    await guarded('https://auth.x.ai/oauth2/token', login)
    expect(fetchImpl.mock.calls).toEqual([
      ['https://vidgen.x.ai/signed.mp4', download],
      ['https://auth.x.ai/oauth2/token', login],
    ])
  })

  it('treats unreadable headers as credentialed and fails closed', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    const headers = { 'bad header': 'Bearer secret' } as NonNullable<RequestInit['headers']>
    await expect(guarded('https://evil.example/x', { headers })).rejects.toBeInstanceOf(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('chat bearer guard', () => {
  function provider(streamSimple: Provider['streamSimple']): Provider {
    return {
      id: 'xai-oauth',
      name: 'x',
      auth: { apiKey: { name: 't', resolve: async () => undefined } },
      getModels: () => [],
      stream: () => createAssistantMessageEventStream(),
      streamSimple,
    }
  }

  it('checks the model base URL and the fetch the SDK will call', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    let guarded: typeof fetch | undefined
    let called = false
    const wrapped = wrapXaiResponsesProvider(provider((_model, _ctx, options) => {
      called = true
      guarded = options?.fetch
      const stream = createAssistantMessageEventStream()
      stream.end()
      return stream
    }), { backendSearch: false, retry401: false })

    const evil = { ...GROK_46_MODEL, baseUrl: 'https://evil.example/v1' }
    expect(() => wrapped.streamSimple(evil, { messages: [] } as never, { fetch: fetchImpl as typeof fetch, apiKey: 'secret' }))
      .toThrow(BearerDestinationError)
    expect(called).toBe(false)

    const stream = wrapped.streamSimple(GROK_46_MODEL, { messages: [] } as never, {
      fetch: fetchImpl as typeof fetch,
      apiKey: 'secret',
    })
    for await (const event of stream) void event
    expect(called).toBe(true)
    expect(guarded).toBeTypeOf('function')
    await expect(guarded!('https://evil.example/steal', {
      headers: { authorization: 'Bearer secret-token' },
    })).rejects.toBeInstanceOf(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()
    await guarded!('https://api.x.ai/v1/responses', {
      headers: { authorization: 'Bearer secret-token' },
      redirect: 'follow',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [, sent] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit]
    expect(sent.redirect).toBe('error')
  })

  it('drives the real pi-ai OpenAI SDK through the guarded fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'stub', type: 'invalid_request_error' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const wrapped = wrapXaiResponsesProvider(xaiProvider(), { backendSearch: false, retry401: false })

    const evil = { ...GROK_46_MODEL, baseUrl: 'https://evil.example/v1' }
    expect(() => wrapped.streamSimple(evil, { messages: [] } as never, {
      fetch: fetchImpl as typeof fetch,
      apiKey: 'oauth-secret',
    })).toThrow(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()

    const stream = wrapped.streamSimple(GROK_46_MODEL, { messages: [] } as never, {
      fetch: fetchImpl as typeof fetch,
      apiKey: 'oauth-secret',
    })
    const events: string[] = []
    for await (const event of stream) events.push(event.type)
    expect(events).toContain('error')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit]
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url)
    expect(target).toBe('https://api.x.ai/v1/responses')
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer oauth-secret')
  })
})

describe('bearer attachment call sites', () => {
  const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../src')
  const GUARD_FILE = 'bearer-guard.ts'

  /**
   * Diagnostic redaction mentions the header name inside a regex. Those files
   * may match `redaction pattern` and nothing else.
   */
  const REDACTION_ALLOWLIST: readonly { file: string; rule: string; justification: string }[] = [
    {
      file: 'redact.ts',
      rule: 'redaction pattern',
      justification: 'Strips a Bearer scheme from OAuth error text before logging. Does not set a request header.',
    },
    {
      file: 'capabilities.ts',
      rule: 'redaction pattern',
      justification: 'Strips authorization fields from diagnostic messages. Does not set a request header.',
    },
  ]

  interface Piece { text: string; value: string }
  interface Finding { rule: string; excerpt: string }
  interface PlusState { pieces: Piece[]; expectOperand: boolean }
  interface Frame { values: string[]; texts: string[]; dirty: boolean }

  const BEARER_VALUE = /^bearer\b/iu
  const AUTH_NAME = /^authorization$/iu
  const BEARER_WORD = /bearer\b/iu
  // Same cases the TypeScript classifier refuses to rescan as a regex.
  const NO_REGEX = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.BigIntLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.ThisKeyword,
    ts.SyntaxKind.PlusPlusToken,
    ts.SyntaxKind.MinusMinusToken,
    ts.SyntaxKind.CloseParenToken,
    ts.SyntaxKind.CloseBracketToken,
    ts.SyntaxKind.CloseBraceToken,
    ts.SyntaxKind.TrueKeyword,
    ts.SyntaxKind.FalseKeyword,
  ])

  function scanBearerAttachment(source: string, variant: ts.LanguageVariant): Finding[] {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, variant, source)
    const findings: Finding[] = []
    const plusStack: PlusState[] = [{ pieces: [], expectOperand: false }]
    const frames: Frame[] = []

    const add = (rule: string, excerpt: string) => {
      findings.push({ rule, excerpt })
    }
    const plus = (): PlusState => plusStack[plusStack.length - 1]!

    const flushPlus = () => {
      const state = plus()
      if (state.pieces.length >= 2) {
        const joined = state.pieces.map(piece => piece.value).join('')
        const excerpt = state.pieces.map(piece => piece.text).join(' + ')
        if (BEARER_WORD.test(joined)) add('concatenated bearer literal', excerpt)
        if (AUTH_NAME.test(joined)) add('concatenated authorization header name', excerpt)
      }
      state.pieces = []
      state.expectOperand = false
    }

    const pushPlus = (piece: Piece) => {
      const state = plus()
      if (state.pieces.length > 0 && !state.expectOperand) flushPlus()
      plus().pieces.push(piece)
      plus().expectOperand = false
    }

    const noteAtom = (text: string, value: string) => {
      if (BEARER_VALUE.test(value)) add('bearer literal', text)
      if (AUTH_NAME.test(value)) add('authorization header name', text)
      pushPlus({ text, value })
    }

    const closeFrame = (text: string, value: string, finish: boolean) => {
      const state = plus()
      const interp = state.pieces.map(piece => piece.value)
      const pending = state.expectOperand
      flushPlus()
      if (plusStack.length > 1) plusStack.pop()
      const frame = frames.pop()
      if (frame === undefined) return
      if (!frame.dirty && !pending) {
        for (const part of interp) frame.values.push(part)
      }
      frame.values.push(value)
      frame.texts.push(text)
      frame.dirty = false
      if (!finish) {
        frames.push(frame)
        plusStack.push({ pieces: [], expectOperand: false })
        return
      }
      const joined = frame.values.join('')
      const excerpt = frame.texts.join('')
      if (BEARER_WORD.test(joined)) add('concatenated bearer literal', excerpt)
      if (AUTH_NAME.test(joined)) add('concatenated authorization header name', excerpt)
      pushPlus({ text: excerpt, value: joined })
    }

    let previous = ts.SyntaxKind.Unknown
    const templateStack: ts.SyntaxKind[] = []
    const retokenize = (kind: ts.SyntaxKind): ts.SyntaxKind => {
      if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) && !NO_REGEX.has(previous)) {
        const rescanned = scanner.reScanSlashToken()
        if (rescanned === ts.SyntaxKind.RegularExpressionLiteral) return rescanned
      }
      if (kind === ts.SyntaxKind.CloseBraceToken && templateStack.length > 0) {
        const top = templateStack[templateStack.length - 1]
        if (top === ts.SyntaxKind.TemplateHead) {
          const rescanned = scanner.reScanTemplateToken(false)
          if (rescanned === ts.SyntaxKind.TemplateTail) templateStack.pop()
          return rescanned
        }
        templateStack.pop()
        return kind
      }
      if (kind === ts.SyntaxKind.TemplateHead) templateStack.push(ts.SyntaxKind.TemplateHead)
      else if (kind === ts.SyntaxKind.OpenBraceToken && templateStack.length > 0) {
        templateStack.push(ts.SyntaxKind.OpenBraceToken)
      }
      return kind
    }

    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      kind = retokenize(kind)
      previous = kind
      const text = scanner.getTokenText()
      if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        noteAtom(text, scanner.getTokenValue())
        continue
      }
      if (kind === ts.SyntaxKind.TemplateHead) {
        const value = scanner.getTokenValue()
        if (BEARER_VALUE.test(value)) add('bearer literal', text)
        if (AUTH_NAME.test(value)) add('authorization header name', text)
        frames.push({ values: [value], texts: [text], dirty: false })
        plusStack.push({ pieces: [], expectOperand: false })
        continue
      }
      if (kind === ts.SyntaxKind.TemplateMiddle || kind === ts.SyntaxKind.TemplateTail) {
        closeFrame(text, scanner.getTokenValue(), kind === ts.SyntaxKind.TemplateTail)
        continue
      }
      if (kind === ts.SyntaxKind.PlusToken && plus().pieces.length > 0) {
        plus().expectOperand = true
        continue
      }
      if (kind === ts.SyntaxKind.OpenParenToken || kind === ts.SyntaxKind.CloseParenToken) continue
      if (kind === ts.SyntaxKind.Identifier && AUTH_NAME.test(text)) {
        add('authorization header name', text)
      }
      if (kind === ts.SyntaxKind.RegularExpressionLiteral
        && (BEARER_WORD.test(text) || /\bauthorization\b/iu.test(text))) {
        add('redaction pattern', text)
      }
      if (frames.length > 0) frames[frames.length - 1]!.dirty = true
      flushPlus()
    }
    flushPlus()
    return findings
  }

  function allowedFinding(rel: string, finding: Finding): boolean {
    return REDACTION_ALLOWLIST.some(entry => entry.file === rel && entry.rule === finding.rule)
  }

  function sourceFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) files.push(...sourceFiles(path))
      else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(path)
    }
    return files
  }

  const BAD_FIXTURES: readonly { name: string; source: string; rule: string }[] = [
    { name: 'scheme assigned before the header', source: `const value = 'Bearer ' + token`, rule: 'bearer literal' },
    { name: 'double quoted scheme', source: `const value = "Bearer " + token`, rule: 'bearer literal' },
    { name: 'template scheme', source: 'const value = `Bearer ${token}`', rule: 'bearer literal' },
    { name: 'header name in a constant', source: `const name = 'authorization'\nheaders[name] = token`, rule: 'authorization header name' },
    { name: 'array-form headers', source: `const headers = [['Authorization', 'Bearer ' + token]]`, rule: 'bearer literal' },
    { name: 'split bearer literal', source: `const value = 'Bear' + 'er ' + token`, rule: 'concatenated bearer literal' },
    { name: 'split template bearer', source: 'const value = `Bea` + `rer ${token}`', rule: 'concatenated bearer literal' },
    { name: 'bearer split inside a template', source: 'const value = `Bear${\'er \'}${token}`', rule: 'concatenated bearer literal' },
    { name: 'split header name', source: `const name = 'author' + 'ization'`, rule: 'concatenated authorization header name' },
    { name: 'headers.set', source: `headers.set('Authorization', token)`, rule: 'authorization header name' },
    { name: 'headers.append', source: `headers.append("authorization", token)`, rule: 'authorization header name' },
    { name: 'property assignment', source: `out.authorization = token`, rule: 'authorization header name' },
    { name: 'bracket assignment', source: `headers['authorization'] = token`, rule: 'authorization header name' },
    { name: 'object key', source: `const headers = { authorization: token }`, rule: 'authorization header name' },
  ]

  const GOOD_FIXTURES = [
    `throw new Error('xAI returned an unsafe authorization URL')`,
    `// 'authorization': 'Bearer secret'\nconst ok = 1`,
    `const note = 'OAuth bearer stays on the allowlist'`,
    `fetchWithBearer(fetchImpl, url, token, { headers: { accept: 'application/json' } })`,
  ]

  it('catches known-bad header constructions', () => {
    const missed: string[] = []
    for (const fixture of BAD_FIXTURES) {
      const rules = scanBearerAttachment(fixture.source, ts.LanguageVariant.Standard).map(finding => finding.rule)
      if (!rules.includes(fixture.rule)) missed.push(`${fixture.name}: got ${rules.join(', ') || 'nothing'}`)
    }
    expect(missed).toEqual([])
  })

  it('ignores prose, comments, and the fetchWithBearer call shape', () => {
    for (const source of GOOD_FIXTURES) {
      expect(scanBearerAttachment(source, ts.LanguageVariant.Standard), source).toEqual([])
    }
  })

  it('keeps the redaction allowlist load-bearing and narrow', () => {
    for (const entry of REDACTION_ALLOWLIST) {
      expect(entry.justification.length).toBeGreaterThan(40)
      const text = readFileSync(join(SRC_ROOT, entry.file), 'utf8')
      const raw = scanBearerAttachment(text, ts.LanguageVariant.Standard)
      expect(raw.some(finding => finding.rule === entry.rule), entry.file).toBe(true)
      const hidden = raw.filter(finding => finding.rule !== entry.rule)
      expect(hidden, entry.file).toEqual([])
      const leaked = `${text}\nconst leaked = 'Bearer ' + token\n`
      const after = scanBearerAttachment(leaked, ts.LanguageVariant.Standard)
        .filter(finding => !allowedFinding(entry.file, finding))
      expect(after.some(finding => finding.rule === 'bearer literal')).toBe(true)
    }
  })

  it('builds an Authorization bearer only inside the destination guard', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file)
      if (rel === GUARD_FILE) continue
      const variant = rel.endsWith('.tsx') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard
      for (const finding of scanBearerAttachment(readFileSync(file, 'utf8'), variant)) {
        if (allowedFinding(rel, finding)) continue
        offenders.push(`${rel}: ${finding.rule}: ${finding.excerpt}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
