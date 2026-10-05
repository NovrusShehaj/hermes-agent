import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { type ChatMessage, collectUnspokenTurnSpeech } from '@/lib/chat-messages'
import { stopVoicePlayback } from '@/lib/voice-playback'
import type { WakeUtteranceLease } from '@/lib/wake-audio-handoff'
import { notifyError } from '@/store/notifications'
import { $autoSpeakReplies } from '@/store/voice-prefs'

import { useVoiceConversation } from './use-voice-conversation'

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  mic: {
    cancel: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({
      audio: new Blob(['fixture']),
      heardSpeech: true,
      durationMs: 900,
      truncated: false
    }))
  }
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getApiRequestConnection: () => null,
  getApiRequestProfile: () => null,
  hermesApi: mocks.config,
  speakText: vi.fn()
}))
vi.mock('@/api/client', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerScoped: (value: unknown) => value ?? {},
  profileScoped: (value: unknown) => value
}))
vi.mock('./use-mic-recorder', () => ({ useMicRecorder: () => ({ handle: mocks.mic, level: 0 }) }))
vi.mock('@/lib/voice-barge-in', () => ({ monitorSpeechDuringPlayback: () => vi.fn() }))
vi.mock('@/lib/thinking-sound', () => ({ startThinkingSound: vi.fn(), stopThinkingSound: vi.fn() }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: { notifications: { voice: { recordingFailed: 'recording failed', tryRecordingAgain: 'try again' } } }
  })
}))

class TestAudio extends EventTarget {
  static instances: TestAudio[] = []
  src: string
  constructor(src: string) {
    super()
    this.src = src
    TestAudio.instances.push(this)
  }
  play = vi.fn(async () => undefined)
  pause = vi.fn()
  load = vi.fn()
}

afterEach(() => {
  $autoSpeakReplies.set(false)
  cleanup()
  stopVoicePlayback()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('speaks a sealed narration while busy and keeps the session open for the final reply', async () => {
  // This test drives the TTS playback path, gated by the read-aloud toggle
  // (#44263); opt in like the app does when replies are spoken.
  $autoSpeakReplies.set(true)
  vi.useFakeTimers()
  TestAudio.instances = []
  vi.stubGlobal('Audio', TestAudio)
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:fixture')
      static revokeObjectURL = vi.fn()
    }
  )
  mocks.config.mockResolvedValue({
    ok: true,
    stt: { mode: 'relay' },
    tts: {
      mode: 'direct',
      wire: 'openai-speech',
      provider: 'openai',
      base_url: 'https://tts.invalid/v1',
      api_key: 'fixture-only',
      model: 'tts-fixture',
      voice: 'fixture',
      speed: null
    }
  })
  const inputs: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      inputs.push(JSON.parse(options.body as string).input)

      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }
    })
  )
  const narration = 'Let me check the live state of the branch.'
  const answer = 'The branch is clean and the check is complete.'
  const messages: ChatMessage[] = []

  const hook = renderHook(
    ({ busy }) =>
      useVoiceConversation({
        busy,
        enabled: true,
        consumePendingResponse: vi.fn(),
        onSubmit: vi.fn(async () => {
          hook.rerender({ busy: true })
        }),
        onTranscribeAudio: async () => 'Check the branch',
        pendingResponse: () => collectUnspokenTurnSpeech(messages, null)
      }),
    { initialProps: { busy: false } }
  )

  await act(async () => {
    await hook.result.current.start()
  })
  await act(async () => {
    hook.result.current.stopTurn()
  })
  messages.push({ id: 'narration', role: 'assistant', pending: true, parts: [{ type: 'text', text: narration }] })
  hook.rerender({ busy: true })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(inputs).toEqual([])
  messages[0].pending = false
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(inputs).toEqual([narration])
  expect(TestAudio.instances[0].play).toHaveBeenCalledOnce()
  await act(async () => {
    TestAudio.instances[0].dispatchEvent(new Event('ended'))
  })
  expect(mocks.mic.start).toHaveBeenCalledTimes(1)
  messages.push({ id: 'answer', role: 'assistant', pending: false, parts: [{ type: 'text', text: answer }] })
  hook.rerender({ busy: false })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(inputs).toEqual([narration, answer])
})

// Phase 3 (#131518): the wake handoff's retained PCM is the FIRST take only —
// single-consumption across the conversation's turns.
it('hands the wake handoff to the first take only; the next turn records normally', async () => {
  mocks.mic.start.mockClear()
  mocks.mic.stop.mockClear()

  const lease = {
    begin: vi.fn(() => null),
    cancel: vi.fn(),
    finish: vi.fn(),
    generation: 3,
    onSamples: vi.fn(() => () => undefined),
    state: 'offered',
    truncated: false
  } as unknown as WakeUtteranceLease

  let handed = false

  const captureLease = vi.fn((): WakeUtteranceLease | null => {
    if (handed) {
      return null
    }

    handed = true

    return lease
  })

  const transcribe = vi.fn(async () => 'hello there')
  const onSubmit = vi.fn(async () => undefined)

  const hook = renderHook(() =>
    useVoiceConversation({
      busy: false,
      captureLease,
      consumePendingResponse: vi.fn(),
      enabled: true,
      onSubmit,
      onTranscribeAudio: transcribe,
      pendingResponse: () => null
    })
  )

  await act(async () => {
    await hook.result.current.start()
  })

  // The leased PCM IS the first recording — it rides the take's start.
  expect(mocks.mic.start).toHaveBeenCalledTimes(1)
  expect(mocks.mic.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ captureLease: lease }))

  await act(async () => {
    hook.result.current.stopTurn()
  })
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  expect(transcribe).toHaveBeenCalledTimes(1)

  // The next turn records normally — the handoff was single-consumption.
  await waitFor(() => expect(mocks.mic.start).toHaveBeenCalledTimes(2))
  expect(mocks.mic.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ captureLease: undefined }))

  await act(async () => {
    hook.result.current.end()
  })
})

// A hard-ceiling-clipped take is incomplete by construction: cancel it visibly
// and retry — never transcribe or submit a truncated transcript as complete.
it('never submits a truncated wake take and re-arms for a clean retry', async () => {
  mocks.mic.start.mockClear()
  mocks.mic.stop.mockClear()
  vi.mocked(notifyError).mockClear()
  mocks.mic.stop.mockResolvedValueOnce({
    audio: new Blob(['clip']),
    durationMs: 400,
    heardSpeech: true,
    truncated: true
  })
  const transcribe = vi.fn(async () => 'partial words')
  const onSubmit = vi.fn(async () => undefined)

  const hook = renderHook(() =>
    useVoiceConversation({
      busy: false,
      consumePendingResponse: vi.fn(),
      enabled: true,
      onSubmit,
      onTranscribeAudio: transcribe,
      pendingResponse: () => null
    })
  )

  await act(async () => {
    await hook.result.current.start()
  })
  await act(async () => {
    hook.result.current.stopTurn()
  })

  // The failure is VISIBLE ("try again"), and the clipped audio goes nowhere.
  await waitFor(() => expect(notifyError).toHaveBeenCalledWith(expect.any(Error), 'recording failed'))
  expect(transcribe).not.toHaveBeenCalled()
  expect(onSubmit).not.toHaveBeenCalled()

  // The ear re-arms so the user can retry with a clean recording.
  await waitFor(() => expect(mocks.mic.start).toHaveBeenCalledTimes(2))

  await act(async () => {
    hook.result.current.end()
  })
})
