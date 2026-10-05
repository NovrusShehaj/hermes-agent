import { atom } from 'nanostores'

import { WakeAudioHandoff, type WakeUtteranceLease } from '@/lib/wake-audio-handoff'
import { type ClientWakeCaptureHandle, startClientWakeCapture } from '@/lib/wake-client-capture'
import { $gateway } from '@/store/gateway'

// "Hey Hermes" wake-word listener state for the composer toggle. The gateway is
// the single source of truth (the listener lives in the backend and is shared
// with the TUI under a single-owner mic lease); this atom is the renderer's
// cache of that truth, refreshed from every wake.* RPC response we see.

export interface WakeWordState {
  /** Wake word can run at all (deps + mic + key). With `enabled` false too, hides the toggle. */
  available: boolean
  /** Config truth (wake_word.enabled) — keeps the ear mounted through transient refusals. */
  enabled: boolean
  /** The listener is armed and owned by this surface. */
  listening: boolean
  /** Last failure reason/hint (start refused, unavailable, …) for the tooltip. */
  notice: string
  /** A toggle RPC is in flight — guards double-clicks. */
  pending: boolean
  /** Human-facing wake phrase, e.g. "hey hermes". */
  phrase: string
}

const INITIAL_WAKE_WORD_STATE: WakeWordState = {
  available: false,
  enabled: false,
  listening: false,
  notice: '',
  pending: false,
  phrase: ''
}

export const $wakeWord = atom<WakeWordState>(INITIAL_WAKE_WORD_STATE)

/** Active client mic stream for remote wake (capture: client). */
let clientCapture: ClientWakeCaptureHandle | null = null
/** Retention + first-utterance handoff for the active capture (one per capture). */
let activeHandoff: WakeAudioHandoff | null = null
/** The in-flight offer for the active handoff — duplicates share it. Kept
 *  through consumption as a re-mint guard: once taken/cancelled the lease is
 *  owned elsewhere and must never be offered again. */
let activeOffer: WakeUtteranceOffer | null = null
/** Monotonic capture generation: stale onError callbacks from retired
 *  captures compare theirs and bail instead of killing a replacement. */
let captureEpoch = 0
/** The transport that armed the active capture. Offered with the handoff so
 *  pause/resume/re-arm reach the OWNING socket even after `$gateway` moves
 *  (a wake may target another profile). */
let captureRequester: WakeRequester | null = null
/** False while an offer awaits consumption: its release (TTL expiry) must
 *  re-arm the ear. Set once the offer is consumed/cancelled/expired. */
let offerHandled = true

function teardownCapture(): void {
  clientCapture?.stop()
  clientCapture = null
  activeHandoff = null
  activeOffer = null
  captureRequester = null
}

/** Stop client-side PCM capture (also called on wake.detected before voice).
 *  External teardown wins over any pending offer's re-arm. */
export function stopClientCapture(): void {
  captureEpoch++
  offerHandled = true
  const handoff = activeHandoff
  activeHandoff = null
  activeOffer = null
  // Cancelling the handoff fires onRelease → teardownCapture (idempotent).
  handoff?.cancel()
  teardownCapture()
}

/** A valid wake's owner-addressed handoff: the retained pre-event PCM plus a
 *  single-use lease to the first voice utterance. `generation` keys duplicate
 *  wake events to the same handoff; `targetProfile` is the profile the wake
 *  routed to (may differ from the active profile). */
export interface WakeUtteranceOffer {
  lease: WakeUtteranceLease
  generation: number
  targetProfile: string | null
  /** The transport that armed this listener — pause/resume/re-arm for this
   *  wake go here, never to whatever `$gateway` points at later. */
  request: WakeRequester
}

/**
 * A valid wake detected: keep the mic stream alive (stop feeding the detector
 * only) and lease the retained PCM to the first voice utterance. Returns null
 * when there is no client handoff to offer (server-local capture, already
 * recording, or a terminal handoff) — the caller falls back to a plain voice
 * start. Duplicate wake events get the SAME offer for the same generation.
 */
export function offerWakeUtterance(targetProfile: string | null = null): WakeUtteranceOffer | null {
  const capture = clientCapture
  const handoff = activeHandoff
  const requester = captureRequester

  if (!capture?.active || !handoff || !requester) {
    return null
  }

  if (activeOffer) {
    return !offerHandled && activeOffer.lease.state === 'offered' ? activeOffer : null
  }

  const lease = handoff.offer()

  if (!lease) {
    return null
  }

  offerHandled = false
  // Stop detector feeding WITHOUT stopping the track — the handoff needs the
  // same capture chain to keep producing samples for the first utterance.
  capture.pauseFeed()

  activeOffer = { lease, generation: handoff.generation, targetProfile, request: requester }

  return activeOffer
}

