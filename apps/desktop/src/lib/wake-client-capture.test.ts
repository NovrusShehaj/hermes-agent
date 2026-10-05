// Regression test for #119089: macOS Desktop remote-gateway client capture
// went permanently deaf (platform capture error kills the continuous PCM
// chain) while the ear still showed "listening" and no error ever surfaced.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WakeAudioHandoff } from './wake-audio-handoff'
import {
  type ClientWakeCaptureHandle,
  type ClientWakeCaptureOptions,
  startClientWakeCapture
} from './wake-client-capture'

class FakeTrack {
  readyState = 'live'
  stop = vi.fn()
  onended: (() => void) | null = null
  onmute: (() => void) | null = null
}

class FakeStream {
  constructor(public tracks: FakeTrack[]) {}

  getAudioTracks(): FakeTrack[] {
    return this.tracks
  }

  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

class FakeProcessor {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()
  constructor(public bufferSize: number) {}

  emit(input: Float32Array): void {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => input } })
  }
}

class FakeSource {
  connect = vi.fn()
  disconnect = vi.fn()
}

class FakeGain {
  gain = { value: 1 }
  connect = vi.fn()
  disconnect = vi.fn()
}

const instances: FakeAudioContext[] = []

class FakeAudioContext {
  static sampleRate = 48_000
  sampleRate = FakeAudioContext.sampleRate
  state = 'running'
  destination = {}
  processors: FakeProcessor[] = []
  resume = vi.fn().mockResolvedValue(undefined)
  close = vi.fn().mockResolvedValue(undefined)

  constructor() {
    instances.push(this)
  }

  createMediaStreamSource(_stream: unknown): FakeSource {
    return new FakeSource()
  }

  createScriptProcessor(bufferSize: number): FakeProcessor {
    const processor = new FakeProcessor(bufferSize)
    this.processors.push(processor)

    return processor
  }

  createGain(): FakeGain {
    return new FakeGain()
  }
}

