//#region src/invariant.ts
/**
* Package-owned invariant companion for `dsh-grok-kit`.
* @module dsh-grok-kit/invariant
*/
/** Core 0.2.1 no longer ships the invariants service. Keep the legacy export inert. */
const name = "grok-kit-invariant";
const apply = () => Promise.resolve(() => {});
//#endregion
export { apply, name };