/** Non-consuming look at the pending offer (owner gate before the start
 *  request latch is burned). */
export function peekWakeUtteranceOffer(): WakeUtteranceOffer | null {
  return !offerHandled && activeOffer?.lease.state === 'offered' ? activeOffer : null
}

/** Single consumption: the voice conversation owns re-arm from here (its end
 *  runs the config-aware reconcile), so an offer release must not re-arm. */
export function takeWakeUtteranceOffer(): WakeUtteranceOffer | null {
  const offer = peekWakeUtteranceOffer()

  if (!offer) {
    return null
  }

  offerHandled = true

  return offer
}

/** Abandon an unconsumed offer (an explicit mic start takes the device): the
 *  lease cancels, the capture chain releases, and re-arm is the caller's. */
export function cancelWakeUtteranceOffer(): void {
  const offer = peekWakeUtteranceOffer()

  if (!offer) {
    return
  }

  offerHandled = true
  activeOffer = null
  offer.lease.cancel()
}

async function maybeStartClientCapture(result: WakeStartResponse | null | undefined): Promise<void> {
  stopClientCapture()

  if (!result?.started) {
    return
  }

  const mode = (result.capture || '').toLowerCase()

  if (mode !== 'client' && mode !== 'remote' && mode !== 'external') {
    return
  }

  // Pin the transport for this capture: feed, error recovery and re-arm must
  // reach the socket that armed the listener, not whatever `$gateway` points
  // at after an async hop (profile swap, reconnect). With no transport up yet
  // there is nothing to pin — the lazy requester keeps the historical
  // fail-honest behavior (feeds fail loudly, #119089).
  const transport = $gateway.get()

  const pinnedRequester: WakeRequester = transport
    ? async <T>(method: string, params: Record<string, unknown> = {}) =>
        method === 'wake.start'
          ? transport.request<T>(method, params, WAKE_START_TIMEOUT_MS)
          : transport.request<T>(method, params)
    : gatewayRequester

  const epoch = ++captureEpoch
  captureRequester = pinnedRequester
  offerHandled = true

  let handoff: WakeAudioHandoff

  handoff = new WakeAudioHandoff({
    // Exactly-once terminal cleanup: drop buffers, track and context. An
    // offer nobody consumed (TTL expiry) re-arms the ear; a consumed one is
    // the voice conversation's to re-arm at its end.
    onRelease: () => {
      // A newer capture owns the chain now — its lifecycle is not ours.
      if (activeHandoff !== handoff) {
        return
      }

      const orphaned = !offerHandled
      offerHandled = true
      teardownCapture()

      if (orphaned) {
        void resumeWakeAfterVoice(pinnedRequester).catch(() => undefined)
      }
    }
  })

  activeHandoff = handoff

  try {
    clientCapture = await startClientWakeCapture({
      frameLength: result.frame_length,
      request: pinnedRequester,
      // Every resampled frame (silence included) feeds the retention ring so
      // the pre-event window stays gapless through feed-queue drops.
      onFrame: frame => handoff.write(frame),
      // The continuous PCM chain can die after arming (dead track, stalled
      // graph, sustained silence, refused feeds — #119089). A "listening" ear
      // that can never fire is worse than an honest off state, so mirror the
      // start-failure path: drop the capture, show the reason, release the lease.
      onError: error => {
        // Generation check: a retired capture must not kill its replacement.
        if (epoch !== captureEpoch) {
          return
        }

        stopClientCapture()
        const failed = $wakeWord.get()
        $wakeWord.set({
          ...failed,
          listening: false,
          notice: error.message,
          pending: false
        })

        // Best-effort: release server lease if client mic failed.
        void pinnedRequester('wake.stop', {}).catch(() => undefined)
      }
    })
  } catch (error) {
    const current = $wakeWord.get()
    $wakeWord.set({
      ...current,
      listening: false,
      notice: error instanceof Error ? error.message : 'Failed to open the client microphone for wake word',
      pending: false
    })

    // Best-effort: release server lease if client mic failed.
    try {
      await pinnedRequester('wake.stop', {})
    } catch {
      // ignore
    }
  }
}

export interface WakeStatusResponse {
  /** Armed but the selected backend input delivers only silence. */
  audio_silent?: boolean
  available?: boolean
  /** local | client | auto — where PCM is captured. */
  capture?: string
  configured_surface?: string
  /** Config truth (wake_word.enabled) — drives post-voice re-arm. */
  enabled?: boolean
  frame_length?: number
  hint?: string
  input_device?: WakeInputDeviceStatus
  listening?: boolean
  local_input_available?: boolean
  owned_by_caller?: boolean
  owner_surface?: string | null
  phrase?: string
  provider?: string
  sample_rate?: number
}

