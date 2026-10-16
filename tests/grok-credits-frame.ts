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

/** One uncompressed gRPC-web data frame wrapping a GetGrokCreditsConfig message. */
export function encodeCreditsGrpcWeb(options: GrokCreditsFrameOptions): Buffer {
  const parts: Buffer[] = []
  if (options.percent !== undefined) {
    const float = Buffer.alloc(4)
    float.writeFloatLE(options.percent, 0)
    parts.push(Buffer.from([0x0d]), float) // field 1, wire type 5 (32-bit)
  }
  const timestamp = (iso: string | undefined, tag: number): void => {
    if (iso === undefined) return
    const seconds = Math.floor(Date.parse(iso) / 1000)
    const inner = Buffer.concat([Buffer.from([8]), encodeVarint(seconds)]) // Timestamp.seconds = field 1
    parts.push(Buffer.from([tag]), encodeVarint(inner.length), inner)
  }
  timestamp(options.start, 0x22) // config.start = field 4
  timestamp(options.end, 0x2a) // config.end = field 5
  const config = Buffer.concat(parts)
  const message = Buffer.concat([Buffer.from([0x0a]), encodeVarint(config.length), config]) // config = field 1
  const header = Buffer.alloc(5) // flag 0 (uncompressed) + big-endian length
  header.writeUInt32BE(message.length, 1)
  return Buffer.concat([header, message])
}
