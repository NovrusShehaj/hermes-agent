import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WakeAudioHandoff } from '@/lib/wake-audio-handoff'

import { type MicRecorderErrorCopy, type MicRecording, useMicRecorder } from './use-mic-recorder'

// The level meter behind continuous voice mode is an AudioContext on the
// capture stream. #75329: a torn-down context was still closing when the next
// take opened another, the device errored, and the dead meter silently
// dropped every later utterance.

const copy: MicRecorderErrorCopy = {
  microphoneAccessDenied: 'denied',
  microphoneConstraintsUnsupported: 'constraints',
  microphoneInUse: 'in use',
  microphonePermissionDenied: 'permission',
  microphoneStartFailed: 'start failed',
  microphoneUnsupported: 'unsupported',
  noMicrophone: 'no mic'
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => (resolve = done))

  return { promise, resolve }
}

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = []
  static throwOnConstruct = false
  state: AudioContextState = 'running'
  closing = deferred()

  constructor() {
    super()

    if (FakeAudioContext.throwOnConstruct) {
      throw new DOMException('too many contexts', 'NotSupportedError')
    }

    FakeAudioContext.instances.push(this)
  }

  createAnalyser() {
    return { fftSize: 0, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }
  }

  createMediaStreamSource() {
    return { connect: vi.fn() }
  }

  resume = vi.fn(async () => undefined)

  close() {
    return this.closing.promise.then(() => {
      this.state = 'closed'
      this.dispatchEvent(new Event('statechange'))
    })
  }
}

class FakeMediaRecorder {
  static isTypeSupported = () => true
  mimeType = 'audio/webm'
  state: RecordingState = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['clip'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

const flush = () => act(async () => new Promise<void>(resolve => window.setTimeout(resolve, 0)))

beforeEach(() => {
  FakeAudioContext.instances = []
  FakeAudioContext.throwOnConstruct = false
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) }
  })
})

afterEach(() => {
  cleanup()
  FakeAudioContext.instances.forEach(context => context.closing.resolve())
  vi.unstubAllGlobals()
})

describe('useMicRecorder level meter', () => {
  it('waits for the previous take’s meter to finish closing before opening the next', async () => {
    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start()
    })
    await act(async () => {
      await result.current.handle.stop()
    })

    const first = FakeAudioContext.instances[0]
    let secondStart: Promise<void> | undefined

    act(() => {
      secondStart = result.current.handle.start()
    })
    await flush()

    // Still closing: no second context on top of it.
    expect(FakeAudioContext.instances).toHaveLength(1)

    await act(async () => {
      first.closing.resolve()
      await secondStart
    })

    expect(FakeAudioContext.instances).toHaveLength(2)
    expect(first.state).toBe('closed')
  })

  it('reports a device error on the meter and marks the take meterFailed', async () => {
    const onMeterFailure = vi.fn()
    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ onMeterFailure, onSilence: vi.fn(), silenceLevel: 0.075, silenceMs: 1_250 })
    })

    FakeAudioContext.instances[0].dispatchEvent(new Event('error'))
    await flush()

    expect(onMeterFailure).toHaveBeenCalledOnce()

    const recording = await stopTake(result.current.handle)

    expect(recording).toMatchObject({ heardSpeech: false, meterFailed: true })
  })

  it('treats a meter that cannot be built as failed instead of silently deaf', async () => {
    FakeAudioContext.throwOnConstruct = true
    const onMeterFailure = vi.fn()
    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ onMeterFailure })
    })
    await flush()

    expect(onMeterFailure).toHaveBeenCalledOnce()
  })

  it('does not report its own close at the end of a take as a failure', async () => {
    const onMeterFailure = vi.fn()
    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ onMeterFailure })
    })

    let recording: Awaited<ReturnType<typeof result.current.handle.stop>> = null

    await act(async () => {
      recording = await result.current.handle.stop()
      FakeAudioContext.instances[0].closing.resolve()
    })
    await flush()

    expect(onMeterFailure).not.toHaveBeenCalled()
    expect(recording).toMatchObject({ meterFailed: false })
  })
})

// Phase 3 (#131518): the wake handoff's retained PCM IS the first take's mic
// stream — one continuous segment encoded once, never joined to a MediaRecorder
// blob and never followed by a second getUserMedia. The handoff here is the
// REAL one: only the microphone boundary is faked.

const getUserMediaMock = () => navigator.mediaDevices.getUserMedia as unknown as ReturnType<typeof vi.fn>

async function decodeWav(blob: Blob) {
  const buf = await blob.arrayBuffer()
  const view = new DataView(buf)
  const tag = (offset: number) => String.fromCharCode(...new Uint8Array(buf, offset, 4))

  return {
    channels: view.getUint16(22, true),
    samples: new Int16Array(buf, 44),
    sampleRate: view.getUint32(24, true),
    tag: [tag(0), tag(8)]
  }
}

