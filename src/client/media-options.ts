/** Build only the media choices deliberately accepted on the settings page. */
export function mediaTogglePatch(
  current: { imagineTool?: unknown; editTool?: unknown; videoTool?: unknown },
  group: 'images' | 'video',
  enabled: boolean,
): Record<string, boolean> | undefined {
  if (!enabled) return group === 'images'
    ? { imagineTool: false, editTool: false }
    : { videoTool: false }
  // The caller reaches `enabled` only after the inline risk confirmation, and
  // shows it again on every reopening. A first acknowledgement must not wake
  // hidden legacy true switches in the other group: send the visible effective
  // choices for all media explicitly.
  return {
    imagineTool: group === 'images' || current.imagineTool === true,
    editTool: group === 'images' || current.editTool === true,
    videoTool: group === 'video' || current.videoTool === true,
    mediaRiskAcknowledged: true,
  }
}
