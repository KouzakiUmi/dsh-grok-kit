import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessageEventStream, type Provider } from '@earendil-works/pi-ai'
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
})

describe('guardBearerFetch', () => {
  const inner = () => vi.fn(async () => new Response('ok'))

  it('forwards an allowlisted bearer request unchanged', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    const init: RequestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'content-type': 'application/json' },
    }
    await guarded('https://api.x.ai/v1/responses', init)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]).toEqual(['https://api.x.ai/v1/responses', init])
  })

  it('refuses a bearer on a look-alike before fetch runs', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    await expect(guarded('https://grok.com' + EXACT_PATH + '/extra', {
      headers: [['authorization', 'bearer secret-token']],
    })).rejects.toBeInstanceOf(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a Request that already carries the bearer', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    const request = new Request('https://evil.example/steal', {
      headers: { authorization: 'Bearer secret-token' },
    })
    await expect(guarded(request)).rejects.toBeInstanceOf(BearerDestinationError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('forwards token-free requests, including hosts that must not see the bearer', async () => {
    const fetchImpl = inner()
    const guarded = guardBearerFetch(fetchImpl as typeof fetch)
    await guarded('https://vidgen.x.ai/signed.mp4', { headers: { accept: 'video/mp4' } })
    await guarded('https://auth.x.ai/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    await guarded('https://evil.example/other', { headers: { authorization: 'Basic abc' } })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
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
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('bearer attachment call sites', () => {
  const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../src')
  const ATTACHMENT_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
    { name: 'Bearer template', pattern: /Bearer \$\{/u },
    { name: 'authorization bearer literal', pattern: /authorization\s*:\s*[`'"]Bearer\b/iu },
    { name: 'authorization property assignment', pattern: /\.authorization\s*=/u },
    { name: 'authorization bracket assignment', pattern: /\[\s*[`'"]authorization[`'"]\s*\]\s*=/iu },
    { name: 'Headers set/append authorization', pattern: /\.(?:set|append)\(\s*[`'"]authorization[`'"]/iu },
    { name: 'authorization bearer tuple', pattern: /[`'"]authorization[`'"]\s*,\s*[`'"]Bearer\b/iu },
  ]

  function sourceFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) files.push(...sourceFiles(path))
      else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(path)
    }
    return files
  }

  it('builds an Authorization bearer only inside the destination guard', () => {
    const offenders: string[] = []
    let templates = 0
    for (const file of sourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8')
      const rel = relative(SRC_ROOT, file)
      const inGuard = rel === 'bearer-guard.ts'
      for (const { name, pattern } of ATTACHMENT_PATTERNS) {
        const matches = text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))
        if (name === 'Bearer template') templates += matches?.length ?? 0
        if (!inGuard && matches !== null && matches.length > 0) offenders.push(`${rel}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
    expect(templates).toBe(1)
  })
})
