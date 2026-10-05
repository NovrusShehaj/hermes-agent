/**
 * Phase 3 — preserve speech immediately after the wake phrase.
 *
 * The handoff contract pinned here: one continuous PCM segment made of the
 * ENTIRE retained pre-event window plus the live continuation, each
 * sequence-coded sample present exactly once (boundary uniqueness), explicit
 * listening → offered → recording-first-utterance → stopped/cancelled states,
 * single consumption, bounded retention/offer/utterance storage, a valid mono
 * 16-bit WAV at the engine rate, and release-exactly-once teardown on
 * completion, cancellation and timeout.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  encodePcmWavMono,
  PCM_METER_DIVISOR,
  pcmInt16Level,
  WAKE_OFFER_TTL_MS,
  WAKE_RETENTION_SAMPLES,
  WAKE_SAMPLE_RATE,
  WakeAudioHandoff,
  WakeAudioRing
} from './wake-audio-handoff'

/** Sequence-coded samples: value === position, so any gap, duplication or
 *  reordering across the retention boundary is visible in the decode. */
function seq(from: number, count: number): Int16Array {
  const out = new Int16Array(count)

  for (let i = 0; i < count; i++) {
    out[i] = from + i
  }

  return out
}

function concat(parts: Int16Array[]): Int16Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Int16Array(total)
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

describe('WakeAudioRing', () => {
  it('retains a bounded window with a monotonic cursor and clamped reads', () => {
    const ring = new WakeAudioRing(10)

    ring.push(seq(0, 7))

    expect(ring.totalSamples).toBe(7)
    expect(ring.retainedSamples).toBe(7)
    expect(ring.retainedBytes).toBe(14)
    expect(Array.from(ring.copyFrom(0))).toEqual([0, 1, 2, 3, 4, 5, 6])

    // Past capacity: the oldest samples are overwritten, never reordered.
    ring.push(seq(7, 10))

    expect(ring.totalSamples).toBe(17)
    expect(ring.retainedSamples).toBe(10)
    expect(Array.from(ring.copyFrom(0))).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    // A cursor past what the ring still holds clamps to the oldest retained.
    expect(Array.from(ring.copyFrom(3))).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    expect(Array.from(ring.copyFrom(12))).toEqual([12, 13, 14, 15, 16])
  })

  it('clear() drops the audio but keeps the cursor monotonic', () => {
    const ring = new WakeAudioRing(10)

    ring.push(seq(0, 6))
    ring.clear()

    expect(ring.retainedSamples).toBe(0)
    expect(ring.totalSamples).toBe(6)
    expect(ring.copyFrom(0)).toHaveLength(0)

    ring.push(seq(100, 2))

    expect(ring.totalSamples).toBe(8)
    expect(Array.from(ring.copyFrom(0))).toEqual([100, 101])
  })
})

describe('WakeAudioHandoff first-utterance continuity', () => {
  it('delivers known samples before/during/after the event exactly once, with no boundary gap', () => {
    const handoff = new WakeAudioHandoff({ retentionSamples: 1000 })

    // Before the wake event reaches us: retained in the ring.
    handoff.write(seq(0, 120))

    const lease = handoff.offer()

    expect(lease).not.toBeNull()
    expect(handoff.state).toBe('offered')

    // Spoken while the event travels to the renderer / the UI starts.
    handoff.write(seq(120, 60))

    const snapshot = lease!.begin()

    expect(handoff.state).toBe('recording-first-utterance')
    expect(Array.from(snapshot!)).toEqual([...Array(180).keys()])

    // After consumption: live continuation through the listener, registered
    // in the same synchronous block as begin() — no gap, no duplication.
    const parts: Int16Array[] = [snapshot!]
    const unsubscribe = lease!.onSamples(chunk => parts.push(chunk))

    handoff.write(seq(180, 40))
    handoff.write(seq(220, 10))
    unsubscribe()
    handoff.write(seq(999, 5)) // unsubscribed — must not appear

    const utterance = concat(parts)

    expect(utterance).toHaveLength(230)
    expect(Array.from(utterance)).toEqual([...Array(230).keys()])
  })

  it('preserves the entire retained prefix even when it overwrote older audio', () => {
    const handoff = new WakeAudioHandoff({ retentionSamples: 50 })

    handoff.write(seq(0, 130)) // 130 offered, only the last 50 retained

    const lease = handoff.offer()
    const snapshot = lease!.begin()

    expect(Array.from(snapshot!)).toEqual([...Array(50).keys()].map(i => i + 80))
  })

  it('offers idempotently while pending but never mints a second lease', () => {
    const handoff = new WakeAudioHandoff()
    const first = handoff.offer()

    // Duplicate wake event during the offer window: same lease, same state.
    expect(handoff.offer()).toBe(first)
    expect(handoff.state).toBe('offered')

    expect(first!.begin()).not.toBeNull()
    // Single consumption: the mic now belongs to the first utterance.
    expect(first!.begin()).toBeNull()
    expect(handoff.offer()).toBeNull()
    expect(handoff.state).toBe('recording-first-utterance')

    handoff.finish()

    expect(handoff.state).toBe('stopped')
    expect(handoff.offer()).toBeNull()
  })

  it('bounds the continuation and flags truncation instead of growing without limit', () => {
    const handoff = new WakeAudioHandoff({
      offerTtlMs: 1,
      retentionSamples: 10,
      utteranceCapMs: 1
    })
    // Cap = (offer TTL + utterance ceiling) = 2 ms at 16 kHz = 32 samples.
    // Synchronous test body: the TTL timer cannot fire before begin().

    const lease = handoff.offer()

    handoff.write(seq(0, 30))
    handoff.write(seq(30, 30)) // over the cap: dropped, flagged

    expect(lease!.truncated).toBe(true)

    const snapshot = lease!.begin()

    expect(snapshot).toHaveLength(30)
  })
})

