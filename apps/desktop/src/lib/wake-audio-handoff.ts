/**
 * Bounded pre-event audio retention + single-owner first-utterance handoff.
 *
 * The wake detector runs remotely: the desktop streams 16 kHz frames to
 * `wake.feed`, and `wake.detected` arrives only after detector + network
 * latency — speech spoken in that window (and during desktop voice startup)
 * is lost if the mic stops at the event. This module keeps the loss out:
 *
 *  - a bounded RING retains the locally captured samples before the feed
 *    queue (which drops old frames under latency) ever sees them;
 *  - on a valid wake the source stream stays alive, detector feeding stops,
 *    and ONE capture lease is offered to the first voice utterance;
 *  - the utterance is a single continuous PCM segment — the entire retained
 *    window plus everything captured since the wake, each sample exactly
 *    once — encoded once as mono PCM WAV for the existing transcription
 *    routes (joining raw PCM to an encoded MediaRecorder blob produces an
 *    invalid file, so the leased take never touches MediaRecorder).
 *
 * States are explicit and single-owner: listening → offered →
 * recording-first-utterance → stopped/cancelled. Duplicate wake events,
 * stop/start/re-arm and stale callbacks are generation-checked: an offer can
 * be consumed exactly once, and every terminal path releases buffers exactly
 * once through `onRelease`.
 *
 * Bounds (memory is finite even if UI startup hangs or silence never comes):
 *  - retention ring: `WAKE_RETENTION_SAMPLES` (5 s of 16 kHz mono int16,
 *    160,000 bytes) of pre-event audio;
 *  - unconsumed offer: `WAKE_OFFER_TTL_MS` — after that the offer is
 *    cancelled and its stream released;
 *  - first-utterance capture: `WAKE_UTTERANCE_HARD_CEILING_MS`, with the
 *    continuation capped at the ceiling plus the offer TTL as a pure memory
 *    backstop. Hitting a limit marks the take `truncated` — callers must
 *    cancel/retry visibly, never submit a truncated clip as complete.
 *
 * No UI or profile orchestration lives here; the wake store owns offer
 * timing and the capture stream, the recorder owns policy.
 */

/** Wire / ring / WAV sample rate — matches tools/wake_word.py's engine feed. */
export const WAKE_SAMPLE_RATE = 16_000

/** Pre-event retention: 5 s of mono int16 = 80,000 samples = 160,000 bytes. */
export const WAKE_RETENTION_SAMPLES = WAKE_SAMPLE_RATE * 5

/** An offer nobody consumes within this window is abandoned and released. */
export const WAKE_OFFER_TTL_MS = 10_000

/** Hard ceiling for one leased first utterance (mirrors the voice loop's
 *  60 s turn cap — the "existing configured recording cap"). */
export const WAKE_UTTERANCE_HARD_CEILING_MS = 60_000

/** int16 RMS → the level meter's normalized scale. The recorder's meter reads
 *  byte-domain RMS/42 (centered bytes ≈ float × 128), so a float RMS maps to
 *  `rms_float × 128 / 42` = `rms_int16 / 10752` — the same conversion
 *  voice-barge-in documents (int16 RMS 1500/4000 ≈ 0.14/0.37). The leased
 *  path feeds the recorder's silence policy through this, never raw RMS. */
export const PCM_METER_DIVISOR = 10_752

/** Normalized level (0..1) in the same scale the recorder's level meter
 *  produces, computed from raw int16 PCM. */
export function pcmInt16Level(pcm: Int16Array): number {
  if (pcm.length === 0) {
    return 0
  }

  let sum = 0

  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i]
    sum += sample * sample
  }

  return Math.min(1, Math.sqrt(sum / pcm.length) / PCM_METER_DIVISOR)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

/** One continuous mono PCM segment as a valid 16-bit WAV — the format the
 *  existing transcription routes already accept. Little-endian throughout,
 *  regardless of host endianness. */
export function encodePcmWavMono(pcm: Int16Array, sampleRate = WAKE_SAMPLE_RATE): Blob {
  const dataBytes = pcm.length * 2
  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  const body = new ArrayBuffer(dataBytes)
  const bodyView = new DataView(body)

  for (let i = 0; i < pcm.length; i++) {
    bodyView.setInt16(i * 2, pcm[i], true)
  }

  return new Blob([header, body], { type: 'audio/wav' })
}

/**
 * Fixed-capacity int16 sample ring with a monotonic write cursor. Oldest
 * samples are overwritten past capacity; `copyFrom` clamps to what still
 * exists so a reader can never see a gap inside the retained window.
 */
