# Optional video tasks and capability status (development version)

This feature belongs to the current source development version, not necessarily the published npm 0.2.2 package. It is off by default, requires account OAuth entitlement, and consumes subscription usage. Mock tests are not live-account verification.

## Enable

Enable video tools in Settings → xAI Grok → Search & feature options, save, and restart the host. Alternatively configure the plugin:

```yaml
videoTool: true
videoModel: grok-imagine-video-1.5
videoMaxBytes: 104857600
```

The first version supports only `grok-imagine-video-1.5`. The default download cap is 100 MiB; integral caps from 1–100 MiB are accepted, matching the first-version browser download ceiling. It reuses existing OAuth credentials and the xAI-only proxy, without creating another credential copy. Tasks fail closed when no stable account identity can be determined; access/refresh tokens are not account identifiers.

## Workflow

1. Call `grok_video_generate` with `prompt` and `image`, optionally `duration` (6 or 10 seconds) and `resolution` (480p or 720p). Tool defaults: 6 seconds, 480p.
2. Submission returns a plugin `taskId`, not the upstream request ID. Later call `grok_video_status` with `task_id`; each call performs one poll.
3. Use `grok_video_resume(task_id)` after a local interruption or failed download. It continues polling/downloading, never resubmits generation.
4. A completed MP4 is a normal DSH file attachment. Results carry its full `attachment={...}` reference. Download through the video card or settings task list.

Image sources may be full session image attachment references, data URIs, or local paths read through host fs permissions. Bare image attachment IDs require an attachment backend that exposes `imageHostPath`; remote backends need a full reference. Remote image URLs are rejected in this first version. The official [image-to-video documentation](https://docs.x.ai/developers/model-capabilities/video/image-to-video) explicitly supports base64 data URIs; one signed-in account has successfully submitted and stored a six-second video requested at the 480p tier using a session image converted to a data URI. This does not establish availability for every account or subscription tier.

## States and billing

- `pending`: generating upstream.
- `downloading`: downloading/saving the result.
- `done`: MP4 saved as a file attachment.
- `interrupted`: query/save interrupted; resumable without resubmission.
- `failed`: definite failure.
- `submission-unknown`: submission outcome cannot be confirmed. No automatic POST retry. A job whose request ID was never received may not be recoverable; status checks do not generate a replacement.

**Stopping a tool, closing the page, or unloading the plugin does not cancel upstream generation or guarantee billing stops.** A replacement generation must be an explicitly requested new operation.

## Storage and downloads

Tasks are partitioned by a stable account digest under `DSH_HOME/dsh-grok-kit`, retaining up to 50 recent records per account. Pruning task records does not delete stored video attachments. Switching accounts cannot reveal or resume another account's tasks.

Downloads permit only `https://vidgen.x.ai`, reject redirects, omit OAuth headers, enforce streamed byte limits, and check the MP4 signature before saving via file attachment streams.

The host session's native image reader cannot read file attachments. A plugin-owned endpoint supplies task-scoped downloads:

```text
GET /plugins/dsh-grok-kit/video/file?taskId=<UUID of a completed task owned by the current account>
```

It reads saved attachments only, never arbitrary paths or caller-supplied attachment IDs, and follows loopback/Host/same-origin checks. Results are ordinary file attachments. The redesigned card reads and validates the complete file through the same-origin endpoint after a user action; inline playback and download share the same media data. Range requests are not provided. The frontend never receives signed upstream media URLs.

## Capabilities and limits

The panel shows observations from this process only: unverified, available, restricted, or temporary error. Opening it or refreshing the local task list does not generate media or probe upstream permissions.

The image-generation row refers to the not-yet-integrated server-side Responses feature, not the existing `grok_imagine` tool. Voice and server-side Python are not implemented in this first version.

Quota remains unavailable until its API contract is verified. Token estimates are not presented as subscription balances. Restarting clears in-memory capability observations, but preserves tasks.

Live verification must separately cover OAuth entitlement, model availability, submission/recovery, and the configured attachment backend's file streaming support. HTTP 403 is not treated as token expiry or assumed to mean a subscription-tier restriction. HTTP 429 does not trigger token refresh. No entitlement promise is made for every SuperGrok/X Premium tier. Media watermarks and provenance signals must not be removed.
