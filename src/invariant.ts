//

// Derived from dsh-xai (https://github.com/MirDie/dsh-xai), Apache-2.0.

// Modified for dsh-grok-kit — see NOTICE for the full attribution.

//

/**
 * Package-owned invariant companion for `dsh-grok-kit`.
 * @module dsh-grok-kit/invariant
 */

/** Core 0.2.1 no longer ships the invariants service. Keep the legacy export inert. */
export const name = 'grok-kit-invariant'

export const apply = (): Promise<() => void> => Promise.resolve(() => {})