const ramp = (from: number, count: number) => Int16Array.from({ length: count }, (_, i) => from + i)

async function stopTake(handle: { stop: () => Promise<MicRecording | null> }): Promise<MicRecording | null> {
  const stops: (MicRecording | null)[] = []

  await act(async () => {
    stops.push(await handle.stop())
  })

  return stops.at(-1) ?? null
}

describe('useMicRecorder leased first-utterance take', () => {
  it('consumes the retained prefix and continues gaplessly without opening a stream', async () => {
    const handoff = new WakeAudioHandoff({ retentionSamples: 8, now: () => 0 })
    handoff.write(ramp(1, 8))
    const lease = handoff.offer()!
    // Spoken before the UI started: held for the eventual begin() snapshot.
    handoff.write(ramp(9, 4))

    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ captureLease: lease })
    })

    expect(result.current.recording).toBe(true)
    // The lease IS the mic: no second getUserMedia while it owns the device.
    expect(getUserMediaMock()).not.toHaveBeenCalled()

    // Live continuation after begin() joins the prefix with no gap or duplicate.
    act(() => {
      handoff.write(ramp(13, 4))
    })

    const recording = await stopTake(result.current.handle)

    expect(recording).not.toBeNull()
    expect(recording?.meterFailed).toBe(false)
    expect(recording?.truncated).toBeFalsy()
    expect(recording?.durationMs).toBeCloseTo((16 / 16_000) * 1000)

    const wav = await decodeWav(recording!.audio)

    expect(wav.tag).toEqual(['RIFF', 'WAVE'])
    expect(wav.sampleRate).toBe(16_000)
    expect(wav.channels).toBe(1)
    expect(Array.from(wav.samples)).toEqual(Array.from(ramp(1, 16)))
  })

  it('counts speech spoken wholly in the retained prefix and ends on trailing silence', async () => {
    const handoff = new WakeAudioHandoff({ retentionSamples: 8, now: () => 0 })
    // Loud prefix BEFORE the wake reaches the UI — the user already finished.
    handoff.write(Int16Array.from({ length: 8 }, () => 20_000))
    const lease = handoff.offer()!
    const onSilence = vi.fn()

    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({
        captureLease: lease,
        onSilence,
        silenceLevel: 0.05,
        silenceMs: 25
      })
    })

    // Trailing silence after begin accrues on the audio timeline (400 samples
    // = 25 ms at 16 kHz) and ends the take.
    act(() => {
      handoff.write(new Int16Array(400))
    })
    await flush()

    expect(onSilence).toHaveBeenCalledOnce()

    const recording = await stopTake(result.current.handle)

    expect(recording?.heardSpeech).toBe(true)
  })

  it('flags a take clipped by the hard ceiling as truncated — retry, never submit', async () => {
    // capSamples = (5 + 5) ms at 16 kHz = 160 samples.
    const handoff = new WakeAudioHandoff({ offerTtlMs: 5, retentionSamples: 8, utteranceCapMs: 5, now: () => 0 })
    handoff.write(ramp(1, 8))
    const lease = handoff.offer()!
    // UI startup hangs: speech accumulates past the ceiling before begin().
    handoff.write(ramp(1, 200))

    expect(lease.truncated).toBe(true)

    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ captureLease: lease })
    })

    const recording = await stopTake(result.current.handle)

    // The clip is INCOMPLETE — the caller must cancel/retry visibly.
    expect(recording?.truncated).toBe(true)
  })

  it('falls back to an ordinary stream acquisition when the lease is already terminal', async () => {
    const handoff = new WakeAudioHandoff({ now: () => 0 })
    const lease = handoff.offer()!
    lease.cancel()

    const { result } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ captureLease: lease })
    })

    // begin() returned null — the turn still works through the normal path.
    expect(getUserMediaMock()).toHaveBeenCalledOnce()

    const recording = await stopTake(result.current.handle)

    expect(recording).toMatchObject({ heardSpeech: false, meterFailed: false })
    expect(recording?.audio.type).toBe('audio/webm')
  })

  it('cancel() releases a live leased take exactly once', async () => {
    const onRelease = vi.fn()
    const handoff = new WakeAudioHandoff({ now: () => 0, onRelease })
    const lease = handoff.offer()!

    const { result, unmount } = renderHook(() => useMicRecorder(copy))

    await act(async () => {
      await result.current.handle.start({ captureLease: lease })
    })

    act(() => {
      result.current.handle.cancel()
      result.current.handle.cancel()
    })

    expect(lease.state).toBe('cancelled')
    expect(onRelease).toHaveBeenCalledOnce()
    expect(getUserMediaMock()).not.toHaveBeenCalled()

    // Unmount after the cancel must not release (or cancel) anything twice.
    unmount()
    expect(onRelease).toHaveBeenCalledOnce()
  })
})
