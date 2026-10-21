//

// Part of dsh-grok-kit, Apache-2.0.

//

/**
 * GetGrokCreditsConfig gRPC-web billing probe helpers (GROK-QUOTA-CREDITS-001).
 *
 * The Grok CLI billing proxy's `GET /v1/billing?format=credits` shape answers
 * HTTP 500 ("Failed to serialize billing response") on some unified-billing
 * accounts, while grok.com's gRPC-web GetGrokCreditsConfig still answers on
 * the same OAuth Bearer and reports credit_usage_percent. This module only
 * parses gRPC-web frames — it sends no network requests. Field numbers and
 * semantics mirror dsh-subusage's grok-credits module so both consumers read
 * the same wire shape. Parsing failures return undefined. An omitted proto3
 * float decodes to zero only for a complete config with an active known period.
 * A body is usable only when grpc-status is 0, from the
 * 0x80 trailer or from an HTTP header the caller supplies (trailers-only).
 * @module dsh-grok-kit/grok-credits
 */

/** Official grok.com gRPC-web billing endpoint (POST with an empty request frame). */
export const GROK_GRPC_CREDITS_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'
/** gRPC-web empty message frame: 1 flag byte (uncompressed) + 4-byte big-endian zero length. */
export const GROK_GRPC_EMPTY_FRAME = new Uint8Array([0, 0, 0, 0, 0])

/** Optional HTTP `grpc-status`, used when the transport promoted trailers out of the body. */
export interface ParseGrokCreditsOptions {
  headerStatus?: string | null
  /** Epoch milliseconds used to verify the active period before applying a proto3 zero. */
  now?: number
}

/** The config fragment normalizeSuperGrokQuota consumes as `body.config`. */
export interface GrokCreditsBillingBody {
  config: {
    /** USED percentage (0–100), explicit or the verified proto3 implicit zero. */
    creditUsagePercent?: number
    currentPeriod?: { type?: string; start?: string; end?: string }
  }
}

interface Varint {
  value: number
  next: number
}

function readVarint(message: Uint8Array, offset: number, skipValue = false): Varint | undefined {
  let result = 0
  let next = offset
  for (let index = 0; index < 10 && next < message.length; index += 1) {
    const byte = message[next++]
    if (index === 9 && byte > 1) return undefined
    result += (byte & 0x7f) * 2 ** (7 * index)
    if ((byte & 0x80) === 0) {
      return skipValue || Number.isSafeInteger(result) ? { value: result, next } : undefined
    }
  }
  return undefined
}

function skipField(message: Uint8Array, offset: number, wire: number): number | undefined {
  if (wire === 0) return readVarint(message, offset, true)?.next
  if (wire === 1) return offset + 8 <= message.length ? offset + 8 : undefined
  if (wire === 2) {
    const length = readVarint(message, offset)
    if (length === undefined) return undefined
    const next = length.next + length.value
    return next <= message.length ? next : undefined
  }
  if (wire === 5) return offset + 4 <= message.length ? offset + 4 : undefined
  return undefined
}

/**
 * Protobuf tags are varints: field numbers above 15 occupy more than one
 * byte. Reading a single byte would treat the continuation as payload and
 * shift every later field (GROK-QUOTA-CREDITS-001).
 */
function readTag(message: Uint8Array, offset: number): { field: number; wire: number; next: number } | undefined {
  const tag = readVarint(message, offset)
  if (tag === undefined || tag.value < 8 || tag.value > 0xffffffff) return undefined
  return { field: tag.value >>> 3, wire: tag.value & 7, next: tag.next }
}

/** Validate the whole message, not just the prefix before the first known field. */
function isCompleteMessage(message: Uint8Array, wires: Readonly<Record<number, number>>): boolean {
  let offset = 0
  const seen = new Set<number>()
  while (offset < message.length) {
    const tag = readTag(message, offset)
    if (tag === undefined) return false
    if (Object.hasOwn(wires, tag.field)) {
      // Ambiguous duplicate singular fields must not authorize an implicit zero.
      if (tag.wire !== wires[tag.field] || seen.has(tag.field)) return false
      seen.add(tag.field)
    }
    const next = skipField(message, tag.next, tag.wire)
    if (next === undefined) return false
    offset = next
  }
  return true
}

