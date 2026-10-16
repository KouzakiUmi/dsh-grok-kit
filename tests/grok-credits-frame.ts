//

// Part of dsh-grok-kit, Apache-2.0.

//

/**
 * Test-only encoder for GetGrokCreditsConfig gRPC-web response frames
 * (GROK-QUOTA-CREDITS-001). Field numbers mirror the production parser in
 * src/grok-credits.ts: config = field 1, creditUsagePercent = field 1 float,
 * currentPeriod.start/end = Timestamp fields 4/5.
 */
import { Buffer } from 'node:buffer'

export interface GrokCreditsFrameOptions {
  percent?: number
  start?: string
  end?: string
  /** Default 0. `'omit'` leaves the body without a trailer (header-only path). */
  trailerStatus?: number | 'omit'
  /**
   * Insert field 16 (a multi-byte tag) before known fields, inside the outer
   * message, the config, and each timestamp. A single-byte tag reader cannot
   * still recover the percent and window.
   */
  leadingHighField?: boolean
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value >>> 0
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining)
  return Buffer.from(bytes)
}

function frame(flags: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header[0] = flags
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

/** Uncompressed gRPC-web trailer (flag 0x80) carrying grpc-status. */
export function encodeGrpcStatusTrailer(status: number): Buffer {
  return frame(0x80, Buffer.from(`grpc-status: ${status}\r\ngrpc-message: \r\n`))
}

/** Field 16, wire type 2, 3-byte payload. The tag itself is two bytes. */
function leadingHighField(): Buffer {
  const payload = Buffer.from([1, 2, 3])
  return Buffer.concat([encodeVarint((16 << 3) | 2), encodeVarint(payload.length), payload])
}

/** One uncompressed gRPC-web data frame wrapping a GetGrokCreditsConfig message. */
export function encodeCreditsGrpcWeb(options: GrokCreditsFrameOptions): Buffer {
  const parts: Buffer[] = []
  if (options.leadingHighField === true) parts.push(leadingHighField())
  if (options.percent !== undefined) {
    const float = Buffer.alloc(4)
    float.writeFloatLE(options.percent, 0)
    parts.push(Buffer.from([0x0d]), float) // field 1, wire type 5 (32-bit)
  }
  const timestamp = (iso: string | undefined, fieldNumber: number): void => {
    if (iso === undefined) return
    const seconds = Math.floor(Date.parse(iso) / 1000)
    const innerParts: Buffer[] = []
    if (options.leadingHighField === true) innerParts.push(leadingHighField())
    innerParts.push(Buffer.from([8]), encodeVarint(seconds)) // Timestamp.seconds = field 1
    const inner = Buffer.concat(innerParts)
    parts.push(encodeVarint((fieldNumber << 3) | 2), encodeVarint(inner.length), inner)
  }
  timestamp(options.start, 4) // config.start = field 4
  timestamp(options.end, 5) // config.end = field 5
  const config = Buffer.concat(parts)
  const messageParts: Buffer[] = []
  if (options.leadingHighField === true) messageParts.push(leadingHighField())
  messageParts.push(Buffer.from([0x0a]), encodeVarint(config.length), config) // config = field 1
  const body = frame(0, Buffer.concat(messageParts))
  if (options.trailerStatus === 'omit') return body
  return Buffer.concat([body, encodeGrpcStatusTrailer(options.trailerStatus ?? 0)])
}
