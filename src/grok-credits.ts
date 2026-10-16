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
 * the same wire shape. Parsing failures return undefined; no usage number is
 * ever fabricated.
 * @module dsh-grok-kit/grok-credits
 */

/** Official grok.com gRPC-web billing endpoint (POST with an empty request frame). */
export const GROK_GRPC_CREDITS_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig'
/** gRPC-web empty message frame: 1 flag byte (uncompressed) + 4-byte big-endian zero length. */
export const GROK_GRPC_EMPTY_FRAME = new Uint8Array([0, 0, 0, 0, 0])

/** The config fragment normalizeSuperGrokQuota consumes as `body.config`. */
export interface GrokCreditsBillingBody {
  config: {
    /** USED percentage (0–100), only present when the wire reported one. */
    creditUsagePercent?: number
    currentPeriod?: { type?: string; start?: string; end?: string }
  }
}

interface Varint {
  value: number
  next: number
}

function readVarint(message: Uint8Array, offset: number): Varint | undefined {
  let result = 0
  let shift = 0
  let next = offset
  while (next < message.length && shift <= 35) {
    const byte = message[next++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value: result >>> 0, next }
    shift += 7
  }
  return undefined
}

function skipField(message: Uint8Array, offset: number, wire: number): number | undefined {
  if (wire === 0) return readVarint(message, offset)?.next
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

function readLengthDelimitedField(message: Uint8Array, fieldNumber: number): Uint8Array | undefined {
  let offset = 0
  while (offset < message.length) {
    const tag = message[offset++]
    const wire = tag & 7
    if (wire === 2) {
      const length = readVarint(message, offset)
      if (length === undefined) return undefined
      offset = length.next
      // A truncated payload must fail parsing, never return a short subarray
      // that decodes into invented data.
      if (length.next + length.value > message.length) return undefined
      const value = message.subarray(offset, offset + length.value)
      offset += length.value
      if (tag >>> 3 === fieldNumber) return value
      continue
    }
    const skipped = skipField(message, offset, wire)
    if (skipped === undefined) return undefined
    offset = skipped
  }
  return undefined
}

function readFloatField(message: Uint8Array, fieldNumber: number): number | undefined {
  let offset = 0
  while (offset < message.length) {
    const tag = message[offset++]
    const wire = tag & 7
    if (wire === 5) {
      if (offset + 4 > message.length) return undefined
      const value = new DataView(message.buffer, message.byteOffset + offset, 4).getFloat32(0, true)
      offset += 4
      if (tag >>> 3 === fieldNumber) return value
      continue
    }
    const skipped = skipField(message, offset, wire)
    if (skipped === undefined) return undefined
    offset = skipped
  }
  return undefined
}

/** google.protobuf.Timestamp { int64 seconds = 1; } normalized to an ISO string. */
function readTimestampField(message: Uint8Array, fieldNumber: number): string | undefined {
  const nested = readLengthDelimitedField(message, fieldNumber)
  if (nested === undefined) return undefined
  let offset = 0
  let seconds: number | undefined
  while (offset < nested.length) {
    const tag = nested[offset++]
    const wire = tag & 7
    if (wire === 0) {
      const value = readVarint(nested, offset)
      if (value === undefined) break
      offset = value.next
      if (tag >>> 3 === 1) seconds = value.value
      continue
    }
    const skipped = skipField(nested, offset, wire)
    if (skipped === undefined) break
    offset = skipped
  }
  if (seconds === undefined) return undefined
  return new Date(seconds * 1000).toISOString()
}

/** First uncompressed gRPC-web data frame; compressed frames and grpc-status trailers are skipped. */
function firstGrpcWebDataMessage(bytes: Uint8Array): Uint8Array | undefined {
  let offset = 0
  while (offset + 5 <= bytes.length) {
    const compressed = bytes[offset]
    const length = (bytes[offset + 1] << 24) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 8) | bytes[offset + 4]
    offset += 5
    if (length < 0 || offset + length > bytes.length) return undefined
    const frame = bytes.subarray(offset, offset + length)
    offset += length
    if (compressed === 0x80 || compressed !== 0) continue
    if (frame.length >= 11 && Buffer.from(frame.subarray(0, 11)).toString('utf8') === 'grpc-status') continue
    return frame
  }
  return undefined
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
export function parseGrokCreditsGrpcWeb(bytes: Uint8Array): GrokCreditsBillingBody | undefined {
  if (bytes.length === 0) return undefined
  const message = firstGrpcWebDataMessage(bytes)
  if (message === undefined) return undefined
  const config = readLengthDelimitedField(message, 1) ?? message
  const usedPercent = readFloatField(config, 1)
  const start = readTimestampField(config, 4)
  // A missing end stays missing: deriving end = start would invent a reset
  // date at the period start and still yields no decidable period kind.
  const end = readTimestampField(config, 5)
  const type = periodType(start, end)
  const currentPeriod = end !== undefined || start !== undefined
    ? {
        ...type === undefined ? {} : { type },
        ...start === undefined ? {} : { start },
        ...end === undefined ? {} : { end },
      }
    : undefined
  // A wire value that decoded to a non-number (NaN/Infinity) is unusable, not zero.
  if (usedPercent !== undefined && !Number.isFinite(usedPercent)) return undefined
  if (usedPercent === undefined && currentPeriod === undefined) return undefined
  return {
    config: {
      ...usedPercent === undefined ? {} : { creditUsagePercent: usedPercent },
      ...currentPeriod === undefined ? {} : { currentPeriod },
    },
  }
}
