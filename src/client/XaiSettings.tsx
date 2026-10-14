//

// Derived from dsh-xai (https://github.com/MirDie/dsh-xai), Apache-2.0.

// Modified for dsh-grok-kit — see NOTICE for the full attribution.

//

/** Plugin-owned xAI Grok account page inside the dsh Settings shell. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { XaiOAuthSettingsKey } from './locales.ts'
import { CapabilitiesView } from './capabilities-view.tsx'
import { QuotaView } from './quota-view.tsx'
import { mediaTogglePatch } from './media-options.ts'

const STATUS_PATH = '/plugins/dsh-grok-kit/auth/status'
const LOGIN_PATH = '/plugins/dsh-grok-kit/auth/login'
const IMPORT_PATH = '/plugins/dsh-grok-kit/auth/import'
const LOGOUT_PATH = '/plugins/dsh-grok-kit/auth/logout'
const MODELS_PATH = '/plugins/dsh-grok-kit/auth/models'
const PROXY_PATH = '/plugins/dsh-grok-kit/auth/proxy'
const OPTIONS_PATH = '/plugins/dsh-grok-kit/auth/options'
const POLL_INTERVAL_MS = 1_000

type OptionKey =
  | 'backendSearch'
  | 'nestedSearchTools'
  | 'statefulResponses'
  | 'imagineTool'
  | 'editTool'
  | 'videoTool'
  | 'mediaRiskAcknowledged'
  | 'videoModel'
  | 'videoMaxBytes'
  | 'searchModel'
  | 'searchMaxResults'
  | 'webSearchTimeoutMs'
  | 'xSearchTimeoutMs'

type OptionValue = boolean | number | string | undefined

/**
 * The five pages of this settings section. Only the active page is mounted, so
 * a backgrounded page never keeps a video download or a capability read
 * running; every draft it owns lives in this component instead of in the page
 * body, so switching pages keeps unsaved options and proxy edits.
 */
const SETTINGS_PAGES = ['account', 'models', 'search', 'media', 'network'] as const

type SettingsPageId = (typeof SETTINGS_PAGES)[number]

/** Page label, doubled as the sticky header's navigation button text. */
const PAGE_LABEL_KEYS: Record<SettingsPageId, XaiOAuthSettingsKey> = {
  account: 'navAccount',
  models: 'navModels',
  search: 'navSearch',
  media: 'navMedia',
  network: 'navNetwork',
}

/**
 * Which option keys each page owns for ordinary edits. Save is scoped to the
 * active page's dirty keys from this list, so one page can never write another
 * page's overrides and a draft left unsaved elsewhere is never dropped by
 * this page's save.
 */
const PAGE_OPTION_KEYS: Record<SettingsPageId, readonly OptionKey[]> = {
  account: [],
  models: [],
  network: [],
  search: ['backendSearch', 'statefulResponses', 'nestedSearchTools', 'searchModel', 'searchMaxResults', 'webSearchTimeoutMs', 'xSearchTimeoutMs'],
  media: ['imagineTool', 'editTool', 'videoTool', 'mediaRiskAcknowledged'],
}

/**
 * Extra keys Reset may clear even though the form does not edit them.
 * Media still displays videoModel / videoMaxBytes as read-only; a stale
 * stored videoMaxBytes would keep interrupting downloads after the user
 * believes this page was reset.
 */
const PAGE_RESET_ONLY_KEYS: Partial<Record<SettingsPageId, readonly OptionKey[]>> = {
  media: ['videoModel', 'videoMaxBytes'],
}

function pageResetKeys(pageId: SettingsPageId): readonly OptionKey[] {
  return [...PAGE_OPTION_KEYS[pageId], ...(PAGE_RESET_ONLY_KEYS[pageId] ?? [])]
}

