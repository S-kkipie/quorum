import { describe, it, expect, vi, beforeEach } from 'vitest'

const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})
import { setHub, uploadMeeting, listMeetings, getMeeting, patchMeeting, deleteMeeting, meetingAudioURL, MEETING_MAX_BYTES } from './api'

beforeEach(() => { for (const k in mem) delete mem[k]; setHub('http://h:1/', 'tok') })

const res = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })

/** A fake hub upload: chunkSize 4, stores what each PUT sends at its offset. */
function fakeHub(opts: { failPut?: (n: number) => 'network' | 'partial' | null } = {}) {
  let stored = ''
  let puts = 0
  const calls: string[] = []
  const f = vi.fn(async (u: string, init: RequestInit = {}) => {
    const path = u.replace('http://h:1', '')
    calls.push(`${init.method ?? 'GET'} ${path}`)
    if (path === '/api/meetings/uploads' && init.method === 'POST') return res(201, { uploadId: 'up1', offset: 0, size: 10, chunkSize: 4 })
    const m = path.match(/^\/api\/meetings\/uploads\/up1\?offset=(\d+)$/)
    if (m && init.method === 'PUT') {
      const off = Number(m[1])
      const data = await (init.body as Blob).text()
      if (off !== stored.length) return res(409, { error: 'offset mismatch', offset: stored.length })
      const fail = opts.failPut?.(puts++) ?? null
      if (fail === 'network') throw new TypeError('Failed to fetch')
      if (fail === 'partial') { stored += data.slice(0, 1); return res(400, { error: 'the upload was interrupted', offset: stored.length }) }
      stored += data
      return res(200, { offset: stored.length })
    }
    if (path === '/api/meetings/uploads/up1/complete') return res(201, { id: 'm1', status: 'queued', data: stored })
    return res(404, { error: 'nope' })
  })
  vi.stubGlobal('fetch', f)
  return { f, calls, stored: () => stored }
}

const file = (s: string) => new File([s], 'call.ogg', { type: 'audio/ogg' })

describe('uploadMeeting', () => {
  it('sends 4-byte chunks, reports progress and completes', async () => {
    const hub = fakeHub()
    const progress: number[] = []
    const ids: string[] = []
    const m = await uploadMeeting(file('0123456789'), { projectId: 'p1', title: 'Weekly', onUploadId: (id) => ids.push(id) }, (sent, total) => { progress.push(sent); expect(total).toBe(10) })
    expect(m).toMatchObject({ id: 'm1', status: 'queued' })
    expect(hub.stored()).toBe('0123456789')
    expect(progress).toEqual([0, 4, 8, 10])
    expect(ids).toEqual(['up1'])
    expect(hub.calls).toEqual([
      'POST /api/meetings/uploads',
      'PUT /api/meetings/uploads/up1?offset=0', 'PUT /api/meetings/uploads/up1?offset=4', 'PUT /api/meetings/uploads/up1?offset=8',
      'POST /api/meetings/uploads/up1/complete',
    ])
    const begin = JSON.parse((hub.f.mock.calls[0] as any)[1].body)
    expect(begin).toMatchObject({ name: 'call.ogg', size: 10, mime: 'audio/ogg', projectId: 'p1', title: 'Weekly' })
    expect((hub.f.mock.calls[1] as any)[1].headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('resumes after a failed chunk from the offset the hub has', async () => {
    // the 2nd PUT dies on the network, the 3rd stores one byte and is cut
    const hub = fakeHub({ failPut: (n) => (n === 1 ? 'network' : n === 2 ? 'partial' : null) })
    await uploadMeeting(file('0123456789'), { retryDelayMs: 0 })
    expect(hub.stored()).toBe('0123456789')
    expect(hub.calls.filter((c) => c.startsWith('PUT'))).toEqual([
      'PUT /api/meetings/uploads/up1?offset=0', 'PUT /api/meetings/uploads/up1?offset=4', 'PUT /api/meetings/uploads/up1?offset=4',
      'PUT /api/meetings/uploads/up1?offset=5', 'PUT /api/meetings/uploads/up1?offset=9',
    ])
  })

  it('adopts the hub offset on a 409', async () => {
    const hub = fakeHub()
    // resuming an upload id: the probe answers with what the hub has
    await uploadMeeting(file('0123456789'), { uploadId: 'up1' })
    expect(hub.calls[0]).toBe('PUT /api/meetings/uploads/up1?offset=0')
    expect(hub.stored()).toBe('0123456789')
  })

  it('gives up after the retries', async () => {
    fakeHub({ failPut: () => 'network' })
    await expect(uploadMeeting(file('0123456789'), { retries: 2, retryDelayMs: 0 })).rejects.toThrow('Failed to fetch')
  })

  it('stops at once on a full hub disk', async () => {
    const f = vi.fn(async () => res(507, { error: 'the hub disk is almost full' }))
    vi.stubGlobal('fetch', f)
    await expect(uploadMeeting(file('x'), { retryDelayMs: 0 })).rejects.toThrow('the hub disk is almost full')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('refuses a file over 400 MB before sending anything', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const big = { size: MEETING_MAX_BYTES + 1, name: 'big.mp3', type: 'audio/mpeg', slice: () => new Blob([]) } as unknown as File
    await expect(uploadMeeting(big)).rejects.toMatchObject({ status: 413 })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('meeting helpers', () => {
  it('build the right requests', async () => {
    const calls: [string, RequestInit | undefined][] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => {
      calls.push([u, i])
      return u.endsWith('/audio-url') ? res(200, { url: '/api/meeting-audio/a.b', expiresAt: 1 }) : res(200, [])
    }))
    await listMeetings()
    await listMeetings({ projectId: 'p 1' })
    await listMeetings({ unassigned: true })
    await getMeeting('m/1')
    await patchMeeting('m1', { projectId: '' })
    await deleteMeeting('m1')
    await expect(meetingAudioURL('m1')).resolves.toBe('http://h:1/api/meeting-audio/a.b')
    expect(calls.map(([u, i]) => `${i?.method ?? 'GET'} ${u.replace('http://h:1', '')}`)).toEqual([
      'GET /api/meetings', 'GET /api/meetings?projectId=p+1', 'GET /api/meetings?unassigned=1', 'GET /api/meetings/m%2F1',
      'PATCH /api/meetings/m1', 'DELETE /api/meetings/m1', 'GET /api/meetings/m1/audio-url',
    ])
    expect(JSON.parse(calls[4][1]!.body as string)).toEqual({ projectId: '' })
  })
})
