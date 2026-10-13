/** Account-only subscription quota. No credentials or upstream URLs enter the browser. */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { XaiOAuthSettingsKey } from './locales.ts'
import type { QuotaSnapshot } from '../quota.ts'

const QUOTA_PATH = '/plugins/dsh-grok-kit/quota'
type Translate = (key: XaiOAuthSettingsKey, params?: Record<string, unknown>) => string

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
}

/** Whitelist the public contract, never render arbitrary error text or response fields. */
export function parseQuotaSnapshot(value: unknown): QuotaSnapshot {
  if (!record(value)) throw new Error('Invalid quota snapshot')
  if (value.state === 'signed-out' || value.state === 'unavailable' || value.state === 'error') {
    const reason = value.reason
    return {
      state: value.state,
      ...(reason === 'auth' || reason === 'restricted' || reason === 'temporary' || reason === 'invalid' ? { reason } : {}),
    }
  }
  const checkedAt = timestamp(value.checkedAt)
  const used = value.usedPercent
  const remaining = value.remainingPercent
  if (value.state !== 'available' || checkedAt === undefined
    || typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100
    || typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100
    || Math.abs(used + remaining - 100) > 0.001
    || (value.period !== 'week' && value.period !== 'month' && value.period !== 'subscription')) {
    throw new Error('Invalid quota snapshot')
  }
  const resetAt = timestamp(value.resetAt)
  return {
    state: 'available', usedPercent: used, remainingPercent: remaining, period: value.period, checkedAt,
    ...resetAt === undefined ? {} : { resetAt },
    ...typeof value.plan === 'string' && value.plan.trim() !== '' ? { plan: value.plan.slice(0, 100) } : {},
    ...typeof value.prepaidBalanceUsd === 'number' && Number.isFinite(value.prepaidBalanceUsd) && value.prepaidBalanceUsd >= 0
      ? { prepaidBalanceUsd: value.prepaidBalanceUsd } : {},
  }
}

const card: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 20px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const body: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const button: CSSProperties = { minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', cursor: 'pointer' }
const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }

export function QuotaDetails({ quota, t }: { quota: QuotaSnapshot; t: Translate }) {
  if (quota.state !== 'available') {
    const key: XaiOAuthSettingsKey = quota.state === 'signed-out' ? 'quotaSignedOut'
      : quota.reason === 'auth' ? 'quotaAuthError'
        : quota.reason === 'restricted' ? 'quotaRestricted'
          : quota.state === 'error' ? 'quotaError' : 'quotaUnavailable'
    return <p role="status" style={body}>{t(key)}</p>
  }
  const percent = (value: number) => `${Number(value.toFixed(1))}%`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={row}>
        <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{t(quota.period === 'week' ? 'quotaWeek' : quota.period === 'month' ? 'quotaMonth' : 'quotaSubscription')}</strong>
        <span style={body}>{t('quotaRemaining')}: {percent(quota.remainingPercent)}</span>
      </div>
      <div role="progressbar" aria-label={t('quotaUsed')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={quota.usedPercent}
        style={{ height: 8, borderRadius: 8, background: 'var(--dsw-alias-border-l2)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${quota.usedPercent}%`, background: 'var(--dsw-alias-brand-primary, #1677ff)' }} />
      </div>
      <p style={body}>{t('quotaUsed')}: {percent(quota.usedPercent)}</p>
      <dl style={{ ...body, display: 'grid', gridTemplateColumns: 'minmax(90px, auto) minmax(0, 1fr)', gap: '6px 16px' }}>
        {quota.plan === undefined ? null : <><dt>{t('quotaPlan')}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{quota.plan}</dd></>}
        {quota.prepaidBalanceUsd === undefined ? null : <><dt>{t('quotaBalance')}</dt><dd style={{ margin: 0 }}>{quota.prepaidBalanceUsd.toFixed(2)} USD</dd></>}
        {quota.resetAt === undefined ? null : <><dt>{t('quotaResetAt')}</dt><dd style={{ margin: 0 }}>{new Date(quota.resetAt).toLocaleString()}</dd></>}
        <dt>{t('quotaCheckedAt')}</dt><dd style={{ margin: 0 }}>{new Date(quota.checkedAt).toLocaleString()}</dd>
      </dl>
    </div>
  )
}

export function QuotaView({ t, signedIn }: { t: Translate; signedIn: boolean }) {
  const [quota, setQuota] = useState<QuotaSnapshot | undefined>()
  const [loading, setLoading] = useState(signedIn)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!signedIn) { setQuota({ state: 'signed-out' }); setLoading(false); return }
    const abort = new AbortController()
    let live = true
    setQuota(undefined)
    setLoading(true)
    void fetch(QUOTA_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Quota request failed')
        return parseQuotaSnapshot(await response.json())
      })
      .then(value => { if (live) setQuota(value) })
      .catch(() => { if (live && !abort.signal.aborted) setQuota({ state: 'error', reason: 'temporary' }) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false; abort.abort() }
  }, [signedIn, reload])
  return (
    <section aria-label={t('quotaTitle')} style={card}>
      <div style={row}>
        <h3 style={{ margin: 0, fontSize: 14, color: 'var(--dsw-alias-label-primary)' }}>{t('quotaTitle')}</h3>
        <button type="button" style={button} disabled={!signedIn || loading} onClick={() => setReload(value => value + 1)}>{t('quotaRefresh')}</button>
      </div>
      <p style={body}>{t('quotaIntro')}</p>
      {loading ? <p role="status" style={body}>{t('quotaLoading')}</p> : <QuotaDetails quota={signedIn ? quota ?? { state: 'unavailable' } : { state: 'signed-out' }} t={t} />}
    </section>
  )
}