function optBool(value: OptionValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

type CatalogSource = 'live' | 'cache' | 'fallback'

type AccountStatus =
  | { status: 'loading' }
  | { status: 'signed-out'; grokImportAvailable?: boolean; sharedGrokAuth?: boolean }
  | { status: 'signing-in'; url?: string; userCode?: string; grokImportAvailable?: boolean; sharedGrokAuth?: boolean }
  | {
    status: 'signed-in'
    models?: string[]
    available?: string[]
    selected?: string[]
    catalogSource?: CatalogSource
    catalogError?: string
    loginError?: string
    grokImportAvailable?: boolean
    sharedGrokAuth?: boolean
  }
  | { status: 'error'; message: string; grokImportAvailable?: boolean; sharedGrokAuth?: boolean }

interface LoginChallenge {
  url: string
  userCode?: string
}

export interface XaiOAuthSettingsInjected {
  t: (key: XaiOAuthSettingsKey, params?: Record<string, unknown>) => string
}

export type XaiOAuthSettingsProps = Partial<XaiOAuthSettingsInjected>

/* ---- theme-aware styles (dsh `--dsw-alias-*` tokens; no external assets) ---- */

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720 }
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14 }
const logoStyle: CSSProperties = {
  flex: '0 0 auto',
  width: 40,
  height: 40,
  borderRadius: 12,
  display: 'grid',
  placeItems: 'center',
  background: 'linear-gradient(135deg, var(--dsw-alias-brand-primary, #1677ff), #4f6bed)',
  color: 'white',
  fontSize: 22,
  fontWeight: 700,
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  lineHeight: 1,
}
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const cardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
// brand-primary flips with the theme (dark theme: near-white fill), so the
// label uses the matching foreground token instead of a hardcoded white.
const primaryButtonStyle: CSSProperties = { ...buttonStyle, borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-foreground, white)' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const mediaConfirmStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-state-error-primary)',
  borderRadius: 6,
  padding: '8px 10px',
  margin: '6px 0',
}
const experimentalTagStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: '18px',
  padding: '0 6px',
  borderRadius: 4,
  border: '1px solid currentColor',
  color: 'var(--dsw-alias-label-secondary, inherit)',
}
const codeBoxStyle: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: '10px 14px', border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)' }
const codeStyle: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 20, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const linkStyle: CSSProperties = { color: 'var(--dsw-alias-brand-primary)', wordBreak: 'break-all' }
const listStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none' }
const modelRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 8, color: 'var(--dsw-alias-label-primary)' }
const modelNameStyle: CSSProperties = { fontSize: 14, fontWeight: 500 }
const modelIdStyle: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #81858c)' }
const optionRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--dsw-alias-label-primary)', flexWrap: 'wrap' }
const optionHintStyle: CSSProperties = { ...bodyStyle, fontSize: 12, margin: 0, color: 'var(--dsw-alias-label-tertiary, #81858c)' }
const optionInputStyle: CSSProperties = {
  flex: '1 1 200px',
  minHeight: 30,
  padding: '4px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
}
const badgeStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' }
const sourceBadgeStyle: CSSProperties = { ...badgeStyle, fontWeight: 600 }
/* Sticky header: match the host Modal surface so its background blends into
   the settings panel. Keep it opaque and above the cards so scrolling content
   cannot show through the shared title, account status or navigation. */
const stickyBarStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '12px 0 14px',
  background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base))',
}
const commonStatusStyle: CSSProperties = { ...statusStyle, fontSize: 13, flexWrap: 'wrap' }
const tabBarStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }
const tabStyle: CSSProperties = { ...buttonStyle, minHeight: 30, padding: '4px 12px', fontSize: 13 }
const activeTabStyle: CSSProperties = {
  ...buttonStyle,
  minHeight: 30,
  padding: '4px 12px',
  fontSize: 13,
  borderColor: 'var(--dsw-alias-brand-primary)',
  background: 'var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary-foreground, white)',
  fontWeight: 600,
}
const pageStyleInner: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18 }

function sourceBadge(source: CatalogSource | undefined): { text: string; color: string } {
  switch (source) {
    case 'live': return { text: 'Live', color: 'var(--dsw-alias-state-success-primary, #22a06b)' }
    case 'cache': return { text: 'Cached', color: 'var(--dsw-alias-brand-primary, #4f6bed)' }
    case 'fallback': return { text: 'Fallback', color: 'var(--dsw-alias-label-tertiary, #81858c)' }
    default: return { text: '—', color: 'var(--dsw-alias-label-tertiary, #81858c)' }
  }
}

function dotStyle(status: AccountStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : status === 'signing-in' || status === 'loading'
        ? 'var(--dsw-alias-brand-primary, #1677ff)'
        : 'var(--dsw-alias-label-tertiary, #81858c)'
  return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
}

/** grok-4.6 → "Grok 4.6"; only used for display, never sent to the API. */
function displayName(id: string): string {
  return id
    .split(/[-_]/g)
    .map(part => part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1))
    .join(' ')
}

async function jsonRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    credentials: 'same-origin',
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as T
}