function readLengthDelimitedField(message: Uint8Array, fieldNumber: number): Uint8Array | undefined {
  let offset = 0
  while (offset < message.length) {
    const tag = readTag(message, offset)
    if (tag === undefined) return undefined
    offset = tag.next
    if (tag.wire === 2) {
      const length = readVarint(message, offset)
      if (length === undefined) return undefined
      offset = length.next
      // A truncated payload must fail parsing, never return a short subarray
      // that decodes into invented data.
      if (length.next + length.value > message.length) return undefined
      const value = message.subarray(offset, offset + length.value)
      offset += length.value
      if (tag.field === fieldNumber) return value
      continue
    }
    const skipped = skipField(message, offset, tag.wire)
    if (skipped === undefined) return undefined
    offset = skipped
  }
  return undefined
}

function readFloatField(message: Uint8Array, fieldNumber: number): number | undefined {
  let offset = 0
  while (offset < message.length) {
    const tag = readTag(message, offset)
    if (tag === undefined) return undefined
    offset = tag.next
    if (tag.wire === 5) {
      if (offset + 4 > message.length) return undefined
      const value = new DataView(message.buffer, message.byteOffset + offset, 4).getFloat32(0, true)
      offset += 4
      if (tag.field === fieldNumber) return value
      continue
    }
    const skipped = skipField(message, offset, tag.wire)
    if (skipped === undefined) return undefined
    offset = skipped
  }
  return undefined
}

/** google.protobuf.Timestamp { int64 seconds = 1; } normalized to an ISO string. */
function readTimestampField(message: Uint8Array, fieldNumber: number): string | undefined {
  const nested = readLengthDelimitedField(message, fieldNumber)
  if (nested === undefined || !isCompleteMessage(nested, { 1: 0, 2: 0 })) return undefined
  let offset = 0
  let seconds: number | undefined
  let nanos = 0
  while (offset < nested.length) {
    const tag = readTag(nested, offset)
    if (tag === undefined) break
    offset = tag.next
    if (tag.wire === 0 && (tag.field === 1 || tag.field === 2)) {
      const value = readVarint(nested, offset)
      if (value === undefined) break
      offset = value.next
      if (tag.field === 1) seconds = value.value
      if (tag.field === 2) {
        if (value.value > 999_999_999) return undefined
        nanos = value.value
      }
      continue
    }
    const skipped = skipField(nested, offset, tag.wire)
    if (skipped === undefined) break
    offset = skipped
  }
  if (seconds === undefined) return undefined
  const date = new Date(seconds * 1000 + nanos / 1_000_000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

interface GrpcWebScan {
  message?: Uint8Array
  /** Trimmed grpc-status from a readable 0x80 trailer, when that line was present. */
  trailerStatus?: string
  /** A trailer bit was set but the frame was not a readable uncompressed status. */
  trailerUnreadable: boolean
  /** Compressed/unknown or multiple data frames cannot prove an implicit zero. */
  ambiguousData: boolean
}

/** ASCII header block. Undefined when the frame is not headers; null when headers omit grpc-status. */
function readTrailerGrpcStatus(frame: Uint8Array): string | null | undefined {
  for (const byte of frame) {
    const printable = byte >= 0x20 && byte <= 0x7e
    const whitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d
    if (!printable && !whitespace) return undefined
  }
  let status: string | undefined
  for (const line of Buffer.from(frame).toString('ascii').split(/\r\n|\n|\r/)) {
    if (line.length === 0) continue
    const colon = line.indexOf(':')
    if (colon <= 0) return undefined
    const name = line.slice(0, colon).trim().toLowerCase()
    if (name.length === 0 || /\s/.test(name)) return undefined
    if (name !== 'grpc-status') continue
    const value = line.slice(colon + 1).trim()
    if (status !== undefined && status !== value) return undefined
    status = value
  }
  return status ?? null
}

/**
 * Walk gRPC-web frames. 0x00 is the only uncompressed data frame; 0x80 is the
 * trailer. Any other flag is not a readable message — including a compressed
 * trailer (0x81), which cannot be checked and fails closed.
 */
function scanGrpcWeb(bytes: Uint8Array): GrpcWebScan | undefined {
  let offset = 0
  let message: Uint8Array | undefined
  let trailerStatus: string | undefined
  let trailerUnreadable = false
  let ambiguousData = false
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) return undefined
    const flags = bytes[offset]
    const length = bytes[offset + 1] * 16777216 + bytes[offset + 2] * 65536 + bytes[offset + 3] * 256 + bytes[offset + 4]
    offset += 5
    if (offset + length > bytes.length) return undefined
    const frame = bytes.subarray(offset, offset + length)
    offset += length
    if ((flags & 0x80) !== 0) {
      if (flags !== 0x80) {
        trailerUnreadable = true
        continue
      }
      const status = readTrailerGrpcStatus(frame)
      if (status === undefined) {
        trailerUnreadable = true
        continue
      }
      if (status !== null) {
        if (trailerStatus !== undefined && trailerStatus !== status) trailerUnreadable = true
        else trailerStatus = status
      }
      continue
    }
    if (flags !== 0 || message !== undefined) ambiguousData = true
    if (flags === 0 && message === undefined) message = frame
  }
  return { message, trailerStatus, trailerUnreadable, ambiguousData }
}