describe('WakeAudioHandoff lifecycle bounds', () => {
  it('expires an unconsumed offer and releases everything exactly once', () => {
    vi.useFakeTimers()

    try {
      const released = vi.fn()
      const handoff = new WakeAudioHandoff({ onRelease: released, offerTtlMs: 100 })

      handoff.write(seq(0, 10))
      handoff.offer()

      expect(handoff.state).toBe('offered')

      vi.advanceTimersByTime(150)

      expect(handoff.state).toBe('cancelled')
      expect(released).toHaveBeenCalledTimes(1)

      // Late writes and a late cancel cannot resurrect or double-release.
      handoff.write(seq(50, 10))
      handoff.cancel()
      handoff.finish()

      expect(released).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancellation mid-recording stops delivery and releases once', () => {
    const released = vi.fn()
    const handoff = new WakeAudioHandoff({ onRelease: released })
    const lease = handoff.offer()

    lease!.begin()

    const heard: number[] = []
    const unsubscribe = lease!.onSamples(chunk => heard.push(...chunk))

    handoff.write(seq(7, 3))
    expect(heard).toEqual([7, 8, 9])

    lease!.cancel()

    expect(handoff.state).toBe('cancelled')
    expect(released).toHaveBeenCalledTimes(1)

    handoff.write(seq(100, 3))
    unsubscribe()

    expect(heard).toEqual([7, 8, 9])
    // Terminal paths are idempotent.
    lease!.finish()
    handoff.cancel()

    expect(released).toHaveBeenCalledTimes(1)
  })

  it('finish releases once and later writes are inert', () => {
    const released = vi.fn()
    const handoff = new WakeAudioHandoff({ onRelease: released })
    const lease = handoff.offer()

    lease!.begin()
    handoff.write(seq(1, 2))
    lease!.finish()

    expect(handoff.state).toBe('stopped')
    expect(released).toHaveBeenCalledTimes(1)

    handoff.write(seq(9, 2))
    lease!.cancel()

    expect(released).toHaveBeenCalledTimes(1)
    expect(lease!.begin()).toBeNull()
  })
})

describe('encodePcmWavMono', () => {
  it('encodes a valid mono 16-bit WAV whose decode returns the exact samples', async () => {
    const samples = seq(-1000, 320)
    const blob = encodePcmWavMono(samples)

    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + samples.length * 2)

    const view = new DataView(await blob.arrayBuffer())

    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)))

    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // channels — mono
    expect(view.getUint32(24, true)).toBe(WAKE_SAMPLE_RATE)
    expect(view.getUint32(28, true)).toBe(WAKE_SAMPLE_RATE * 2) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(ascii(36, 4)).toBe('data')
    // Decoded sample count/rate/channels round-trip exactly.
    expect(view.getUint32(40, true)).toBe(samples.length * 2)

    const decoded = new Int16Array(samples.length)

    for (let i = 0; i < samples.length; i++) {
      decoded[i] = view.getInt16(44 + i * 2, true)
    }

    expect(Array.from(decoded)).toEqual(Array.from(samples))
  })

  it('encodes an empty segment as a valid zero-length data chunk', async () => {
    const blob = encodePcmWavMono(new Int16Array(0))
    const view = new DataView(await blob.arrayBuffer())

    expect(blob.size).toBe(44)
    expect(view.getUint32(40, true)).toBe(0)
  })
})

describe('pcmInt16Level', () => {
  it('maps int16 RMS onto the recorder meter scale, not raw RMS', () => {
    // voice-barge-in documents the scale: int16 RMS 1500/4000 ≈ 0.14/0.37.
    expect(pcmInt16Level(new Int16Array([1500, -1500, 1500, -1500]))).toBeCloseTo(1500 / PCM_METER_DIVISOR, 5)
    expect(1500 / PCM_METER_DIVISOR).toBeCloseTo(0.14, 1)
    expect(4000 / PCM_METER_DIVISOR).toBeCloseTo(0.37, 1)
    expect(pcmInt16Level(new Int16Array(0))).toBe(0)
  })

  it('clamps to 1 instead of reporting impossible levels', () => {
    expect(pcmInt16Level(new Int16Array([32_767, -32_768]))).toBe(1)
  })
})

describe('bounds constants', () => {
  it('retention and offer windows are explicit and finite', () => {
    expect(WAKE_RETENTION_SAMPLES).toBe(WAKE_SAMPLE_RATE * 5)
    expect(WAKE_OFFER_TTL_MS).toBeGreaterThan(0)
    expect(WAKE_OFFER_TTL_MS).toBeLessThanOrEqual(30_000)
  })
})
