// Issue #119089: a dead client PCM chain must land the ear in an honest off
// state with the reason visible — not a "listening" toggle that can never fire.
// Phase 3 (#131518): the same capture chain now carries the first-utterance
// handoff — one offer per wake, pinned to the transport that armed the ear,
// single-use, and never re-minted after consumption.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CaptureOptions = {
  frameLength?: number
  onError?: (error: Error) => void
  onFrame?: (frame: Int16Array) => void
  pauseFeed?: () => void
  request?: (method: string, params?: Record<string, unknown>) => Promise<unknown>
}

const capture = vi.hoisted(() => ({
  options: null as CaptureOptions | null,
  calls: [] as CaptureOptions[],
  pauseFeed: vi.fn(),
  stop: vi.fn()
}))

vi.mock('@/lib/wake-client-capture', () => ({
  startClientWakeCapture: vi.fn(async (options: CaptureOptions) => {
    capture.options = options
    capture.calls.push(options)

    return { active: true, pauseFeed: capture.pauseFeed, stop: capture.stop }
  })
}))

import { $gateway } from '@/store/gateway'

import {
  $wakeWord,
  applyWakeStartResult,
  cancelWakeUtteranceOffer,
  offerWakeUtterance,
  peekWakeUtteranceOffer,
  resetWakeWordState,
  takeWakeUtteranceOffer
} from './wake-word'

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const originalGateway = $gateway.get()

function fakeTransport() {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'wake.status') {
      // Config says the ear belongs OFF — a stale re-arm must respect it.
      return { available: true, enabled: false, listening: false, phrase: 'hey hermes' }
    }

    return { stopped: true, method, params }
  })

  return { request }
}

beforeEach(() => {
  capture.options = null
  capture.calls = []
  capture.pauseFeed.mockClear()
  capture.stop.mockClear()
  resetWakeWordState()
})

afterEach(() => {
  $gateway.set(originalGateway)
  vi.useRealTimers()
})

describe('client capture failure surfacing (issue #119089)', () => {
  it('lands the ear off with the reason when the PCM chain dies after arming', async () => {
    applyWakeStartResult({ capture: 'client', frame_length: 1280, phrase: 'hey hermes', started: true })
    await flush()

    expect($wakeWord.get()).toMatchObject({ listening: true, notice: '' })
    expect(capture.options?.onError).toBeTypeOf('function')

    capture.options?.onError?.(new Error('client wake capture hears only silence'))

    expect(capture.stop).toHaveBeenCalled()
    expect($wakeWord.get()).toMatchObject({
      listening: false,
      notice: 'client wake capture hears only silence'
    })
  })
})

describe('wake handoff offer orchestration (#131518)', () => {
  const arm = async (transport = fakeTransport()) => {
    $gateway.set(transport as never)
    applyWakeStartResult({ capture: 'client', frame_length: 1280, phrase: 'hey hermes', started: true })
    await flush()

    return transport
  }

  it('mints one offer per wake and never re-mints a consumed lease', async () => {
    await arm()

    const offer = offerWakeUtterance()

    expect(offer).not.toBeNull()
    // Duplicate wake events share the SAME offer (same generation) instead of
    // minting a second lease over the same retained PCM.
    expect(offerWakeUtterance()).toBe(offer)
    expect(peekWakeUtteranceOffer()).toBe(offer)
    // Pauses detector feeding WITHOUT stopping the capture chain — the lease
    // needs the same mic to keep producing the first utterance's samples.
    expect(capture.pauseFeed).toHaveBeenCalledOnce()

    expect(takeWakeUtteranceOffer()).toBe(offer)
    // Consumed: peek and take are dry, and the same lease is never offered
    // again — the voice conversation owns it now.
    expect(peekWakeUtteranceOffer()).toBeNull()
    expect(takeWakeUtteranceOffer()).toBeNull()
    expect(offerWakeUtterance()).toBeNull()
  })

  it('pins the wake to the transport that armed the ear, not ambient $gateway', async () => {
    const armTransport = fakeTransport()
    await arm(armTransport)

    const offer = offerWakeUtterance()
    expect(offer).not.toBeNull()

    // The socket moves (profile swap / reconnect) after the wake.
    const other = fakeTransport()
    $gateway.set(other as never)

    await offer?.request('wake.resume', {})

    expect(armTransport.request).toHaveBeenCalledWith('wake.resume', {})
    expect(other.request).not.toHaveBeenCalled()
  })

  it('re-arms an expired unconsumed offer on the owning transport and respects wake-off', async () => {
    vi.useFakeTimers()
    const armTransport = fakeTransport()
    $gateway.set(armTransport as never)
    applyWakeStartResult({ capture: 'client', frame_length: 1280, phrase: 'hey hermes', started: true })
    await vi.advanceTimersByTimeAsync(0)

    const offer = offerWakeUtterance()
    expect(offer).not.toBeNull()

    const other = fakeTransport()
    $gateway.set(other as never)

    // Nobody consumed the offer — the TTL releases it and the orphaned
    // handoff re-arms the ear through the transport that armed it.
    await vi.advanceTimersByTimeAsync(11_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(capture.stop).toHaveBeenCalled()
    expect(armTransport.request).toHaveBeenCalledWith('wake.resume', {})
    // The reconcile ran, saw enabled:false — the stale re-arm must NOT
    // restart the listener over an explicit wake-off.
    expect(armTransport.request).toHaveBeenCalledWith('wake.status', expect.anything())
    expect(armTransport.request.mock.calls.some(([method]) => method === 'wake.start')).toBe(false)
    expect(other.request).not.toHaveBeenCalled()
    expect($wakeWord.get().listening).toBe(false)
  })

  it('cancelling an offer releases the lease and leaves re-arm to the caller', async () => {
    const armTransport = fakeTransport()
    await arm(armTransport)

    const offer = offerWakeUtterance()
    expect(offer).not.toBeNull()

    cancelWakeUtteranceOffer()

    expect(offer?.lease.state).toBe('cancelled')
    expect(capture.stop).toHaveBeenCalled()
    // An explicit start owns re-arm — the offer release itself must not fire
    // wake.resume (it was handled, not orphaned).
    expect(armTransport.request).not.toHaveBeenCalledWith('wake.resume', {})
  })

  it('retires the previous capture on re-arm and its stale onError cannot kill the replacement', async () => {
    await arm()
    expect(capture.calls).toHaveLength(1)

    applyWakeStartResult({ capture: 'client', frame_length: 1280, phrase: 'hey hermes', started: true })
    await flush()

    // The first capture was retired exactly once; one live chain remains.
    expect(capture.calls).toHaveLength(2)
    expect(capture.stop).toHaveBeenCalledTimes(1)

    // A late error from the RETIRED capture must not kill its replacement.
    capture.calls[0]?.onError?.(new Error('stale failure from a dead chain'))

    expect(capture.stop).toHaveBeenCalledTimes(1)
    expect($wakeWord.get()).toMatchObject({ listening: true, notice: '' })
  })
})
