/**
 * Settings-nav icon decoration for this plugin's own row (xAI Grok).
 *
 * The official settings shell's navIcon(id) table is closed — official ids
 * get drawn icons and everything else falls back to a generic gear. This
 * replaces that fallback <svg> inside OUR nav button (matched by our own
 * registered label text) with the drawn terminal-prompt icon. A
 * MutationObserver re-applies the icon when the panel re-renders; gated on
 * the settings dialog being present so idle chat streams never pay the
 * query cost.
 */

const NAV_ICON_INNER =
  '<path d="M13.75 5v6.5a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 3.75 3.5h8.5A1.5 1.5 0 0 1 13.75 5z"/>'
  + '<path d="M4.75 6.5 6.5 8.25 4.75 10"/>'
  + '<path d="M8 10h2.25"/>'

const NAV_LABELS = new Set(['xAI Grok'])

interface EffectCapableContext {
  // Loose on purpose: cordis effect signatures vary across harness builds and
  // the decoration only forwards its own (fn, label) pair.
  effect: (...args: any[]) => unknown
}

export function decorateSettingsNavIcon(ctx: EffectCapableContext): void {
  ctx.effect(() => {
    const decorate = (): void => {
      if (document.querySelector('[role="dialog"]') === null) return
      for (const button of Array.from(document.querySelectorAll('button'))) {
        const label = button.querySelector(':scope > span')
        if (label === null || !NAV_LABELS.has(label.textContent ?? '')) continue
        const existing = button.firstElementChild
        if (existing instanceof SVGElement) {
          if (existing.dataset.navIcon === '1') continue
          const template = document.createElement('template')
          template.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-nav-icon="1">${NAV_ICON_INNER}</svg>`
          existing.replaceWith(template.content.firstElementChild as SVGElement)
        }
      }
    }
    const observer = new MutationObserver(() => decorate())
    observer.observe(document.body, { childList: true, subtree: true })
    decorate()
    return () => observer.disconnect()
  }, 'dsh-grok-kit: nav icon decoration')
}
