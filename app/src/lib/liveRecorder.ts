import { ApiError } from './api'
import { isNative } from './native'
import { putLiveSlice, startLiveMeeting, stopLiveMeeting } from './meetingsApi'
import type { Meeting } from '../proto.gen'

// Records the microphone for a live meeting: one MediaRecorder for the whole meeting (never restarted, so the
// hub receives one continuous WebM stream), cut into 15 s slices that are uploaded one at a time, in order.
// Only the lazy meeting screens import this module.

const SLICE_MS = 15000
const BACKOFF_FIRST_MS = 1000
const BACKOFF_MAX_MS = 15000

export interface SliceUploader {
  add(seq: number, b: Blob): void
  /** Resolves when every added slice is stored; rejects with the hub's message when the upload stopped. */
  flush(): Promise<void>
  /** Slices not stored yet (the one being sent included). */
  pending(): number
  /** The hub's message once the upload stopped on a permanent error; '' otherwise. */
  error(): string
  /** The last transient failure (e.g. "disk full", "network"), kept while retrying and cleared on the next success. */
  lastError(): string
  subscribe(fn: () => void): () => void
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Network errors, 5xx, 408 and 429 are retried; any other 4xx is permanent. */
const retryable = (e: unknown) => {
  if (!(e instanceof ApiError)) return true
  const s = e.status
  return s === 408 || s === 429 || s >= 500
}

/**
 * Sends slices one at a time in seq order. A retryable failure waits 1 s, doubling up to 15 s, for as long as
 * the page is open; a permanent one stops the upload with the hub's message. A blob is dropped once stored.
 */
export function createSliceUploader(put: (seq: number, b: Blob) => Promise<unknown>, sleep: (ms: number) => Promise<void> = realSleep): SliceUploader {
  const queue = new Map<number, Blob>()
  const subs = new Set<() => void>()
  const waiters: Array<{ ok: () => void; fail: (e: Error) => void }> = []
  let err = ''
  let last = ''
  let running = false
  const emit = () => subs.forEach(fn => { try { fn() } catch { /* a listener must not break the upload */ } })
  const settle = () => {
    if (err) waiters.splice(0).forEach(w => w.fail(new Error(err)))
    else if (queue.size === 0) waiters.splice(0).forEach(w => w.ok())
  }
  const run = async () => {
    if (running) return
    running = true
    let wait = BACKOFF_FIRST_MS
    try {
      while (queue.size > 0 && !err) {
        const seq = Math.min(...queue.keys())
        try {
          await put(seq, queue.get(seq)!)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!retryable(e)) { err = msg; last = ''; emit(); break }
          last = msg
          emit()
          await sleep(wait)
          wait = Math.min(wait * 2, BACKOFF_MAX_MS)
          continue
        }
        queue.delete(seq)
        last = ''
        wait = BACKOFF_FIRST_MS
        emit()
      }
    } finally {
      running = false
      settle()
    }
  }
  return {
    add(seq, b) { queue.set(seq, b); emit(); void run() },
    flush() {
      if (err) return Promise.reject(new Error(err))
      if (queue.size === 0) return Promise.resolve()
      return new Promise<void>((ok, fail) => { waiters.push({ ok, fail }); void run() })
    },
    pending: () => queue.size,
    error: () => err,
    lastError: () => last,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } },
  }
}

// --- Keeping the screen on ---

type Sentinel = { release(): Promise<void> }
let sentinel: Sentinel | null = null
let wantAwake = false
let visHandler: (() => void) | null = null

const nativeBridge = () => (globalThis as { window?: { Capacitor?: { nativePromise?: (p: string, m: string, o: object) => Promise<unknown> } } }).window?.Capacitor

