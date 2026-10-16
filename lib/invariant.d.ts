//#region src/invariant.d.ts
/**
 * Package-owned invariant companion for `dsh-grok-kit`.
 * @module dsh-grok-kit/invariant
 */
/** Core 0.2.1 no longer ships the invariants service. Keep the legacy export inert. */
declare const name = "grok-kit-invariant";
declare const apply: () => Promise<() => void>;
//#endregion
export { apply, name };