/** xAI Grok account status and OAuth actions. */
export function XaiSettings({ t }: XaiOAuthSettingsProps) {
  if (t === undefined) throw new Error('xAI Grok settings requires its translation function')
  const [status, setStatus] = useState<AccountStatus>({ status: 'loading' })
  // Account mutations invalidate older status reads, including login polling.
  const statusRequestRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const [proxyUrl, setProxyUrl] = useState('')
  const [savedProxyUrl, setSavedProxyUrl] = useState('')
  const proxyEditedRef = useRef(false)
  const proxySavedRef = useRef(false)
  const [proxyBusy, setProxyBusy] = useState(false)
  const [proxyFeedback, setProxyFeedback] = useState<'idle' | 'saved' | 'error'>('idle')
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [options, setOptions] = useState<Partial<Record<OptionKey, OptionValue>>>({})
  const [storedOptions, setStoredOptions] = useState<Partial<Record<OptionKey, OptionValue>>>({})
  const [optionsDirty, setOptionsDirty] = useState<ReadonlySet<OptionKey>>(new Set())
  // Mirror of the dirty set: the initial load lands asynchronously and must not
  // overwrite a field the user already edited while it was in flight.
  const optionsDirtyRef = useRef<ReadonlySet<OptionKey>>(new Set())
  // Keep touched keys after saving/resetting as well: a late initial GET must
  // not roll a committed value back to the snapshot from before that write.
  const optionsTouchedRef = useRef<ReadonlySet<OptionKey>>(new Set())
  const [optionsBusy, setOptionsBusy] = useState(false)
  // Feedback is bound to the page whose request produced it: a late 'saved'
  // from the media page can never be shown on the search page while that
  // page is still dirty.
  // A missing `page` means the failure belongs to the initial load, not to one
  // page's save, so both option pages may show it.
  const [optionsFeedback, setOptionsFeedback] = useState<{ page?: SettingsPageId; state: 'saved' | 'error' } | undefined>()
  // An off→on media toggle parks here for the inline risk confirmation; the
  // switch does not move until the user confirms inside the card.
  const [pendingMediaGroup, setPendingMediaGroup] = useState<'images' | 'video' | null>(null)
  // Bumped by every account-changing action (sign-in, Grok import, sign-out).
  // Together with the account status it keys <CapabilitiesView/> so the panel
  // remounts: fresh fetches, aborted in-flight work, revoked blob URLs, and no
  // task rows or diagnostics carried over from the previous account — even an
  // A→B import that stays "signed-in" gets a new key.
  const [accountGeneration, setAccountGeneration] = useState(0)
  // Active page. Only the active page body is mounted; every draft it owns
  // still lives here, so switching pages never discards an unsaved edit.
  const [page, setPage] = useState<SettingsPageId>('account')
  // A saved video choice/revocation also invalidates the local runtime
  // capability snapshot, without probing upstream or reloading the account.
  const [capabilityGeneration, setCapabilityGeneration] = useState(0)

  type OptionsPayload = {
    options?: Partial<Record<OptionKey, OptionValue>>
    effective?: Partial<Record<OptionKey, OptionValue>>
    stored?: Partial<Record<OptionKey, OptionValue>>
  }

  /**
   * Apply a server payload.
   *
   * The initial load replaces untouched fields. A page-scoped save or reset passes
   * `clearedKeys` and then moves ONLY those keys: another page's unsaved draft
   * is never overwritten by a response that did not cover it, its dirty flag
   * survives, and a key the server no longer reports as an override is dropped
   * from the stored view so the form falls back to auto / default.
   */
  const applyOptionsPayload = (value: OptionsPayload, clearedKeys?: readonly OptionKey[]): void => {
    const effective = value.effective ?? value.options ?? {}
    const stored = value.stored ?? {}
    if (clearedKeys === undefined) {
      const drafts = optionsDirtyRef.current
      const protectedKeys = optionsTouchedRef.current
      setOptions(previous => {
        const next = { ...effective }
        for (const key of protectedKeys) {
          if (key in previous) next[key] = previous[key]
          else delete next[key]
        }
        return next
      })
      setStoredOptions(previous => {
        const next = { ...stored }
        for (const key of protectedKeys) {
          if (key in previous) next[key] = previous[key]
          else delete next[key]
        }
        return next
      })
      setOptionsDirty(new Set(drafts))
      return
    }
    optionsTouchedRef.current = new Set([...optionsTouchedRef.current, ...clearedKeys])
    setOptions(previous => {
      const next = { ...previous }
      for (const key of clearedKeys) {
        if (key in effective) next[key] = effective[key]
        else delete next[key]
      }
      return next
    })
    setStoredOptions(previous => {
      const next = { ...previous }
      for (const key of clearedKeys) {
        if (key in stored) next[key] = stored[key]
        else delete next[key]
      }
      return next
    })
    setOptionsDirty(previous => {
      const next = new Set(previous)
      for (const key of clearedKeys) next.delete(key)
      return next
    })
  }

  const markOption = (key: OptionKey, value: OptionValue): void => {
    setOptions(previous => ({ ...previous, [key]: value }))
    setOptionsDirty(previous => new Set(previous).add(key))
    optionsDirtyRef.current = new Set(optionsDirtyRef.current).add(key)
    optionsTouchedRef.current = new Set(optionsTouchedRef.current).add(key)
    const owner = SETTINGS_PAGES.find(pageId => PAGE_OPTION_KEYS[pageId].includes(key))
    setOptionsFeedback(previous => previous?.page === owner ? undefined : previous)
  }

  /**
   * Numeric option edit. An empty field is an explicit "clear my override".
   * Anything else that is not a finite number ('1e999', a pasted non-number)
   * is rejected outright: JSON.stringify(NaN) is `null`, so writing it would
   * silently delete the stored override instead of applying what was typed.
   */
  const markOptionNumber = (key: OptionKey, raw: string): void => {
    if (raw.trim() === '') {
      markOption(key, undefined)
      return
    }
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    markOption(key, value)
  }

  const pageHasDraft = (pageId: SettingsPageId): boolean =>
    pageId === 'network' ? proxyUrl.trim() !== savedProxyUrl
      : PAGE_OPTION_KEYS[pageId].some(key => optionsDirty.has(key))

  /** Feedback visible on one page: its own, or a page-independent load error. */
  const feedbackFor = (pageId: SettingsPageId): 'saved' | 'error' | undefined =>
    optionsFeedback === undefined
      ? undefined
      : optionsFeedback.page === undefined || optionsFeedback.page === pageId ? optionsFeedback.state : undefined
  const applyMediaPatch = (patch: Record<string, boolean>): void => {
    for (const [key, value] of Object.entries(patch)) markOption(key as OptionKey, value)
  }

  const markMedia = (group: 'images' | 'video', enabled: boolean): void => {
    if (enabled) {
      // Park the toggle: the switch stays off until the inline confirmation
      // below the media rows is accepted.
      setPendingMediaGroup(group)
      setOptionsFeedback(previous => previous?.page === 'media' ? undefined : previous)
      return
    }
    const patch = mediaTogglePatch(options, group, false)
    if (patch === undefined) return
    applyMediaPatch(patch)
  }

  const confirmPendingMedia = (): void => {
    if (pendingMediaGroup === null) return
    const patch = mediaTogglePatch(options, pendingMediaGroup, true)
    setPendingMediaGroup(null)
    if (patch === undefined) return
    applyMediaPatch(patch)
  }

  const cancelPendingMedia = (): void => {
    setPendingMediaGroup(null)
    setOptionsFeedback(previous => previous?.page === 'media' ? undefined : previous)
  }

  const loadOptions = useCallback(async () => {
    try {
      applyOptionsPayload(await jsonRequest<OptionsPayload>(OPTIONS_PATH))
    } catch {
      setOptionsFeedback({ state: 'error' })
    }
  }, [])

  /** Save only the active page's dirty keys; every other page keeps its draft. */
  const saveOptions = async (pageId: SettingsPageId): Promise<void> => {
    const keys = PAGE_OPTION_KEYS[pageId].filter(key => optionsDirty.has(key))
    if (keys.length === 0) return
    setOptionsBusy(true)
    try {
      const patch: Record<string, unknown> = {}
      for (const key of keys) patch[key] = options[key] ?? null
      applyOptionsPayload(await jsonRequest<OptionsPayload>(OPTIONS_PATH, 'POST', patch), keys)
      const remaining = new Set(optionsDirtyRef.current)
      for (const key of keys) remaining.delete(key)
      optionsDirtyRef.current = remaining
      setOptionsFeedback({ page: pageId, state: 'saved' })
      if (keys.includes('videoTool') || keys.includes('mediaRiskAcknowledged')) setCapabilityGeneration(generation => generation + 1)
    } catch {
      setOptionsFeedback({ page: pageId, state: 'error' })
    } finally {
      setOptionsBusy(false)
    }
  }

  /** Reset only the active page's overrides back to the defaults. */
  const resetOptions = async (pageId: SettingsPageId): Promise<void> => {
    const keys = pageResetKeys(pageId)
    if (keys.length === 0) return
    setOptionsBusy(true)
    try {
      const patch: Record<string, unknown> = {}
      for (const key of keys) patch[key] = null
      if (pageId === 'media') {
        patch.mediaRiskAcknowledged = false
        setPendingMediaGroup(null)
      }
      applyOptionsPayload(await jsonRequest<OptionsPayload>(OPTIONS_PATH, 'POST', patch), keys)
      const remaining = new Set(optionsDirtyRef.current)
      for (const key of keys) remaining.delete(key)
      optionsDirtyRef.current = remaining
      setOptionsFeedback({ page: pageId, state: 'saved' })
      if (pageId === 'media') setCapabilityGeneration(generation => generation + 1)
    } catch {
      setOptionsFeedback({ page: pageId, state: 'error' })
    } finally {
      setOptionsBusy(false)
    }
  }

  const loadProxy = useCallback(async () => {
    try {
      const value = await jsonRequest<{ proxyUrl: string }>(PROXY_PATH)
      // Still learn the baseline after an edit, but never replace a newer save.
      if (!proxySavedRef.current) setSavedProxyUrl(value.proxyUrl ?? '')
      if (!proxyEditedRef.current) setProxyUrl(value.proxyUrl ?? '')
    } catch {
      setProxyFeedback('error')
    }
  }, [])

  const saveProxy = async (): Promise<void> => {
    setProxyBusy(true)
    try {
      const value = await jsonRequest<{ proxyUrl: string }>(PROXY_PATH, 'POST', { proxyUrl })
      proxyEditedRef.current = true
      proxySavedRef.current = true
      setProxyUrl(value.proxyUrl ?? '')
      setSavedProxyUrl(value.proxyUrl ?? '')
      setProxyFeedback('saved')
    } catch {
      setProxyFeedback('error')
    } finally {
      setProxyBusy(false)
    }
  }

  const refresh = useCallback(async () => {
    const request = ++statusRequestRef.current
    try {
      const value = await jsonRequest<AccountStatus>(STATUS_PATH)
      if (request === statusRequestRef.current) setStatus(value)
    } catch (error: unknown) {
      if (request === statusRequestRef.current) {
        setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
      }
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { void loadProxy() }, [loadProxy])
  useEffect(() => { void loadOptions() }, [loadOptions])
  useEffect(() => {
    if (status.status !== 'signing-in') return
    const timer = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [refresh, status.status])

  const signIn = async (): Promise<void> => {
    // The device-code flow is one-shot: re-entering clears the challenge and
    // can hide the user code the user must enter.
    if (status.status === 'signing-in') return
    if (status.status !== 'loading' && status.sharedGrokAuth === true) {
      if (!window.confirm(t('confirmLoginShared'))) return
    } else if (status.status === 'signed-in') {
      if (!window.confirm(t('confirmLoginPrivate'))) return
    }
    // Only once the user actually committed to a sign-in.
    ++statusRequestRef.current
    setAccountGeneration(generation => generation + 1)
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    setPopupBlocked(popup === null)
    setBusy(true)
    setStatus({ status: 'signing-in' })
    try {
      const challenge = await jsonRequest<LoginChallenge>(LOGIN_PATH, 'POST')
      if (popup === null) {
        setStatus({ status: 'signing-in', url: challenge.url, ...challenge.userCode === undefined ? {} : { userCode: challenge.userCode } })
        return
      }
      popup.location.replace(challenge.url)
      setStatus({ status: 'signing-in', url: challenge.url, ...challenge.userCode === undefined ? {} : { userCode: challenge.userCode } })
    } catch (error: unknown) {
      popup?.close()
      // The server-side login may still be running; keep polling state instead
      // of dropping to error (which stops the poller). Preserve any challenge
      // we already received.
      setStatus(previous => previous.status === 'signing-in'
        ? previous
        : { status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    } finally {
      setBusy(false)
    }
  }

  const importGrok = async (): Promise<void> => {
    // Hide old account data during import and remount again after it commits.
    // A pre-request bump alone could mount a panel that fetches the old account.
    ++statusRequestRef.current
    setAccountGeneration(generation => generation + 1)
    setStatus({ status: 'loading' })
    setBusy(true)
    try {
      const imported = await jsonRequest<AccountStatus>(IMPORT_PATH, 'POST')
      ++statusRequestRef.current
      setAccountGeneration(generation => generation + 1)
      setStatus(imported)
    } catch (error: unknown) {
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    } finally {
      setBusy(false)
    }
  }

  const saveModels = async (selected: string[]): Promise<void> => {
    ++statusRequestRef.current
    setBusy(true)
    try {
      setStatus(await jsonRequest<AccountStatus>(MODELS_PATH, 'POST', { selected }))
    } catch (error: unknown) {
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    if (status.status === 'signed-in' && status.sharedGrokAuth === true) {
      if (!window.confirm(t('confirmLogoutShared'))) return
    }
    // Hide the outgoing account BEFORE the bump remounts the quota, capability
    // and task panels: while the sign-out is still in flight they would
    // otherwise re-read the account that is on its way out.
    setStatus({ status: 'loading' })
    ++statusRequestRef.current
    setAccountGeneration(generation => generation + 1)
    setBusy(true)
    try {
      // The route returns the full signed-out status (incl. grokImportAvailable),
      // so the Grok CLI import button stays available right after sign-out.
      setStatus(await jsonRequest<AccountStatus>(LOGOUT_PATH, 'POST'))
    } catch {
      // Sign-out failed, so the account is unchanged: re-read its real status
      // instead of guessing, which also surfaces a transport error.
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const shared = status.status !== 'loading' && status.sharedGrokAuth === true
  const label = status.status === 'signed-in'
    ? t(shared ? 'signedInShared' : 'signedIn')
    : status.status === 'loading'
      ? t('loadingAccount')
      : status.status === 'signing-in'
        ? t('signingIn')
        : status.status === 'error'
          ? t('requestFailed')
          : t(shared ? 'signedOutShared' : 'signedOut')

  const modelIds = status.status === 'signed-in' ? status.available ?? status.models ?? [] : []
  const selectedIds = status.status === 'signed-in' ? status.selected ?? status.models ?? [] : []
  const source = status.status === 'signed-in' ? sourceBadge(status.catalogSource) : null

  /** Remount key: every account-changing action drops the previous account's
   *  quota reading, capability record and task rows. */
  const accountKey = `${status.status}:${String(accountGeneration)}`

  /** Save / reset row: always names the page whose own options it acts on. */
  const optionActions = (pageId: SettingsPageId) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {pageHasDraft(pageId) ? <p role="status" style={{ ...bodyStyle, margin: 0, width: '100%' }}>{t('unsavedChangesHint')}</p> : null}
      <button type="button" style={buttonStyle} disabled={optionsBusy || !pageHasDraft(pageId)} onClick={() => { void saveOptions(pageId) }}>
        {optionsBusy ? t('working') : `${t('optionsSave')} · ${t(PAGE_LABEL_KEYS[pageId])}`}
      </button>
      <button type="button" style={buttonStyle} disabled={optionsBusy} onClick={() => { void resetOptions(pageId) }}>
        {`${t('optionsReset')} · ${t(PAGE_LABEL_KEYS[pageId])}`}
      </button>
      {feedbackFor(pageId) === 'saved'
        ? <p role="status" style={{ ...bodyStyle, margin: 0, color: 'var(--dsw-alias-state-success-primary, #22a06b)' }}>{t('optionsSaved')}</p>
        : null}
      {feedbackFor(pageId) === 'error'
        ? <p role="alert" style={{ ...errorStyle, margin: 0 }}>{t('optionsError')}</p>
        : null}
    </div>
  )

  return (
    <section style={pageStyle} aria-labelledby="xai-oauth-settings-title">
      {/* Sticky header: the shared title, the account status every page shows
          and the five-page navigation. Plain buttons with aria-current — the
          host settings dialog owns its own focus handling. */}
      <div style={stickyBarStyle}>
        <header style={headerStyle}>
          <div style={logoStyle} aria-hidden="true">ɡ</div>
          <div style={{ minWidth: 0 }}>
            <h2 id="xai-oauth-settings-title" style={titleStyle}>{t('title')}</h2>
            <p style={{ ...bodyStyle, marginTop: 4 }}>{t('intro')}</p>
          </div>
        </header>
        <div style={commonStatusStyle} role="status">
          <span aria-hidden="true" style={dotStyle(status.status)} />
          <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{t('statusLabel')}</span>
          <span>{label}</span>
        </div>
        <nav aria-label={t('nav')} style={tabBarStyle}>
          {SETTINGS_PAGES.map(id => (
            <button
              key={id}
              type="button"
              style={page === id ? activeTabStyle : tabStyle}
              aria-current={page === id ? 'page' : undefined}
              aria-label={pageHasDraft(id) ? `${t(PAGE_LABEL_KEYS[id])} — ${t('unsavedChanges')}` : t(PAGE_LABEL_KEYS[id])}
              title={pageHasDraft(id) ? t('unsavedChangesHint') : undefined}
              onClick={() => { setPage(id) }}
            >
              {pageHasDraft(id)
                ? <>{t(PAGE_LABEL_KEYS[id])}<span aria-hidden="true"> •</span></>
                : t(PAGE_LABEL_KEYS[id])}
            </button>
          ))}
        </nav>
      </div>

      {/* Account page: the shared quota reading and the auth actions. */}
      {page === 'account'
        ? (
            <div style={pageStyleInner}>
              <QuotaView key={accountKey} t={t} signedIn={status.status === 'signed-in'} accountLoading={status.status === 'loading' || status.status === 'signing-in'} />
              <div style={cardStyle}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {status.status === 'loading'
                    ? null
                    : status.status === 'signed-in'
                      ? <>
                          <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void signIn() }}>{busy ? t('working') : t('loginAgain')}</button>
                          <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void signOut() }}>{busy ? t('working') : t(shared ? 'logoutShared' : 'logout')}</button>
                        </>
                      : (
                          <>
                            <button type="button" style={primaryButtonStyle} disabled={busy || status.status === 'signing-in'} onClick={() => { void signIn() }}>{busy ? t('working') : status.status === 'error' ? t('loginAgain') : t(shared ? 'loginShared' : 'login')}</button>
                            {status.grokImportAvailable === true
                              ? <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void importGrok() }}>{t('importGrok')}</button>
                              : null}
                          </>
                        )}
                </div>

                <p style={bodyStyle}>{t('subscriptionLoginHint')}</p>
                <a href="https://grok.com/dashboard" target="_blank" rel="noreferrer" style={linkStyle}>{t('subscriptionDashboard')}</a>

                {/* dsh 0.1.2 repurposed --dsw-alias-label-dimmed to a near-invisible
                    tint (light: neutral-bluish-200) and removed state-info-primary;
                    the disclaimer is legally required text, so it keeps a readable
                    secondary color, and hints follow the host's tertiary convention. */}
                <p style={{ ...bodyStyle, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #61666b)' }}>{t('unofficialNotice')}</p>

                {status.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
                {status.status === 'signed-in' && status.loginError !== undefined
                  ? <p role="status" style={errorStyle}>{t('loginFailedStoredAccount')}{' '}{status.loginError}</p>
                  : null}
                {status.status !== 'loading' && status.sharedGrokAuth === true
                  ? <p style={bodyStyle}>{t('sharedGrok')}</p>
                  : null}
                {status.status !== 'signed-in' && status.status !== 'loading' && status.grokImportAvailable === true
                  ? <p style={bodyStyle}>{t('importHint')}</p>
                  : null}

                {status.status === 'signing-in' && status.userCode !== undefined
                  ? (
                      <div style={codeBoxStyle}>
                        <span style={bodyStyle}>{t('userCode')}</span>
                        <span style={codeStyle}>{status.userCode}</span>
                      </div>
                    )
                  : null}
                {status.status === 'signing-in' && status.url !== undefined
                  ? (
                      <p style={bodyStyle}>
                        {t(popupBlocked ? 'popupBlocked' : 'openUrl')}
                        {' '}
                        <a href={status.url} target="_blank" rel="noreferrer" style={linkStyle}>{status.url}</a>
                      </p>
                    )
                  : null}
              </div>
            </div>
          )
        : null}

      {/* Models page */}
      {page === 'models'
        ? (
            <div style={pageStyleInner}>
              {status.status === 'signed-in'
                ? (
                    <div style={cardStyle}>
                      <div style={rowStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <h3 style={{ ...titleStyle, fontSize: 14 }}>{t('models')}</h3>
                          <span style={badgeStyle}>{String(modelIds.length)}</span>
                          {source === null ? null : <span style={{ ...sourceBadgeStyle, color: source.color }}>{source.text}</span>}
                        </div>
                        <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void saveModels([]) }}>{t('selectAll')}</button>
                      </div>
                      <p style={bodyStyle}>
                        {status.catalogSource === 'live' ? t('catalogLive')
                          : status.catalogSource === 'cache' ? t('catalogCache')
                            : t('catalogFallback')}
                      </p>
                      <p style={bodyStyle}>{t('modelHint')}</p>
                      <ul style={listStyle}>
                        {modelIds.map(id => {
                          const checked = selectedIds.includes(id)
                          return (
                            <li key={id}>
                              <label style={modelRowStyle}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={busy}
                                  onChange={() => {
                                    const current = new Set(selectedIds)
                                    if (checked) current.delete(id)
                                    else current.add(id)
                                    void saveModels([...current])
                                  }}
                                />
                                <span style={modelNameStyle}>{displayName(id)}</span>
                                <span style={modelIdStyle}>{id}</span>
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                      {status.catalogError === undefined ? null : <p style={errorStyle}>{t('catalogError')}</p>}
                    </div>
                  )
                : null}
            </div>
          )
        : null}

      {/* Search page: the search switches, the stateful-conversation switch and
          the nested-search parameters. */}
      {page === 'search'
        ? (
            <div style={pageStyleInner}>
              <div style={cardStyle}>
                <h3 style={{ ...titleStyle, fontSize: 14 }}>{t('navSearch')}</h3>
                <p style={bodyStyle}>{t('optionsHint')}</p>
                <label style={optionRowStyle}>
                  <input
                    type="checkbox"
                    checked={optBool(options.backendSearch, false)}
                    disabled={optionsBusy}
                    onChange={(event) => markOption('backendSearch', event.target.checked)}
                  />
                  <span>{t('backendSearch')}</span>
                </label>
                <span style={experimentalTagStyle}>{t('experimentalTag')}</span>
                <p style={optionHintStyle}>{t('backendSearchHint')}</p>

                <label style={optionRowStyle}>
                  <input
                    type="checkbox"
                    checked={optBool(options.statefulResponses, false)}
                    disabled={optionsBusy}
                    onChange={(event) => markOption('statefulResponses', event.target.checked)}
                  />
                  <span>{t('statefulResponses')}</span>
                </label>
                <span style={experimentalTagStyle}>{t('experimentalTag')}</span>
                <p style={optionHintStyle}>{t('statefulResponsesHint')}</p>

                <label style={optionRowStyle}>
                  <span>{t('nestedSearchTools')}</span>
                  <select
                    value={
                      optionsDirty.has('nestedSearchTools')
                        ? options.nestedSearchTools === undefined ? 'auto' : String(options.nestedSearchTools)
                        : storedOptions.nestedSearchTools === undefined ? 'auto' : String(storedOptions.nestedSearchTools)
                    }
                    disabled={optionsBusy}
                    onChange={(event) => markOption(
                      'nestedSearchTools',
                      event.target.value === 'auto' ? undefined : event.target.value === 'true',
                    )}
                    style={{ ...optionInputStyle, flex: '0 1 auto' }}
                  >
                    <option value="auto">{t('nestedSearchToolsAuto')}</option>
                    <option value="true">on</option>
                    <option value="false">off</option>
                  </select>
                </label>
                <p style={optionHintStyle}>{t('nestedSearchToolsHint')}</p>

                <label style={optionRowStyle}>
                  <span>{t('searchModel')}</span>
                  <input
                    type="text"
                    value={String(options.searchModel ?? '')}
                    placeholder="grok-build-0.1"
                    disabled={optionsBusy}
                    onChange={(event) => markOption('searchModel', event.target.value.trim() === '' ? undefined : event.target.value)}
                    style={optionInputStyle}
                  />
                </label>
                <p style={optionHintStyle}>{t('searchModelHint')}</p>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                  <label style={optionRowStyle}>
                    <span>{t('searchMaxResults')}</span>
                    <input
                      type="number"
                      min={1}
                      value={String(options.searchMaxResults ?? '')}
                      placeholder="8"
                      disabled={optionsBusy}
                      onChange={(event) => markOptionNumber('searchMaxResults', event.target.value)}
                      style={optionInputStyle}
                    />
                  </label>
                  <label style={optionRowStyle}>
                    <span>{t('webSearchTimeoutMs')}</span>
                    <input
                      type="number"
                      min={1000}
                      value={String(options.webSearchTimeoutMs ?? '')}
                      placeholder="60000"
                      disabled={optionsBusy}
                      onChange={(event) => markOptionNumber('webSearchTimeoutMs', event.target.value)}
                      style={optionInputStyle}
                    />
                  </label>
                  <label style={optionRowStyle}>
                    <span>{t('xSearchTimeoutMs')}</span>
                    <input
                      type="number"
                      min={1000}
                      value={String(options.xSearchTimeoutMs ?? '')}
                      placeholder="120000"
                      disabled={optionsBusy}
                      onChange={(event) => markOptionNumber('xSearchTimeoutMs', event.target.value)}
                      style={optionInputStyle}
                    />
                  </label>
                </div>
                <p style={optionHintStyle}>{t('searchMaxResultsHint')} · {t('webSearchTimeoutHint')} · {t('xSearchTimeoutHint')}</p>
                {optionActions('search')}
              </div>
            </div>
          )
        : null}

      {/* Media page: the image / video switches, the capability record and the
          local task list. Mounted only while this page is active, so leaving it
          aborts its in-flight reads and revokes its blob URLs. */}
      {page === 'media'
        ? (
            <div style={pageStyleInner}>
              <div style={cardStyle}>
                <h3 style={{ ...titleStyle, fontSize: 14 }}>{t('navMedia')}</h3>
                <p style={bodyStyle}>{t('optionsHint')}</p>
                <p style={bodyStyle}>{t('mediaRiskHint')}</p>
                <label style={optionRowStyle}>
                  <input
                    type="checkbox"
                    checked={optBool(options.imagineTool, false) || optBool(options.editTool, false)}
                    disabled={optionsBusy}
                    onChange={(event) => markMedia('images', event.target.checked)}
                  />
                  <span>{t('imagineTool')}</span>
                </label>
                <span style={experimentalTagStyle}>{t('experimentalTag')}</span>
                <p style={optionHintStyle}>{t('imagineToolHint')}</p>
                <p style={optionHintStyle}>{`${t('imageGenerationSwitch')}: ${t(optBool(options.imagineTool, false) ? 'mediaOn' : 'mediaOff')} · ${t('imageEditingSwitch')}: ${t(optBool(options.editTool, false) ? 'mediaOn' : 'mediaOff')}`}</p>

                <label style={optionRowStyle}>
                  <input
                    type="checkbox"
                    checked={optBool(options.videoTool, false)}
                    disabled={optionsBusy}
                    onChange={(event) => markMedia('video', event.target.checked)}
                  />
                  <span>{t('videoTool')}</span>
                </label>
                <span style={experimentalTagStyle}>{t('experimentalTag')}</span>
                <p style={optionHintStyle}>{t('videoToolHint')}</p>
                {/* Read-only presentation of the remaining video parameters: the first
                    version edits videoTool only, so these stay informational. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                  <span style={optionRowStyle}>{`${t('videoModelLabel')}: ${String(options.videoModel ?? '—')}`}</span>
                  <span style={optionRowStyle}>{`${t('videoMaxBytesLabel')}: ${String(options.videoMaxBytes ?? '—')}`}</span>
                </div>
                {pendingMediaGroup !== null ? (
                  <div style={mediaConfirmStyle}>
                    <p style={{ ...errorStyle, margin: '0 0 4px', fontWeight: 600 }}>{pendingMediaGroup === 'images' ? t('imagineTool') : t('videoTool')}</p>
                    <p style={{ ...errorStyle, margin: '0 0 6px' }}>{t('mediaConfirmPrompt')}</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" style={primaryButtonStyle} disabled={optionsBusy} onClick={confirmPendingMedia}>{t('mediaConfirmYes')}</button>
                      <button type="button" style={buttonStyle} disabled={optionsBusy} onClick={cancelPendingMedia}>{t('mediaConfirmNo')}</button>
                    </div>
                  </div>
                ) : null}
                {optionActions('media')}
              </div>

              {/* Capability status + local video task list (frozen plugin routes).
                  The key remounts the panel on every account change, so a previous
                  account's tasks/diagnostics and blob URLs never survive a switch. */}
              <CapabilitiesView key={`${accountKey}:${String(capabilityGeneration)}`} t={t} signedIn={status.status === 'signed-in'} />
            </div>
          )
        : null}

      {/* Network page: the xAI-only proxy. */}
      {page === 'network'
        ? (
            <div style={pageStyleInner}>
              <div style={cardStyle}>
                <h3 style={{ ...titleStyle, fontSize: 14 }}>{t('proxyTitle')}</h3>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <input
                    type="text"
                    value={proxyUrl}
                    placeholder={t('proxyPlaceholder')}
                    disabled={proxyBusy}
                    aria-label={t('proxyTitle')}
                    onChange={(event) => {
                      proxyEditedRef.current = true
                      setProxyUrl(event.target.value)
                      setProxyFeedback('idle')
                    }}
                    style={{
                      flex: '1 1 260px',
                      minHeight: 34,
                      padding: '6px 12px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: 10,
                      background: 'var(--dsw-alias-bg-layer-1)',
                      color: 'var(--dsw-alias-label-primary)',
                      font: 'inherit',
                      fontSize: 14,
                    }}
                  />
                  <button type="button" style={buttonStyle} disabled={proxyBusy} onClick={() => { void saveProxy() }}>
                    {proxyBusy ? t('working') : t('proxySave')}
                  </button>
                </div>
                <p style={bodyStyle}>{t('proxyHint')}</p>
                {pageHasDraft('network') ? <p role="status" style={bodyStyle}>{t('unsavedChangesHint')}</p> : null}
                {proxyFeedback === 'saved'
                  ? <p role="status" style={{ ...bodyStyle, color: 'var(--dsw-alias-state-success-primary, #22a06b)' }}>{t('proxySaved')}</p>
                  : null}
                {proxyFeedback === 'error' ? <p role="alert" style={errorStyle}>{t('proxyError')}</p> : null}
              </div>
            </div>
          )
        : null}
    </section>
  )
}