export class WakeAudioRing {
  private readonly capacity: number
  private readonly buf: Int16Array
  /** Total samples ever pushed — the monotonic sample cursor. */
  private written = 0
  private retained = 0

  constructor(capacity = WAKE_RETENTION_SAMPLES) {
    this.capacity = Math.max(1, Math.trunc(capacity))
    this.buf = new Int16Array(this.capacity)
  }

  get totalSamples(): number {
    return this.written
  }

  get retainedSamples(): number {
    return this.retained
  }

  get retainedBytes(): number {
    return this.retained * 2
  }

  push(pcm: Int16Array): void {
    for (let i = 0; i < pcm.length; i++) {
      this.buf[this.written % this.capacity] = pcm[i]
      this.written += 1
    }

    this.retained = Math.min(this.capacity, this.retained + pcm.length)
  }

  /** Every retained sample at/after `fromCursor`, in capture order — each
   *  sample exactly once. Cursors older than the ring still hold are clamped
   *  to the oldest retained sample. */
  copyFrom(fromCursor: number): Int16Array {
    const start = Math.max(fromCursor, this.written - this.retained)
    const end = this.written

    if (end <= start) {
      return new Int16Array(0)
    }

    const out = new Int16Array(end - start)

    for (let i = start; i < end; i++) {
      out[i - start] = this.buf[i % this.capacity]
    }

    return out
  }

  /** Drop the retained audio. The write cursor keeps counting so cursors
   *  handed out earlier stay meaningful (and clamp to "nothing retained"). */
  clear(): void {
    this.retained = 0
  }
}

export type WakeHandoffState = 'listening' | 'offered' | 'recording-first-utterance' | 'stopped' | 'cancelled'

/**
 * The single-use lease handed to the first voice utterance. `begin()` is the
 * consume: it snapshots the retained window plus everything captured since
 * the wake, and only listeners registered afterwards see later samples — so
 * a caller that subscribes in the same synchronous block gets a gapless,
 * duplicate-free stream.
 */
export interface WakeUtteranceLease {
  readonly generation: number
  readonly state: WakeHandoffState
  /** Hard ceiling clipped the capture — the take is incomplete and must be
   *  cancelled/retried visibly, never submitted as a complete transcript. */
  readonly truncated: boolean
  /** Single-use (offered → recording). Returns the retained snapshot, or
   *  null when the lease cannot start (already begun, stopped, cancelled). */
  begin(): Int16Array | null
  /** Live continuation chunks pushed after `begin()`. */
  onSamples(listener: (pcm: Int16Array) => void): () => void
  /** Terminal (idempotent): the utterance is complete — release everything. */
  finish(): void
  /** Terminal (idempotent): abandon the handoff — release everything. */
  cancel(): void
}

export interface WakeAudioHandoffOptions {
  retentionSamples?: number
  offerTtlMs?: number
  utteranceCapMs?: number
  sampleRate?: number
  now?: () => number
  /** Called exactly once when the handoff reaches a terminal state — the
   *  owner releases the capture stream here. */
  onRelease?: () => void
}

let nextHandoffGeneration = 0

/**
 * One capture's retention + first-utterance handoff state machine. Fed by the
 * client capture (`write`, every resampled frame including silence), offered
 * on a valid wake (`offer`), consumed exactly once by the first voice
 * utterance (`lease.begin()`).
 */
export class WakeAudioHandoff {
  readonly generation = ++nextHandoffGeneration

  private readonly ring: WakeAudioRing
  private readonly sampleRate: number
  private readonly offerTtlMs: number
  private readonly capSamples: number
  private readonly now: () => number
  private readonly onRelease: (() => void) | undefined

  private current: WakeHandoffState = 'listening'
  private offeredAt = 0
  private ttlTimer: ReturnType<typeof setTimeout> | undefined
  private released = false
  private truncatedFlag = false

  /** Continuation between offer and begin — everything the ring must not
   *  double-count (post-offer writes never re-enter the ring). */
  private continuation: Int16Array[] = []
  private continuationSamples = 0
  private listeners = new Set<(pcm: Int16Array) => void>()
  private begun = false
  readonly lease: WakeUtteranceLease