export interface WakeStartResponse {
  capture?: string
  enabled_persisted?: boolean
  frame_length?: number
  hint?: string
  owner_surface?: string | null
  phrase?: string
  provider?: string
  reason?: string
  sample_rate?: number
  started?: boolean
}

export interface WakeStopResponse {
  disabled_persisted?: boolean
  reason?: string | null
  stopped?: boolean
}

export interface WakeInputDeviceStatus {
  default_samplerate?: number
  error?: string
  hostapi?: string
  hostapi_index?: number
  max_input_channels?: number
  name?: string
  selector?: number | string | null
}

/** Minimal requester shape — satisfied by both `useGatewayRequest`'s
 *  `requestGateway` and the `$gateway` instance wrapper below. */
export type WakeRequester = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

// First-use wake.start lazy-installs the detection engine (onnxruntime is a
// large wheel) — that legitimately takes minutes. The default 30s WS timeout
// fired mid-install, leaving a dead button that went blue on its own later.
const WAKE_START_TIMEOUT_MS = 180_000

const gatewayRequester: WakeRequester = async <T>(method: string, params: Record<string, unknown> = {}) => {
  const gateway = $gateway.get()

  if (!gateway) {
    throw new Error('Hermes gateway unavailable')
  }

  return method === 'wake.start'
    ? gateway.request<T>(method, params, WAKE_START_TIMEOUT_MS)
    : gateway.request<T>(method, params)
}

// Friendly text for the gateway's wake refusal codes (mirrors the TUI's
// START_REASON_TEXT). Unknown codes fall through raw so new server-side
// codes stay visible instead of silently disappearing.
const REASON_TEXT: Record<string, string> = {
  disabled: 'click to enable',
  disabled_for_surface: 'scoped to another surface (config wake_word.surface)',
  not_owner: 'another surface owns the listener',
  owned: 'another surface owns the listener',
  unavailable: 'unavailable'
}

const noticeFrom = (result: { hint?: string; reason?: string | null } | null | undefined): string => {
  const hint = result?.hint?.trim()

  if (hint) {
    return hint
  }

  const reason = result?.reason?.trim()

  return reason ? (REASON_TEXT[reason] ?? reason) : ''
}

/** Sync the atom from a `wake.status` payload (mount / gateway-ready). */
export function applyWakeStatus(status: WakeStatusResponse | null | undefined): void {
  const current = $wakeWord.get()
  const listening = Boolean(status?.listening)
  // "Armed but deaf" keeps its input-device hint visible in the tooltip even
  // though the toggle shows listening.
  const silent = Boolean(status?.audio_silent)

  $wakeWord.set({
    ...current,
    available: Boolean(status?.available),
    enabled: Boolean(status?.enabled),
    listening,
    notice: listening && !silent ? '' : noticeFrom(status),
    phrase: status?.phrase?.trim() || current.phrase
  })
}

/** Sync the atom from a `wake.start` response. A `{started:false, reason}`
 *  refusal keeps the toggle off and surfaces the reason as the tooltip. */
export function applyWakeStartResult(result: WakeStartResponse | null | undefined): void {
  const current = $wakeWord.get()

  if (result?.started) {
    $wakeWord.set({
      ...current,
      available: true,
      enabled: true,
      listening: true,
      notice: '',
      pending: false,
      phrase: result.phrase?.trim() || current.phrase
    })
    void maybeStartClientCapture(result)

    return
  }

  stopClientCapture()

  $wakeWord.set({
    ...current,
    // The backend probes requirements on start; an explicit "unavailable"
    // refusal means the feature can't run here right now. Keep `enabled`
    // (config truth) as-is so the button stays mounted through transient
    // refusals instead of vanishing mid-session.
    available: result?.reason === 'unavailable' ? false : current.available,
    listening: false,
    notice: noticeFrom(result),
    pending: false
  })
}

/** Sync the atom from a `wake.stop` response. `{stopped:false, reason:'not_owner'}`
 *  still means WE are not listening, so the toggle lands on off either way. */
export function applyWakeStopResult(result: WakeStopResponse | null | undefined): void {
  const current = $wakeWord.get()

  stopClientCapture()
  $wakeWord.set({
    ...current,
    enabled: result?.disabled_persisted ? false : current.enabled,
    listening: false,
    notice: result?.stopped ? '' : noticeFrom(result),
    pending: false
  })
}

