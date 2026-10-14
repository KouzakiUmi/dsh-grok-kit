/**
 * DSH video tools over the xAI Videos API (image-to-video).
 *
 * Registers grok_video_generate / grok_video_status / grok_video_resume on top
 * of one shared VideoTaskManager (owned by the host plugin entry). All three
 * tools keep their abort signal, state plainly that stopping the wait does NOT
 * cancel the remote generation (billing may continue), and hand the finished
 * MP4 to the model as a full file attachment reference — never a fictional
 * video block. `presentationMeta` carries the safe-to-JSON VideoTaskResult so
 * a capable UI can offer the download.
 * @module dsh-grok-kit/video-tools
 */

import type {} from '@deepseek-ai/dsh-fs'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_MAX_IMAGE_BYTES } from './imagine-edit-core.ts'
import { assertMediaEnabled } from './media-options.ts'
import {
  SUPPORTED_VIDEO_DURATIONS,
  SUPPORTED_VIDEO_RESOLUTIONS,
  VideoTaskManager,
  type VideoTaskResult,
  type VideoTaskState,
} from './video-core.ts'

const GENERATE_TOOL = 'grok_video_generate'
const STATUS_TOOL = 'grok_video_status'
const RESUME_TOOL = 'grok_video_resume'

const BILLING_NOTE = 'Submitting starts a paid xAI video generation: stopping/aborting this tool only stops waiting, it does NOT cancel the remote generation and does not stop billing. Use grok_video_status later to fetch the result.'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

interface VideoToolValue {
  text: string
  taskId: string
  state: VideoTaskState
  model: string
  createdAt: string
  updatedAt: string
  prompt: string
  duration?: number
  resolution?: string
  attachment?: { attachmentId: string; name: string; bytes: number }
  error?: string
}

/** Model-facing summary text; carries the full file attachment reference when done. */
function renderTaskText(result: VideoTaskResult): string {
  const lines = [
    `Video task ${result.taskId} is ${result.state} (model ${result.model}).`,
    `Prompt: ${result.prompt.length > 200 ? `${result.prompt.slice(0, 200)}…` : result.prompt}`,
  ]
  if (result.duration !== undefined || result.resolution !== undefined) {
    lines.push(`Output: ${result.duration === undefined ? 'default duration' : `${String(result.duration)}s`}${result.resolution === undefined ? '' : ` ${result.resolution}`}.`)
  }
  if (result.state === 'done' && result.attachment !== undefined) {
    lines.push(`Video saved. attachmentId=${result.attachment.attachmentId}`)
    lines.push(`attachment=${JSON.stringify(result.attachment)}`)
    lines.push('Use the host file tools to export the attachment; the remote download URL is intentionally not exposed.')
  }
  if (result.state === 'pending' || result.state === 'downloading') {
    lines.push('Still processing upstream: call grok_video_status later (one poll per call).')
  }
  if (result.state === 'interrupted') {
    lines.push('Interrupted locally: call grok_video_resume to retry the check/download.')
  }
  if (result.state === 'submission-unknown') {
    lines.push('Submission outcome unknown and NO request id was recorded: grok_video_status cannot recover or poll this task — it only reports it as unknown. Do NOT submit the same request again and do NOT keep polling this task.')
  }
  if (result.state === 'failed') {
    lines.push('Generation failed upstream.')
  }
  if (result.error !== undefined) lines.push(`Error: ${result.error}`)
  lines.push('Stopping the wait is not cancelling: the remote generation keeps running and may still bill.')
  return lines.join(' ')
}

function valueFromResult(result: VideoTaskResult): VideoToolValue {
  const value: VideoToolValue = {
    text: renderTaskText(result),
    taskId: result.taskId,
    state: result.state,
    model: result.model,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    prompt: result.prompt,
  }
  if (result.duration !== undefined) value.duration = result.duration
  if (result.resolution !== undefined) value.resolution = result.resolution
  if (result.attachment !== undefined) value.attachment = result.attachment
  if (result.error !== undefined) value.error = result.error
  return value
}

