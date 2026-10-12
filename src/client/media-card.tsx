import type { CSSProperties, ReactNode } from 'react'

/** Shared, theme-native presentation for image and video tool results. */
export type MediaCardTone = 'neutral' | 'busy' | 'success' | 'error'
export const mediaCardStyles = {
  muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
  preview: { display: 'grid', placeItems: 'center', minHeight: 180, overflow: 'hidden', borderRadius: 12, background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)' },
  action: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 34, padding: '7px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, fontWeight: 500, cursor: 'pointer' },
  primaryAction: { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-base)' },
  detail: { display: 'grid', gap: 8, paddingTop: 12, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere', minWidth: 0 },
  prompt: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', fontSize: 12, lineHeight: 1.65 },
} satisfies Record<string, CSSProperties>

const tones: Record<MediaCardTone, CSSProperties> = {
  neutral: { color: 'var(--dsw-alias-label-secondary)' },
  busy: { color: 'var(--dsw-alias-label-primary)' },
  success: { color: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))' },
  error: { color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-primary))' },
}

export interface MediaCardFrameProps {
  title: string
  status?: string
  statusTone?: MediaCardTone
  summary?: ReactNode
  preview?: ReactNode
  actions?: ReactNode
  details?: ReactNode
  detailsLabel?: string
  notice?: ReactNode
  testId?: string
  ariaLabel?: string
}

export function MediaCardFrame({ title, status, statusTone = 'neutral', summary, preview, actions, details, detailsLabel, notice, testId, ariaLabel }: MediaCardFrameProps) {
  return (
    <section data-testid={testId} aria-label={ariaLabel ?? title} style={{ display: 'grid', gap: 14, width: '100%', maxWidth: 760, minWidth: 0, boxSizing: 'border-box', padding: 16, borderRadius: 14, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <strong style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</strong>
          {summary === undefined ? null : <div style={{ ...mediaCardStyles.muted, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{summary}</div>}
        </div>
        {status === undefined ? null : <span role="status" style={{ ...tones[statusTone], display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 20, background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', fontSize: 11, fontWeight: 500 }}>{statusTone === 'busy' ? <span aria-hidden>◌</span> : null}{status}</span>}
      </header>
      {preview}
      {notice === undefined ? null : <div style={mediaCardStyles.muted}>{notice}</div>}
      {actions === undefined ? null : <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>{actions}</div>}
      {details === undefined ? null : <details style={{ borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 10 }}><summary style={{ ...mediaCardStyles.muted, cursor: 'pointer', userSelect: 'none' }}>{detailsLabel}</summary><div style={mediaCardStyles.detail}>{details}</div></details>}
    </section>
  )
}