/** grpc-status 0 from the header or the trailer, and no contradictory status. */
function grpcStatusAccepted(scan: GrpcWebScan, headerStatus: string | null | undefined): boolean {
  if (scan.trailerUnreadable) return false
  const header = headerStatus?.trim()
  const headerPresent = header !== undefined && header.length > 0
  if (headerPresent && header !== '0') return false
  if (scan.trailerStatus !== undefined && scan.trailerStatus !== '0') return false
  return scan.trailerStatus === '0' || header === '0'
}

/**
 * Period kind is derived from the reported window length (weekly ≈ 7 days,
 * monthly ≈ 30): the wire reports no enum here. Undecidable windows stay
 * unlabeled instead of guessing.
 */
function periodType(startIso: string | undefined, endIso: string | undefined): string | undefined {
  if (startIso === undefined || endIso === undefined) return undefined
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined
  const days = (end - start) / 86400000
  if (days >= 4 && days <= 12) return 'USAGE_PERIOD_TYPE_WEEKLY'
  if (days >= 20 && days <= 45) return 'USAGE_PERIOD_TYPE_MONTHLY'
  return undefined
}

/**
 * Fold a GetGrokCreditsConfig gRPC-web response into the JSON shape
 * normalizeSuperGrokQuota understands. Parsing failures return undefined —
 * never a fabricated 0%.
 */
export function parseGrokCreditsGrpcWeb(
  bytes: Uint8Array,
  options?: ParseGrokCreditsOptions,
): GrokCreditsBillingBody | undefined {
  if (bytes.length === 0) return undefined
  const scan = scanGrpcWeb(bytes)
  if (scan?.message === undefined || !grpcStatusAccepted(scan, options?.headerStatus)) return undefined
  const message = scan.message
  const envelope = readLengthDelimitedField(message, 1)
  const config = envelope ?? message
  if (!isCompleteMessage(message, envelope === undefined ? { 1: 5, 4: 2, 5: 2 } : { 1: 2 })
    || !isCompleteMessage(config, { 1: 5, 4: 2, 5: 2 })) return undefined
  let usedPercent = readFloatField(config, 1)
  const start = readTimestampField(config, 4)
  // A missing end stays missing: deriving end = start would invent a reset
  // date at the period start and still yields no decidable period kind.
  const end = readTimestampField(config, 5)
  const type = periodType(start, end)
  // credit_usage_percent is a proto3 non-optional float: absence means zero.
  // Apply that default only to a complete, unambiguous config with a known
  // active billing window. Missing configs, stale periods and malformed data
  // remain unknown; REST JSON never receives this default on its own.
  const now = options?.now ?? Date.now()
  if (usedPercent === undefined && envelope !== undefined && !scan.ambiguousData
    && type !== undefined && start !== undefined && end !== undefined
    && Date.parse(start) <= now && now < Date.parse(end)) usedPercent = 0
  const currentPeriod = end !== undefined || start !== undefined
    ? {
        ...type === undefined ? {} : { type },
        ...start === undefined ? {} : { start },
        ...end === undefined ? {} : { end },
      }
    : undefined
  // A wire value that decoded to a non-number (NaN/Infinity) is unusable, not zero.
  // Finite values outside 0–100 are returned unchanged: normalizeSuperGrokQuota
  // rejects them (invalid), matching the REST credits shape. Clamping or
  // dropping the percent here would hide a bad reading behind partial metadata.
  if (usedPercent !== undefined && !Number.isFinite(usedPercent)) return undefined
  if (usedPercent === undefined && currentPeriod === undefined) return undefined
  return {
    config: {
      ...usedPercent === undefined ? {} : { creditUsagePercent: usedPercent },
      ...currentPeriod === undefined ? {} : { currentPeriod },
    },
  }
}
