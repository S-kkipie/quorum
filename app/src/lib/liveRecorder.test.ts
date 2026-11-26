import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mem: Record<string, string> = {}
const stubStorage = () => vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})
stubStorage()
import { setHub, ApiError } from './api'
import { createSliceUploader, startLiveRecording, currentRecording, keepScreenOn } from './liveRecorder'

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const blob = (s: string) => new Blob([s])

describe('slice uploader', () => {
  it('sends in order and retries', async () => {
    const sleeps: number[] = []
    const sent: number[] = []
    let n = 0
    const put = vi.fn(async (seq: number) => {
      n++
      if (n === 1) throw new ApiError('busy', 503, null)
      if (n === 2) throw new TypeError('network')
      sent.push(seq)
    })
    const u = createSliceUploader(put, async ms => { sleeps.push(ms) })
    u.add(0, blob('a'))
    u.add(1, blob('b'))
    expect(u.pending()).toBe(2)
    await u.flush()
    expect(sleeps).toEqual([1000, 2000])
    expect(sent).toEqual([0, 1])
    expect(put.mock.calls.map(c => c[0])).toEqual([0, 0, 0, 1])
    expect(u.pending()).toBe(0)
    expect(u.error()).toBe('')
  })

  it('caps the backoff at 15 s and stops on 400', async () => {
    const sleeps: number[] = []
    let n = 0
    const put = async () => {
      n++
      if (n <= 7) throw new ApiError('down', 502, null)
      throw new ApiError('invalid slice number', 400, null)
    }
    const u = createSliceUploader(put, async ms => { sleeps.push(ms) })
    u.add(0, blob('a'))
    await expect(u.flush()).rejects.toThrow('invalid slice number')
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000])
    expect(u.error()).toBe('invalid slice number')
    expect(u.pending()).toBe(1)
  })
})

class FakeRecorder extends EventTarget {
  static last: FakeRecorder
  static supported = true
  static isTypeSupported = () => FakeRecorder.supported
  state = 'inactive'
  startArg: number | undefined
  constructor(public stream: unknown, public opts: unknown) { super(); FakeRecorder.last = this }
  static failStart = false
  start(ms?: number) { if (FakeRecorder.failStart) throw new Error('start failed'); this.startArg = ms; this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
  emit(data: Blob) { const e = new Event('dataavailable') as Event & { data: Blob }; e.data = data; this.dispatchEvent(e) }
}

let calls: string[]
let stopBodies: unknown[]
let stopAnswers: Response[]
let getUserMedia: ReturnType<typeof vi.fn>
const track = { stop: vi.fn() }

beforeEach(() => {
  stubStorage()
  setHub('http://h:1/', 'tok')
  calls = []; stopBodies = []; stopAnswers = []
  track.stop.mockClear()
  FakeRecorder.supported = true
  FakeRecorder.failStart = false
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }))
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit = {}) => {
    const path = u.replace('http://h:1', '')
    calls.push(`${init.method ?? 'GET'} ${path}`)
    if (path === '/api/meetings/live') return res(201, { id: 'm1', status: 'live' })
    if (path === '/api/meetings/m1/live/stop') {
      stopBodies.push(JSON.parse(init.body as string))
      return stopAnswers.shift() ?? res(200, { id: 'm1', status: 'queued' })
    }
    const m = path.match(/\/live\/(\d+)$/)
    if (m) return res(200, { nextSeq: Number(m[1]) + 1, bytes: 1 })
    return res(404, { error: 'no' })
  }))
})
afterEach(async () => {
  try { await currentRecording()?.stop() } catch { /* ignore */ }
  vi.unstubAllGlobals()
})

describe('startLiveRecording', () => {
  it('checks before creating a meeting', async () => {
    vi.stubGlobal('isSecureContext', false)
    await expect(startLiveRecording({})).rejects.toThrow('Recording needs the hub over HTTPS.')
    vi.stubGlobal('isSecureContext', true)
    FakeRecorder.supported = false
    await expect(startLiveRecording({})).rejects.toThrow('This browser cannot record Opus audio.')
    FakeRecorder.supported = true
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await expect(startLiveRecording({})).rejects.toThrow('Microphone access was denied. Allow it in the browser or app settings.')
    expect(calls).toEqual([])
    expect(currentRecording()).toBeNull()
  })

  it('uses the capture options', async () => {
    await startLiveRecording({ title: 'Sync' })
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    expect(FakeRecorder.last.opts).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 48000 })
    expect(FakeRecorder.last.startArg).toBe(15000)
    expect(currentRecording()?.meetingId).toBe('m1')
  })

  it('stop flushes then stops with the slice count', async () => {
    const r = await startLiveRecording({})
    const rec = FakeRecorder.last
    rec.emit(blob('a')); rec.emit(new Blob([])); rec.emit(blob('b')); rec.emit(blob('c'))
    await r.stop()
    expect(calls).toEqual(['POST /api/meetings/live', 'PUT /api/meetings/m1/live/0', 'PUT /api/meetings/m1/live/1', 'PUT /api/meetings/m1/live/2', 'POST /api/meetings/m1/live/stop'])
    expect(stopBodies).toEqual([{ slices: 3 }])
    expect(r.state).toBe('stopped')
    expect(track.stop).toHaveBeenCalled()
    expect(currentRecording()).toBeNull()
  })

  it('forces the stop after a 409 with missing slices', async () => {
    const r = await startLiveRecording({})
    FakeRecorder.last.emit(blob('a')); FakeRecorder.last.emit(blob('b')); FakeRecorder.last.emit(blob('c'))
    stopAnswers.push(res(409, { error: 'some slices have not arrived', missing: [1] }))
    await r.stop()
    expect(stopBodies).toEqual([{ slices: 3 }, { slices: 3, force: true }])
  })

  it('fails when the meeting is no longer recording', async () => {
    const f = fetch as unknown as { getMockImplementation(): (u: string, i?: RequestInit) => Promise<Response>; mockImplementation(fn: (u: string, i?: RequestInit) => Promise<Response>): void }
    const base = f.getMockImplementation()!
    f.mockImplementation(async (u: string, init?: RequestInit) =>
      /\/live\/\d+$/.test(u) ? res(409, { error: 'the meeting is not recording' }) : base(u, init))
    const r = await startLiveRecording({})
    FakeRecorder.last.emit(blob('a'))
    await vi.waitFor(() => expect(r.state).toBe('failed'))
    expect(r.error).toBe('the meeting is not recording')
    expect(currentRecording()).toBeNull()
    expect(track.stop).toHaveBeenCalled()
  })
})

