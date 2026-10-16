//

// Part of dsh-grok-kit, Apache-2.0.

//

import { describe, expect, it } from 'vitest'
import { GROK_GRPC_EMPTY_FRAME, parseGrokCreditsGrpcWeb } from '../src/grok-credits.ts'
import { encodeCreditsGrpcWeb } from './grok-credits-frame.ts'

describe('parseGrokCreditsGrpcWeb (GROK-QUOTA-CREDITS-001)', () => {
  it('folds a weekly GetGrokCreditsConfig frame into the billing JSON shape', () => {
    const parsed = parseGrokCreditsGrpcWeb(encodeCreditsGrpcWeb({
      percent: 40,
      start: '2026-10-14T03:32:51Z',
      end: '2026-10-21T03:32:51Z',
    }))
    expect(parsed).toEqual({
      config: {
        creditUsagePercent: 40,
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-10-14T03:32:51.000Z',
          end: '2026-10-21T03:32:51.000Z',
        },
      },
    })
  })

  it('labels a monthly window from its length and leaves undecidable windows unlabeled', () => {
    const monthly = parseGrokCreditsGrpcWeb(encodeCreditsGrpcWeb({
      percent: 8,
      start: '2026-10-01T00:00:00Z',
      end: '2026-11-01T00:00:00Z',
    }))
    expect(monthly?.config.currentPeriod?.type).toBe('USAGE_PERIOD_TYPE_MONTHLY')
    const undecidable = parseGrokCreditsGrpcWeb(encodeCreditsGrpcWeb({
      percent: 8,
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-03T00:00:00Z',
    }))
    expect(undecidable?.config.creditUsagePercent).toBe(8)
    expect(undecidable?.config.currentPeriod).toEqual({
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-03T00:00:00.000Z',
    })
    expect(undecidable?.config.currentPeriod).not.toHaveProperty('type')
  })

  it('returns period details without inventing a percentage', () => {
    const parsed = parseGrokCreditsGrpcWeb(encodeCreditsGrpcWeb({
      start: '2026-10-07T11:18:57Z',
      end: '2026-10-14T11:18:57Z',
    }))
    expect(parsed).toEqual({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-10-07T11:18:57.000Z',
          end: '2026-10-14T11:18:57.000Z',
        },
      },
    })
    expect(parsed?.config).not.toHaveProperty('creditUsagePercent')
  })

  it('returns a percentage without a period when the window is absent', () => {
    expect(parseGrokCreditsGrpcWeb(encodeCreditsGrpcWeb({ percent: 42.5 }))).toEqual({
      config: { creditUsagePercent: 42.5 },
    })
  })

  it('rejects non-finite percentages instead of reporting them as usage', () => {
    expect(parseGrokCreditsGrpcWeb(encodeCreditsGrpcWeb({ percent: Number.NaN }))).toBeUndefined()
    expect(parseGrokCreditsGrpcWeb(encodeCreditsGrpcWeb({
      percent: Number.POSITIVE_INFINITY,
      start: '2026-10-07T11:18:57Z',
      end: '2026-10-14T11:18:57Z',
    }))).toBeUndefined()
  })

  it('returns undefined for empty input, an empty frame, and undecodable bytes', () => {
    expect(parseGrokCreditsGrpcWeb(new Uint8Array())).toBeUndefined()
    expect(parseGrokCreditsGrpcWeb(GROK_GRPC_EMPTY_FRAME)).toBeUndefined()
    expect(parseGrokCreditsGrpcWeb(new Uint8Array([1, 2, 3]))).toBeUndefined()
    // A frame whose message carries no known fields cannot yield usage data.
    expect(parseGrokCreditsGrpcWeb(Buffer.from([0, 0, 0, 0, 2, 0xff, 0xff]))).toBeUndefined()
  })

  it('skips compressed frames and grpc-status trailers and reads the first data frame', () => {
    const data = encodeCreditsGrpcWeb({ percent: 7, start: '2026-10-07T11:18:57Z', end: '2026-10-14T11:18:57Z' })
    const compressed = Buffer.from([0x80, 0, 0, 0, 2, 0xff, 0xff])
    const trailerText = Buffer.from('grpc-status: 0')
    const trailerHeader = Buffer.alloc(5)
    trailerHeader.writeUInt32BE(trailerText.length, 1)
    const bytes = Buffer.concat([compressed, data, trailerHeader, trailerText])
    expect(parseGrokCreditsGrpcWeb(bytes)?.config.creditUsagePercent).toBe(7)
  })

  it('never invents an end for a start-only window', () => {
    const parsed = parseGrokCreditsGrpcWeb(encodeCreditsGrpcWeb({
      percent: 43,
      start: '2026-10-07T11:18:57Z',
    }))
    expect(parsed).toEqual({
      config: {
        creditUsagePercent: 43,
        currentPeriod: { start: '2026-10-07T11:18:57.000Z' },
      },
    })
    expect(parsed?.config.currentPeriod).not.toHaveProperty('end')
  })

  it('rejects a truncated length-delimited field instead of decoding the partial bytes', () => {
    // The config field declares 100 bytes but only 5 follow — exactly one
    // complete float field. Without the bounds check that decodes into a
    // fabricated creditUsagePercent of 0; parsing must fail instead.
    const message = Buffer.from([0x0a, 100, 0x0d, 0x00, 0x00, 0x00, 0x00])
    const header = Buffer.alloc(5)
    header.writeUInt32BE(message.length, 1)
    expect(parseGrokCreditsGrpcWeb(Buffer.concat([header, message]))).toBeUndefined()
  })
})