async function requestWake() {
  try {
    const wl = (navigator as { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock
    if (!wl) return
    const s = await wl.request('screen')
    if (!wantAwake) { await s.release().catch(() => {}); return }
    const old = sentinel
    sentinel = s
    if (old && old !== s) await old.release().catch(() => {})
  } catch { /* denied or not supported: the screen may lock */ }
}

/** Keeps the screen on while recording: the HubShell flag in the Android app, the Wake Lock API elsewhere. Never throws. */
export async function keepScreenOn(on: boolean): Promise<void> {
  try {
    const cap = nativeBridge()
    if (isNative() && cap?.nativePromise) {
      await cap.nativePromise('HubShell', 'keepScreenOn', { on })
      return
    }
    wantAwake = on
    if (on) {
      if (typeof document !== 'undefined' && !visHandler) {
        visHandler = () => { if (wantAwake && document.visibilityState === 'visible') void requestWake() }
        document.addEventListener('visibilitychange', visHandler)
      }
      await requestWake()
    } else {
      if (visHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', visHandler)
      visHandler = null
      const s = sentinel
      sentinel = null
      await s?.release()
    }
  } catch { /* best effort */ }
}

// --- Recording ---

export type RecorderState = 'recording' | 'stopping' | 'stopped' | 'failed'

export interface LiveRecording {
  meetingId: string
  startedAt: number
  state: RecorderState
  error: string
  pending: number
  /** The uploader's last transient error while it retries ("" when none); cleared on the next stored slice. */
  lastError: string
  /** True once the uploader gave up on a permanent error: what is pending will not be sent. */
  uploadStopped: boolean
  subscribe(fn: () => void): () => void
  stop(): Promise<Meeting>
}

let current: LiveRecording | null = null

export const currentRecording = (): LiveRecording | null => current

// A recording that failed is no longer `current`, but the meeting screen still needs its message and its
// pending count until the meeting is stopped or the failure is dismissed.
const failed = new Map<string, LiveRecording>()

/** The recording of this meeting on this device: the active one, or the failed one kept for the screen. */
export const recordingFor = (meetingId: string): LiveRecording | null =>
  current?.meetingId === meetingId ? current : failed.get(meetingId) ?? null

/** Forgets a failed recording (the meeting was stopped, or the person dismissed the message). */
export const dismissRecording = (meetingId: string) => { failed.delete(meetingId) }

const MIME = 'audio/webm;codecs=opus'

/** Best effort: ends a live meeting that never recorded, so it does not sit in `live` until the hub's idle stop. */
const abandon = (id: string) => { void stopLiveMeeting(id, { slices: 0 }).catch(() => {}) }

/**
 * Checks the secure context, Opus support and the microphone, in that order, and only then creates the live
 * meeting and starts recording. Throws an Error with a message ready to show.
 */
export async function startLiveRecording(opts: { projectId?: string; title?: string; language?: string }): Promise<LiveRecording> {
  if (current) throw new Error('A recording is already in progress.')
  if (!globalThis.isSecureContext) throw new Error('Recording needs the hub over HTTPS.')
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(MIME)) throw new Error('This browser cannot record Opus audio.')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('Microphone access was denied. Allow it in the browser or app settings.')
    throw new Error(name === 'NotFoundError' ? 'No microphone was found.' : 'The microphone could not be opened.')
  }
  const releaseTracks = () => stream.getTracks().forEach(t => t.stop())

  const startedAt = Date.now()
  let meeting: Meeting
  try {
    meeting = await startLiveMeeting({ ...opts, startedAt })
  } catch (e) {
    releaseTracks()
    throw e
  }

  const id = meeting.id
  const uploader = createSliceUploader((seq, b) => putLiveSlice(id, seq, b))
  const subs = new Set<() => void>()
  const emit = () => subs.forEach(fn => { try { fn() } catch { /* ignore */ } })
  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 48000 })
  } catch (e) {
    releaseTracks()
    abandon(id)
    throw e
  }
  let slices = 0
  let stopped!: Promise<void>
  let stopping: Promise<Meeting> | null = null

  const r: LiveRecording = {
    meetingId: id, startedAt, state: 'recording', error: '', pending: 0, lastError: '', uploadStopped: false,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } },
    stop() { return stopping ??= doStop() },
  }
  const cleanup = () => {
    releaseTracks()
    void keepScreenOn(false)
    if (r.state === 'failed') failed.set(id, r)
    else failed.delete(id)
    updateUnload()
    if (current === r) current = null
  }
  // the page-close warning stays while the recording runs or a failed one still has slices to upload
  let warning = false
  const updateUnload = () => {
    if (typeof window === 'undefined') return
    const want = r.state === 'recording' || r.state === 'stopping' || (r.state === 'failed' && r.pending > 0 && !r.uploadStopped)
    if (want && !warning) window.addEventListener('beforeunload', onUnload)
    else if (!want && warning) window.removeEventListener('beforeunload', onUnload)
    warning = want
  }
  const onUnload = (e: Event) => { e.preventDefault(); (e as unknown as { returnValue: string }).returnValue = '' }
  const fail = (msg: string) => {
    if (r.state === 'failed' || r.state === 'stopped') return
    r.state = 'failed'
    r.error = msg
    if (rec.state !== 'inactive') { try { rec.stop() } catch { /* already stopped */ } }
    cleanup()
    emit()
  }
  const doStop = async (): Promise<Meeting> => {
    if (r.state === 'recording') {
      r.state = 'stopping'
      emit()
      if (rec.state !== 'inactive') rec.stop()
      await stopped
    }
    try {
      if (r.state === 'failed') throw new Error(r.error)
      await uploader.flush()
      let m: Meeting
      try {
        m = await stopLiveMeeting(id, { slices })
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && Array.isArray(e.data?.missing)) m = await stopLiveMeeting(id, { slices, force: true })
        else throw e
      }
      r.state = 'stopped'
      return m
    } catch (e) {
      r.state = 'failed'
      r.error = r.error || (e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      cleanup()
      emit()
    }
  }

  stopped = new Promise<void>(res => rec.addEventListener('stop', () => res(), { once: true }))
  rec.addEventListener('dataavailable', (ev: Event) => {
    const b = (ev as BlobEvent).data
    if (b && b.size > 0) uploader.add(slices++, b)
  })
  uploader.subscribe(() => {
    r.pending = uploader.pending()
    r.lastError = uploader.lastError()
    r.uploadStopped = !!uploader.error()
    if (uploader.error() && r.state !== 'failed') fail(uploader.error())
    else { updateUnload(); emit() }
  })
  // the recorder or the microphone ended by itself (call, unplugged, permission revoked): release everything and
  // let what was captured finish uploading; the meeting stays live on the hub for "Stop and process"
  const interrupted = () => { if (r.state === 'recording') fail('Recording was interrupted.') }
  rec.addEventListener('stop', interrupted)
  rec.addEventListener('error', interrupted)
  stream.getTracks().forEach(t => t.addEventListener?.('ended', interrupted))
  try {
    rec.start(SLICE_MS)
  } catch (e) {
    releaseTracks()
    abandon(id)
    throw e
  }
  current = r
  failed.delete(id)
  updateUnload()
  void keepScreenOn(true)
  return r
}