const TONE = 0.2 // comfortably above any silence floor
const toneFrame = () => new Float32Array(4096).fill(TONE)
const silentFrame = () => new Float32Array(4096) // digital zeros, like a dead capture chain

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function flatten(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

describe('startClientWakeCapture (issue #119089)', () => {
  let tracks: FakeTrack[]
  let getUserMedia: ReturnType<typeof vi.fn>
  let handles: ClientWakeCaptureHandle[]

  const processor = () => instances[instances.length - 1].processors[0]

  const start = (overrides: Partial<ClientWakeCaptureOptions> = {}) =>
    startClientWakeCapture({
      frameLength: 1280,
      request: async () => ({ fed: true }),
      ...overrides
    })

  beforeEach(() => {
    instances.length = 0
    FakeAudioContext.sampleRate = 48_000
    handles = []
    tracks = [new FakeTrack()]
    getUserMedia = vi.fn().mockResolvedValue(new FakeStream(tracks))
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true
    })
  })

  afterEach(() => {
    for (const handle of handles) {
      handle.stop()
    }

    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('streams resampled 16 kHz PCM frames to wake.feed', async () => {
    const request = vi.fn(async () => ({ fed: true }))
    const handle = await start({ request })
    handles.push(handle)

    processor().emit(toneFrame())
    await flush()

    expect(request).toHaveBeenCalled()
    const [method, params] = request.mock.calls[0] as unknown as [string, { pcm: string; sample_rate: number }]
    expect(method).toBe('wake.feed')
    expect(params.sample_rate).toBe(16_000)
    // 48 kHz -> 16 kHz: 4096 input samples become 1365, so one 80 ms frame ships.
    expect(Buffer.from(params.pcm, 'base64')).toHaveLength(1280 * 2)
    expect(handle.active).toBe(true)
  })

  it('reports sustained digital silence instead of staying deaf forever', async () => {
    const onError = vi.fn()
    const handle = await start({ onError, silenceFramesThreshold: 10 })
    handles.push(handle)

    for (let i = 0; i < 10; i++) {
      processor().emit(silentFrame())
    }

    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/silence/i)
    expect(handle.active).toBe(false)
  })

  it('keeps listening through real audio with a quiet floor', async () => {
    const onError = vi.fn()
    const request = vi.fn(async () => ({ fed: true }))
    const handle = await start({ onError, request })
    handles.push(handle)

    for (let i = 0; i < 30; i++) {
      processor().emit(toneFrame())
    }

    await flush()
    expect(onError).not.toHaveBeenCalled()
    expect(handle.active).toBe(true)
    expect(request).toHaveBeenCalled()
  })

  it('reports a dead microphone track instead of feeding zeros', async () => {
    const onError = vi.fn()
    const handle = await start({ onError })
    handles.push(handle)

    tracks[0].onended?.()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/track ended/i)
    expect(handle.active).toBe(false)
  })

  it('throws when getUserMedia yields no live audio track', async () => {
    getUserMedia.mockResolvedValue(new FakeStream([]))

    await expect(start()).rejects.toThrow(/microphone track/i)
  })

  it('reports a stalled audio graph with no callbacks', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const handle = await start({ onError, stallTimeoutMs: 1000 })
    handles.push(handle)

    await vi.advanceTimersByTimeAsync(1500)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/stall/i)
    expect(handle.active).toBe(false)
  })

  it('escalates consecutive refused wake.feed frames', async () => {
    const onError = vi.fn()
    const request = vi.fn(async () => ({ fed: false, reason: 'not_owner' }))
    const handle = await start({ onError, request, maxConsecutiveFeedFailures: 3 })
    handles.push(handle)

    for (let i = 0; i < 6; i++) {
      processor().emit(toneFrame())
    }

    await flush()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/wake\.feed refused/i)
    expect(handle.active).toBe(false)
  })

  it('tolerates an isolated wake.feed failure without killing the ear', async () => {
    const onError = vi.fn()
    let calls = 0

    const request = vi.fn(async () => {
      calls += 1

      if (calls === 1) {
        throw new Error('transient network blip')
      }

      return { fed: true }
    })

    const handle = await start({ onError, request, maxConsecutiveFeedFailures: 3 })
    handles.push(handle)

    for (let i = 0; i < 6; i++) {
      processor().emit(toneFrame())
    }

    await flush()
    expect(onError).not.toHaveBeenCalled()
    expect(handle.active).toBe(true)
  })

  it('retains sequence-coded samples gaplessly despite a delayed feed and queue overflow', async () => {
    FakeAudioContext.sampleRate = 16_000
    // The feed hangs: frames back up and the queue drops the oldest — exactly
    // the remote-latency case retention exists for.
    const request = vi.fn(() => new Promise(() => undefined))
    const handoff = new WakeAudioHandoff()
    const handle = await start({ frameLength: 160, onFrame: frame => handoff.write(frame), request })
    handles.push(handle)

    // float (g+1)/32768 quantizes to int16 value exactly g — a monotone unit
    // sequence, so any gap, duplication or reorder shows up in the decode.
    const emitRamp = (from: number, count: number) => {
      const input = new Float32Array(count)

      for (let i = 0; i < count; i++) {
        input[i] = (from + i + 1) / 32768
      }

      processor().emit(input)
    }

    emitRamp(0, 4 * 4096)
    await flush()

    // 102 frames of 160 samples against a 24-frame queue cap: the overflow
    // dropped feed frames while one batch sits in flight forever.
    expect(request).toHaveBeenCalled()

    const lease = handoff.offer()
    const snapshot = lease!.begin()

    expect(snapshot![0]).toBe(0)

    const parts: Int16Array[] = [snapshot!]

    lease!.onSamples(chunk => parts.push(chunk))

    // The 64-sample frame-assembly residue flushes into the continuation:
    // across the ownership boundary the sequence must remain unbroken.
    emitRamp(4 * 4096, 2 * 4096)
    await flush()

    const all = flatten(parts)

    expect(all).toHaveLength(153 * 160)

    const breaks: number[] = []

    for (let i = 1; i < all.length; i++) {
      if (all[i] !== all[i - 1] + 1) {
        breaks.push(i)
      }
    }

    expect(breaks).toEqual([])
    expect(handle.active).toBe(true)
  })

  it('keeps the resampler continuous across callback boundaries at 44.1 kHz', async () => {
    FakeAudioContext.sampleRate = 44_100
    const frames: Int16Array[] = []
    const handle = await start({ onFrame: frame => frames.push(frame) })
    handles.push(handle)

    for (let block = 0; block < 4; block++) {
      const input = new Float32Array(4096)

      for (let i = 0; i < 4096; i++) {
        input[i] = (block * 4096 + i) / 32768
      }

      processor().emit(input)
    }

    await flush()

    const out = flatten(frames)

    // 4 × 4096 inputs at 44.1 kHz → 5944 samples at 16 kHz; only the four
    // complete 1280-sample frames leave the assembler.
    expect(out).toHaveLength(4 * 1280)

    // Values track their source position. A per-block resampler that drops
    // its fractional residue skips ~3 input samples per block — the decoded
    // line would sit ~9 units high by the end. The phase-carrying resampler
    // stays within a sample of the true line across every block boundary.
    const ratio = 44_100 / 16_000
    let maxDeviation = 0

    for (let k = 0; k < out.length; k++) {
      maxDeviation = Math.max(maxDeviation, Math.abs(out[k] - (out[0] + k * ratio)))
    }

    expect(maxDeviation).toBeLessThanOrEqual(3)
  })

  it('pauseFeed keeps the mic alive but stops detector feeding', async () => {
    const request = vi.fn(async () => ({ fed: true }))
    const frames: Int16Array[] = []
    const handle = await start({ onFrame: frame => frames.push(frame), request })
    handles.push(handle)

    processor().emit(toneFrame())
    await flush()

    expect(request).toHaveBeenCalled()

    const framesBefore = frames.length

    handle.pauseFeed()
    request.mockClear()
    processor().emit(toneFrame())
    await flush()

    // The wake landed: no detector feeding, but retention keeps flowing and
    // the stream stays alive for the first utterance.
    expect(request).not.toHaveBeenCalled()
    expect(frames.length).toBeGreaterThan(framesBefore)
    expect(tracks[0].stop).not.toHaveBeenCalled()
    expect(handle.active).toBe(true)
  })

  it('a quiet user during the wake handoff is not a dead capture chain', async () => {
    const onError = vi.fn()
    const handle = await start({ onError, silenceFramesThreshold: 5 })
    handles.push(handle)

    handle.pauseFeed()

    for (let i = 0; i < 20; i++) {
      processor().emit(silentFrame())
    }

    await flush()

    expect(onError).not.toHaveBeenCalled()
    expect(handle.active).toBe(true)
  })

  it('never fires the failure callback from a retired capture', async () => {
    const onError = vi.fn()
    const handle = await start({ onError, silenceFramesThreshold: 5 })
    handles.push(handle)

    handle.stop()

    for (let i = 0; i < 10; i++) {
      processor().emit(silentFrame())
    }

    tracks[0].onended?.()

    expect(onError).not.toHaveBeenCalled()
    expect(handle.active).toBe(false)
  })
})