  constructor(options: WakeAudioHandoffOptions = {}) {
    this.sampleRate = Math.max(1, Math.trunc(options.sampleRate ?? WAKE_SAMPLE_RATE))
    this.ring = new WakeAudioRing(options.retentionSamples ?? WAKE_RETENTION_SAMPLES)
    this.offerTtlMs = Math.max(1, Math.trunc(options.offerTtlMs ?? WAKE_OFFER_TTL_MS))
    const utteranceCapMs = Math.max(1, Math.trunc(options.utteranceCapMs ?? WAKE_UTTERANCE_HARD_CEILING_MS))

    this.capSamples = Math.trunc(((this.offerTtlMs + utteranceCapMs) / 1000) * this.sampleRate)
    this.now = options.now ?? (() => Date.now())
    this.onRelease = options.onRelease

    // The lease closes over the instance so callers can hold it without
    // reaching back into the handoff.
    const self = this

    this.lease = {
      get generation() {
        return self.generation
      },
      get state() {
        return self.current
      },
      get truncated() {
        return self.truncatedFlag
      },
      begin: () => self.beginLease(),
      onSamples: listener => self.subscribe(listener),
      finish: () => self.finish(),
      cancel: () => self.cancel()
    }
  }

  get state(): WakeHandoffState {
    return this.current
  }

  get truncated(): boolean {
    return this.truncatedFlag
  }

  /** Every resampled 16 kHz frame, silent frames included: the retained audio
   *  must be gapless even though the feed queue drops silence and backlog. */
  write(pcm: Int16Array): void {
    if (this.current === 'stopped' || this.current === 'cancelled') {
      return
    }

    if (this.current === 'listening') {
      this.ring.push(pcm)

      return
    }

    if (!this.begun) {
      // Offered but not yet consumed: hold for the eventual begin() snapshot.
      if (this.continuationSamples + pcm.length > this.capSamples) {
        this.truncatedFlag = true

        return
      }

      this.continuation.push(pcm)
      this.continuationSamples += pcm.length

      return
    }

    // Recording: the recorder owns the take's storage; just deliver.
    for (const listener of this.listeners) {
      listener(pcm)
    }
  }

  /** A valid wake: listening → offered. A duplicate wake during the offer
   *  window returns the SAME lease (idempotent, TTL not reset); once the
   *  first utterance owns the mic (or the handoff is terminal) no new lease
   *  is minted — the caller falls back to the ordinary voice start. */
  offer(): WakeUtteranceLease | null {
    if (this.current === 'offered') {
      return this.lease
    }

    if (this.current !== 'listening') {
      return null
    }

    this.current = 'offered'
    this.offeredAt = this.now()
    this.ttlTimer = setTimeout(() => this.expireIfDue(), this.offerTtlMs)

    return this.lease
  }

  /** TTL guard — also wired to a timer; safe to call at any time. */
  expireIfDue(): void {
    if (this.current === 'offered' && this.now() - this.offeredAt >= this.offerTtlMs) {
      this.cancel()
    }
  }

  finish(): void {
    if (this.current === 'stopped' || this.current === 'cancelled') {
      return
    }

    this.current = 'stopped'
    this.release()
  }

  cancel(): void {
    if (this.current === 'stopped' || this.current === 'cancelled') {
      return
    }

    this.current = 'cancelled'
    this.release()
  }

  /** Idempotent full teardown: buffers, listeners, TTL timer, then exactly
   *  one `onRelease` so the owner can drop the stream/context. */
  private release(): void {
    if (this.ttlTimer !== undefined) {
      clearTimeout(this.ttlTimer)
      this.ttlTimer = undefined
    }

    this.ring.clear()
    this.continuation = []
    this.continuationSamples = 0
    this.listeners.clear()

    if (!this.released) {
      this.released = true
      this.onRelease?.()
    }
  }

  private beginLease(): Int16Array | null {
    if (this.current !== 'offered' || this.begun) {
      return null
    }

    this.begun = true
    this.current = 'recording-first-utterance'

    if (this.ttlTimer !== undefined) {
      clearTimeout(this.ttlTimer)
      this.ttlTimer = undefined
    }

    // The ENTIRE retained prefix is preserved — the current protocol has no
    // phrase-end cursor, so a short wake-phrase lead-in rides along by
    // design and no matching words are ever stripped from user audio.
    const prefix = this.ring.copyFrom(0)
    const snapshot = new Int16Array(prefix.length + this.continuationSamples)
    let offset = 0

    snapshot.set(prefix, offset)
    offset += prefix.length

    for (const chunk of this.continuation) {
      snapshot.set(chunk, offset)
      offset += chunk.length
    }

    this.continuation = []
    this.continuationSamples = 0

    return snapshot
  }

  private subscribe(listener: (pcm: Int16Array) => void): () => void {
    if (this.current === 'stopped' || this.current === 'cancelled') {
      return () => undefined
    }

    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }
}