/** The presentationMeta projection: exactly the VideoTaskResult (no text, no remote URL). */
function taskResultFromValue(value: unknown): VideoTaskResult | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.taskId) || !isNonEmptyString(record.state) || !isNonEmptyString(record.model)
    || !isNonEmptyString(record.createdAt) || !isNonEmptyString(record.updatedAt) || !isNonEmptyString(record.prompt)) {
    return undefined
  }
  const result: VideoTaskResult = {
    taskId: record.taskId,
    state: record.state as VideoTaskState,
    model: record.model,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    prompt: record.prompt,
  }
  if (typeof record.duration === 'number') result.duration = record.duration
  if (typeof record.resolution === 'string') result.resolution = record.resolution
  if (record.attachment !== null && typeof record.attachment === 'object' && !Array.isArray(record.attachment)) {
    const attachment = record.attachment as Record<string, unknown>
    if (isNonEmptyString(attachment.attachmentId) && isNonEmptyString(attachment.name) && typeof attachment.bytes === 'number') {
      result.attachment = {
        attachmentId: attachment.attachmentId as FileAttachmentRef['attachmentId'],
        name: attachment.name,
        bytes: attachment.bytes,
      }
    }
  }
  if (typeof record.error === 'string') result.error = record.error
  return result
}

/**
 * Model-facing render: the summary text always (including the full file
 * attachment reference) plus the real harness FileBlock for a done task, so the
 * session log can reference the stored attachment. Never a fictional video block.
 */
function renderOutput(_args: unknown, raw: unknown): ContentBlock[] {
  const value = raw as unknown as VideoToolValue | undefined
  const blocks: ContentBlock[] = [{ type: 'text', text: String(value?.text ?? '') }]
  const task = taskResultFromValue(value)
  if (task?.attachment !== undefined) blocks.push({ type: 'file', attachment: task.attachment })
  return blocks
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    taskId: { type: 'string' },
    state: { type: 'string' },
    model: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    prompt: { type: 'string' },
    duration: { type: 'number' },
    resolution: { type: 'string' },
    attachment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        name: { type: 'string' },
        bytes: { type: 'number' },
      },
    },
    error: { type: 'string' },
  },
} as const

export interface GrokVideoToolOptions {
  manager: VideoTaskManager
  /** Current effective local media switch, including calls from old cards. */
  enabled?: () => boolean
}

/**
 * Register the three video tools. The manager is supplied by the host entry
 * (feature-flagged there); this layer only adapts tool IO.
 */
