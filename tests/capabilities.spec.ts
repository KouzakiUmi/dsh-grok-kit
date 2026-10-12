//

// Part of dsh-grok-kit, Apache-2.0.

//

import { describe, expect, it } from 'vitest'
import { CapabilityTracker } from '../src/capabilities.ts'

const ISO = '2026-01-02T03:04:05.000Z'

describe('CapabilityTracker', () => {
  it('starts with every feature unverified and quota unavailable', () => {
    const snapshot = new CapabilityTracker().snapshot(true)
    expect(snapshot.features.map(feature => feature.id)).toEqual(['video', 'voice', 'code', 'image-generation'])
    expect(snapshot.features.every(feature => feature.state === 'unverified')).toBe(true)
    expect(snapshot.features.every(feature => feature.checkedAt === undefined && feature.model === undefined)).toBe(true)
    expect(snapshot.quota.state).toBe('unavailable')
    expect(snapshot.quota.message.length).toBeGreaterThan(0)
    expect(snapshot.videoEnabled).toBe(true)
  })

  it('reflects an observed video probe without touching other features', () => {
    const tracker = new CapabilityTracker()
    tracker.observe('video', { state: 'available', checkedAt: ISO, model: 'grok-video', httpStatus: 200 })
    const snapshot = tracker.snapshot(true)
    expect(snapshot.features[0]).toEqual({
      id: 'video',
      state: 'available',
      checkedAt: ISO,
      model: 'grok-video',
      httpStatus: 200,
    })
    expect(snapshot.features.slice(1).every(feature => feature.state === 'unverified')).toBe(true)
  })

  it('records restricted and temporary-error states', () => {
    const tracker = new CapabilityTracker()
    tracker.observe('video', {
      state: 'temporary-error',
      checkedAt: ISO,
      model: 'grok-video',
      httpStatus: 503,
      message: 'upstream 503',
    })
    expect(tracker.snapshot(true).features[0]).toMatchObject({
      state: 'temporary-error',
      httpStatus: 503,
      message: 'upstream 503',
    })
    tracker.observe('video', { state: 'restricted', checkedAt: ISO, model: 'grok-video', httpStatus: 403 })
    expect(tracker.snapshot(true).features[0]).toMatchObject({ state: 'restricted', httpStatus: 403 })
  })

  it('redacts token-like strings and truncates long messages', () => {
    const tracker = new CapabilityTracker()
    tracker.observe('video', {
      state: 'restricted',
      checkedAt: ISO,
      model: 'grok-video',
      httpStatus: 403,
      message: 'Bearer abc123def456 denied; access_token=secret789',
    })
    const message = tracker.snapshot(true).features[0]!.message!
    expect(message).toContain('[redacted]')
    expect(message).not.toContain('abc123def456')
    expect(message).not.toContain('secret789')
    tracker.observe('video', {
      state: 'temporary-error',
      checkedAt: ISO,
      model: 'grok-video',
      message: 'x'.repeat(5000),
    })
    expect(tracker.snapshot(true).features[0]!.message!.length).toBeLessThanOrEqual(1000)
  })

  it('redacts JSON keys, signed URLs, and authorization values beyond safeMessage', () => {
    const tracker = new CapabilityTracker()
    tracker.observe('video', {
      state: 'restricted',
      checkedAt: ISO,
      model: 'grok-video',
      httpStatus: 403,
      message: 'upstream body: {"api_key":"sk-live-abc123","region":"us"} '
        + 'and {"authorization":"Basic dXNlcjpwYXNz"} '
        + 'from https://cdn.example.com/v/file?X-Amz-Signature=deadbeef123&X-Amz-Expires=60',
    })
    const message = tracker.snapshot(true).features[0]!.message!
    expect(message).not.toContain('sk-live-abc123')
    expect(message).not.toContain('dXNlcjpwYXNz')
    expect(message).not.toContain('deadbeef123')
    expect(message).not.toContain('X-Amz-Signature=')
    expect(message).toContain('[redacted]')
  })

  it('reset clears recorded history', () => {
    const tracker = new CapabilityTracker()
    tracker.observe('video', { state: 'available', checkedAt: ISO, model: 'grok-video' })
    tracker.reset()
    expect(tracker.snapshot(true).features.every(feature => feature.state === 'unverified')).toBe(true)
  })

  it('hides stale video observations while the feature flag is off', () => {
    const tracker = new CapabilityTracker()
    tracker.observe('video', { state: 'available', checkedAt: ISO, model: 'grok-video' })
    const disabled = tracker.snapshot(false)
    expect(disabled.videoEnabled).toBe(false)
    expect(disabled.features[0]).toEqual({ id: 'video', state: 'unverified' })
    expect(tracker.snapshot(true).features[0]!.state).toBe('available')
  })

  it('falls back to the injected clock when checkedAt is empty', () => {
    const tracker = new CapabilityTracker(() => ISO)
    tracker.observe('video', { state: 'available', checkedAt: '', model: 'grok-video' })
    expect(tracker.snapshot(true).features[0]!.checkedAt).toBe(ISO)
  })

  it('snapshot is a stable plain-data view (no probing, repeatable)', () => {
    const tracker = new CapabilityTracker()
    expect(tracker.snapshot(true)).toEqual(tracker.snapshot(true))
  })
})