/**
 * Gateway-ready sync + auto-arm (wiring.tsx). Queries `wake.status` first so
 * the button knows availability/phrase even when arming is refused, then arms
 * the listener for this surface exactly like the historical auto-arm did.
 * Best-effort: a gateway without the wake.* methods leaves the atom at its
 * hidden default.
 */
export async function armWakeWord(request: WakeRequester = gatewayRequester): Promise<void> {
  try {
    const status = await request<WakeStatusResponse>('wake.status', {
      client_capture: true,
      surface: 'gui'
    })

    applyWakeStatus(status)

    if (!status?.available || status.listening) {
      // Armed already (e.g. another surface/restart) — reattach feeder if client.
      if (status?.listening) {
        const mode = (status.capture || '').toLowerCase()

        if (mode === 'client' || mode === 'remote' || mode === 'external') {
          void maybeStartClientCapture({
            started: true,
            capture: 'client',
            frame_length: status.frame_length ?? 1280
          })
        }
      }

      return
    }

    const result = await request<WakeStartResponse>('wake.start', {
      surface: 'gui',
      client_capture: true
    })

    applyWakeStartResult(result)
  } catch {
    // Older backends / transient failures — keep whatever we last knew.
  }
}

/** The composer button's click handler: stop when listening, start otherwise. */
export async function toggleWakeWord(request: WakeRequester = gatewayRequester): Promise<void> {
  const state = $wakeWord.get()

  if (state.pending) {
    return
  }

  $wakeWord.set({
    ...state,
    // First arm may lazy-install the detection engine — say so instead of
    // freezing a silent disabled button for the duration.
    notice: state.listening ? '' : 'arming — first use may take a minute while the engine installs',
    pending: true
  })

  try {
    if (state.listening) {
      applyWakeStopResult(await request<WakeStopResponse>('wake.stop', { persist: true }))
    } else {
      // persist: true — a deliberate click is consent, so the backend flips
      // wake_word.enabled in config.yaml (on/off) and the choice sticks for
      // future sessions. Auto-arm (armWakeWord) never passes it.
      applyWakeStartResult(
        await request<WakeStartResponse>('wake.start', {
          persist: true,
          surface: 'gui',
          client_capture: true
        })
      )
    }
  } catch (error) {
    const current = $wakeWord.get()

    $wakeWord.set({
      ...current,
      notice: error instanceof Error ? error.message : String(error),
      pending: false
    })
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Post-voice-turn reconcile: the wake word is a persistent setting, so ending a
 * voice conversation must land the listener back where config says it belongs.
 * `wake.resume` alone isn't enough — the mic can still be held by the just-torn
 * -down WebRTC capture, and a fire-and-forget resume that loses that race left
 * the ear silently off until the user re-toggled. Resume, then verify against
 * `wake.status` (config `enabled` is the authority) and re-arm, with a couple
 * of spaced retries to ride out mic-release latency. Never passes `persist` —
 * this is a passive path and must not flip config.
 */
export async function resumeWakeAfterVoice(request: WakeRequester = gatewayRequester): Promise<void> {
  try {
    await request('wake.resume', {})
  } catch {
    // Older backend without wake.* — nothing to reconcile.
    return
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const status = await request<WakeStatusResponse>('wake.status', {
        client_capture: true,
        surface: 'gui'
      })

      applyWakeStatus(status)

      // Config says off (or the feature can't run) — off is the correct rest
      // state. A user /wake off during the voice turn stays respected.
      if (!status?.enabled || !status.available) {
        return
      }

      if (status.listening) {
        // Server lease is still armed (e.g. wake.resume after voice).
        // Client PCM was stopped on wake.detected — reattach if needed.
        const mode = (status.capture || '').toLowerCase()

        if (mode === 'client' || mode === 'remote' || mode === 'external') {
          void maybeStartClientCapture({
            started: true,
            capture: 'client',
            frame_length: status.frame_length ?? 1280
          })
        }

        return
      }

      const started = await request<WakeStartResponse>('wake.start', {
        surface: 'gui',
        client_capture: true
      })

      applyWakeStartResult(started)

      if (started?.started) {
        return
      }

      // Another surface holds the mic lease — theirs to keep.
      if (started?.reason === 'owned') {
        return
      }
    } catch {
      // Transient (mic still releasing) — fall through to the next attempt.
    }

    await sleep(1500)
  }
}

/** Test-only reset. */
export function resetWakeWordState(): void {
  stopClientCapture()
  offerHandled = true
  $wakeWord.set(INITIAL_WAKE_WORD_STATE)
}
