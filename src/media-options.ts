/** Explicit local consent and switches for optional media tools. No credentials. */
export const MEDIA_TOOL_KEYS = ['imagineTool', 'editTool', 'videoTool'] as const
export type MediaToolKey = typeof MEDIA_TOOL_KEYS[number]

export interface EffectiveMediaOptions {
  imagineTool: boolean
  editTool: boolean
  videoTool: boolean
  mediaRiskAcknowledged: boolean
}

/** Old media enablement is not inherited; new choices require explicit consent. */
export function resolveMediaOptions(config: Record<string, unknown>): EffectiveMediaOptions {
  const mediaRiskAcknowledged = config.mediaRiskAcknowledged === true
  return {
    imagineTool: mediaRiskAcknowledged && config.imagineTool === true,
    editTool: mediaRiskAcknowledged && config.editTool === true,
    videoTool: mediaRiskAcknowledged && config.videoTool === true,
    mediaRiskAcknowledged,
  }
}

/** Every off -> on settings request must carry its own explicit confirmation. */
export function mediaEnableNeedsConfirmation(
  current: EffectiveMediaOptions,
  next: EffectiveMediaOptions,
  patch: unknown,
): boolean {
  const requested = typeof patch === 'object' && patch !== null && !Array.isArray(patch)
    ? patch as Record<string, unknown> : {}
  const enables = MEDIA_TOOL_KEYS.some(key => !current[key] && (next[key] || requested[key] === true))
  return enables && !(typeof patch === 'object' && patch !== null && !Array.isArray(patch)
    && 'mediaRiskAcknowledged' in patch && patch.mediaRiskAcknowledged === true)
}

/** Check at execution time too, including calls requested by old result cards. */
export function assertMediaEnabled(enabled: (() => boolean) | undefined, name: string): void {
  if (enabled !== undefined && !enabled()) {
    throw new Error(`${name} is disabled — enable it in Settings → xAI Grok first`)
  }
}