describe('recorder failures', () => {
  it('releases everything when start throws, and a new start works', async () => {
    FakeRecorder.failStart = true
    await expect(startLiveRecording({})).rejects.toThrow('start failed')
    expect(track.stop).toHaveBeenCalled()
    expect(currentRecording()).toBeNull()
    await vi.waitFor(() => expect(stopBodies).toEqual([{ slices: 0 }]))
    FakeRecorder.failStart = false
    const r = await startLiveRecording({})
    expect(currentRecording()).toBe(r)
  })

  it('stops the hub meeting when the recorder cannot be built', async () => {
    vi.stubGlobal('MediaRecorder', Object.assign(class { constructor() { throw new Error('nope') } }, { isTypeSupported: () => true }))
    await expect(startLiveRecording({})).rejects.toThrow('nope')
    await vi.waitFor(() => expect(stopBodies).toEqual([{ slices: 0 }]))
    expect(track.stop).toHaveBeenCalled()
  })

  it('fails as interrupted when the recorder stops by itself, still uploading what was captured', async () => {
    const r = await startLiveRecording({})
    FakeRecorder.last.emit(blob('a'))
    FakeRecorder.last.stop()
    expect(r.state).toBe('failed')
    expect(r.error).toBe('Recording was interrupted.')
    expect(currentRecording()).toBeNull()
    expect(track.stop).toHaveBeenCalled()
    await vi.waitFor(() => expect(calls).toContain('PUT /api/meetings/m1/live/0'))
    expect(stopBodies).toEqual([])
  })

  it('fails as interrupted when the microphone track ends', async () => {
    const t = new EventTarget() as EventTarget & { stop: () => void }
    t.stop = vi.fn()
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [t] })
    const r = await startLiveRecording({})
    t.dispatchEvent(new Event('ended'))
    expect(r.state).toBe('failed')
    expect(r.error).toBe('Recording was interrupted.')
    expect(t.stop).toHaveBeenCalled()
  })

  it('exposes the transient upload error until a slice is stored', async () => {
    let n = 0
    const u = createSliceUploader(async () => { if (n++ === 0) throw new ApiError('disk full', 507, null) }, async () => { expect(u.lastError()).toBe('disk full') })
    u.add(0, blob('a'))
    await u.flush()
    expect(u.lastError()).toBe('')
    expect(u.error()).toBe('')
  })
})

describe('keepScreenOn', () => {
  it('releases a lock that arrives after the screen was released, and the one it replaces', async () => {
    const mk = () => ({ release: vi.fn(async () => {}) })
    const a = mk(), b = mk(), c = mk()
    let resolveC!: (s: unknown) => void
    const request = vi.fn()
      .mockResolvedValueOnce(a).mockResolvedValueOnce(b)
      .mockImplementationOnce(() => new Promise(r => { resolveC = r }))
    const doc = new EventTarget() as EventTarget & { visibilityState: string }
    doc.visibilityState = 'visible'
    vi.stubGlobal('document', doc)
    vi.stubGlobal('navigator', { wakeLock: { request } })
    await keepScreenOn(true)
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(a.release).toHaveBeenCalled())
    doc.dispatchEvent(new Event('visibilitychange'))
    await keepScreenOn(false)
    expect(b.release).toHaveBeenCalled()
    resolveC(c)
    await vi.waitFor(() => expect(c.release).toHaveBeenCalled())
  })

  it('uses the wake lock on the web and requests it again when visible', async () => {
    const release = vi.fn(async () => {})
    const request = vi.fn(async () => ({ release }))
    const doc = new EventTarget() as EventTarget & { visibilityState: string }
    doc.visibilityState = 'visible'
    vi.stubGlobal('document', doc)
    vi.stubGlobal('navigator', { wakeLock: { request } })
    await keepScreenOn(true)
    expect(request).toHaveBeenCalledWith('screen')
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await keepScreenOn(false)
    expect(release).toHaveBeenCalled()
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('uses the HubShell plugin in the Android app and never throws', async () => {
    const nativePromise = vi.fn(async (..._a: unknown[]) => {})
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true, nativePromise } })
    await keepScreenOn(true)
    await keepScreenOn(false)
    expect(nativePromise.mock.calls).toEqual([['HubShell', 'keepScreenOn', { on: true }], ['HubShell', 'keepScreenOn', { on: false }]])
    nativePromise.mockRejectedValue(new Error('boom'))
    await expect(keepScreenOn(true)).resolves.toBeUndefined()
  })

  it('is on while recording natively and off after stop', async () => {
    const nativePromise = vi.fn(async (..._a: unknown[]) => {})
    vi.stubGlobal('window', Object.assign(new EventTarget(), { Capacitor: { isNativePlatform: () => true, nativePromise } }))
    const r = await startLiveRecording({})
    await r.stop()
    expect(nativePromise.mock.calls.map(c => ((c as unknown[])[2] as { on: boolean }).on)).toEqual([true, false])
  })
})
