/** Opt-in video defaults shared by host configuration and settings presentation. */
export const DEFAULT_VIDEO_MODEL = 'grok-imagine-video-1.5'
export const DEFAULT_VIDEO_MAX_BYTES = 100 * 1024 * 1024
export const MIN_VIDEO_MAX_BYTES = 1024 * 1024
/** Keep host admission aligned with the bounded browser download path in the first version. */
export const MAX_VIDEO_MAX_BYTES = DEFAULT_VIDEO_MAX_BYTES

export function validVideoModel(value: unknown): value is string {
  return value === DEFAULT_VIDEO_MODEL
}

export function validVideoMaxBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= MIN_VIDEO_MAX_BYTES && value <= MAX_VIDEO_MAX_BYTES
}