export function applyGrokVideoTools(ctx: Context, options: GrokVideoToolOptions): void {
  const manager = options.manager
  if (manager === undefined || typeof manager.generate !== 'function') {
    throw new TypeError('applyGrokVideoTools requires a VideoTaskManager')
  }

  const taskTitle = (args: Record<string, unknown> | undefined, fallback: string): string => {
    const prompt = args?.prompt
    if (typeof prompt === 'string' && prompt.trim().length > 0) {
      return prompt.trim().length > 80 ? `${prompt.trim().slice(0, 80)}…` : prompt.trim()
    }
    const taskId = args?.task_id
    if (typeof taskId === 'string' && taskId.trim().length > 0) return `video ${taskId.trim()}`
    return fallback
  }

  ctx.tools.register(defineTool({
    name: GENERATE_TOOL,
    description: `Generate a short video from one source image with xAI Imagine Video (POST /v1/videos/generations, image-to-video, SuperGrok / X Premium subscription). The source image may be a DSH attachment reference from this session (pass the attachmentId=sha256:... handle or the full attachment={...} JSON that read_image / view_image returns), a local file path, or a base64 data URI (PNG/JPEG/WebP); remote http(s) image URLs are rejected in this version. ${BILLING_NOTE} Returns the task; when done the tool result carries the full file attachment reference of the saved MP4.`,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Text prompt describing how the still image should animate, e.g. "Make the water crash down and slowly pan out the camera".' },
      image: { type: 'string', required: true, description: 'Source image: a session attachment from read_image / view_image (attachmentId=sha256:... or the whole attachment={...} JSON line), a local file path, or a base64 data URI (PNG/JPEG/WebP). Remote http(s) URLs are rejected in this version.' },
      duration: { type: 'number', description: `Video duration in seconds: ${SUPPORTED_VIDEO_DURATIONS.join(' or ')} (default 6).` },
      resolution: { type: 'string', description: `Output resolution: ${SUPPORTED_VIDEO_RESOLUTIONS.join(' or ')} (default 480p).` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      // Declared so the runner populates result.meta for presentResult below.
      presentationMeta: (_args, value) => {
        const task = taskResultFromValue(value)
        return (task ?? { ...(value as Record<string, unknown>) }) as never
      },
      render: renderOutput,
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: taskTitle(args as Record<string, unknown> | undefined, GENERATE_TOOL), kind: 'other' }),
    presentResult: (args, result) => {
      if (result.isError) return undefined
      const task = taskResultFromValue(result?.meta)
      if (task?.attachment === undefined) return undefined
      return {
        card: 'generic',
        title: taskTitle(args as Record<string, unknown> | undefined, GENERATE_TOOL),
        content: [{ type: 'file' as const, attachment: task.attachment }],
      }
    },
    async execute(args, exec) {
      assertMediaEnabled(options.enabled, GENERATE_TOOL)
      const prompt = isNonEmptyString(args?.prompt) ? args.prompt.trim() : ''
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      const image = isNonEmptyString(args?.image) ? args.image.trim() : ''
      if (image.length === 0) throw new Error('image must be a non-empty source (attachment handle, local path or data URI)')
      const duration = args?.duration ?? 6
      if (typeof duration !== 'number' || !(SUPPORTED_VIDEO_DURATIONS as readonly number[]).includes(duration)) {
        throw new Error(`duration must be one of ${SUPPORTED_VIDEO_DURATIONS.join(', ')}`)
      }
      const resolution = args?.resolution ?? '480p'
      if (typeof resolution !== 'string' || !(SUPPORTED_VIDEO_RESOLUTIONS as readonly string[]).includes(resolution)) {
        throw new Error(`resolution must be one of ${SUPPORTED_VIDEO_RESOLUTIONS.join(', ')}`)
      }
      const cwd = exec.agent?.session?.header?.cwd
      const result = await manager.generate({ prompt, image, duration, resolution }, exec.signal, {
        ...cwd === undefined ? {} : { cwd },
        // Local paths go through the sandboxed host fs; this module never reads
        // the filesystem itself.
        readFile: async path => {
          const fs = exec.agent?.ctx?.fs ?? ctx.fs
          if (fs === undefined) throw new Error('grok_video_generate: the DSH filesystem service is required for local source images')
          const target = await fs.resolve(path, { cwd, signal: exec.signal })
          return fs.readBytes(target, exec.signal, DEFAULT_MAX_IMAGE_BYTES)
        },
      })
      ctx.logger?.info?.(`${GENERATE_TOOL}: task ${result.taskId} is ${result.state}`)
      return valueFromResult(result)
    },
  }))

  const registerStatusTool = (name: string, run: (taskId: string, signal: AbortSignal | undefined) => Promise<VideoTaskResult>, description: string): void => {
    ctx.tools.register(defineTool({
      name,
      description,
      parameters: {
        task_id: { type: 'string', required: true, description: 'Task id returned by grok_video_generate.' },
      },
      output: {
        schema: OUTPUT_SCHEMA,
        presentationMeta: (_args, value) => {
          const task = taskResultFromValue(value)
          return (task ?? { ...(value as Record<string, unknown>) }) as never
        },
        render: renderOutput,
      },
      isConcurrencySafe: () => true,
      presentCall: args => ({ card: 'generic', title: taskTitle(args as Record<string, unknown> | undefined, name), kind: 'other' }),
      presentResult: (args, result) => {
        if (result.isError) return undefined
        const task = taskResultFromValue(result?.meta)
        if (task?.attachment === undefined) return undefined
        return {
          card: 'generic',
          title: taskTitle(args as Record<string, unknown> | undefined, name),
          content: [{ type: 'file' as const, attachment: task.attachment }],
        }
      },
      async execute(args, exec) {
        assertMediaEnabled(options.enabled, name)
        const taskId = isNonEmptyString(args?.task_id) ? args.task_id.trim() : ''
        if (taskId.length === 0) throw new Error('task_id must be a non-empty task id')
        const result = await run(taskId, exec.signal)
        ctx.logger?.info?.(`${name}: task ${result.taskId} is ${result.state}`)
        return valueFromResult(result)
      },
    }))
  }

  registerStatusTool(
    STATUS_TOOL,
    (taskId, signal) => manager.status(taskId, signal),
    `Check one xAI video task with a single poll (GET /v1/videos/{request_id}); a done task downloads the MP4 into the DSH attachment store once and never re-downloads. ${BILLING_NOTE} Local errors are reported as an interrupted state that grok_video_resume can retry.`,
  )
  registerStatusTool(
    RESUME_TOOL,
    (taskId, signal) => manager.resume(taskId, signal),
    `Continue one xAI video task after an interruption or restart (same single-poll logic as grok_video_status). Unknown submission results are never re-POSTed here. ${BILLING_NOTE}`,
  )

  ctx.logger?.info?.(`dsh-grok-kit: registered ${GENERATE_TOOL}, ${STATUS_TOOL}, ${RESUME_TOOL}`)
}
