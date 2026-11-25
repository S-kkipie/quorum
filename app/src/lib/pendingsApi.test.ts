import { describe, it, expect, vi, beforeEach } from 'vitest'

const mem: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
  removeItem: (k: string) => { delete mem[k] },
})
import { ApiError, setHub } from './api'
import { addMeetingPending, addPending, deletePending, listPendings, patchPending } from './pendingsApi'

const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })
const f = vi.fn()
beforeEach(() => { for (const k in mem) delete mem[k]; setHub('http://h:1/', 'tok'); f.mockReset(); vi.stubGlobal('fetch', f) })
const last = () => { const [u, i] = f.mock.calls.at(-1)!; return { url: String(u).replace('http://h:1', ''), method: i?.method ?? 'GET', body: i?.body ? JSON.parse(String(i.body)) : undefined } }

describe('pendingsApi', () => {
  it('lists open or all items of a project', async () => {
    f.mockImplementation(async () => res(200, []))
    await listPendings('p 1', false)
    expect(last()).toMatchObject({ url: '/api/projects/p%201/pendings?status=open', method: 'GET' })
    await listPendings('p1', true)
    expect(last().url).toBe('/api/projects/p1/pendings?status=all')
  })
  it('adds, patches and deletes', async () => {
    f.mockResolvedValue(res(201, { id: 'a' }))
    await addPending('p1', { text: 'T', detail: 'D' })
    expect(last()).toEqual({ url: '/api/projects/p1/pendings', method: 'POST', body: { text: 'T', detail: 'D' } })
    f.mockResolvedValue(res(200, { id: 'a' }))
    await patchPending('a/b', { status: 'done', note: 'n' })
    expect(last()).toEqual({ url: '/api/pendings/a%2Fb', method: 'PATCH', body: { status: 'done', note: 'n' } })
    f.mockResolvedValue(res(204))
    await deletePending('a')
    expect(last()).toMatchObject({ url: '/api/pendings/a', method: 'DELETE' })
  })
  it('addMeetingPending: 201 is added, 409 is not added with the existing id, other errors are rethrown', async () => {
    f.mockResolvedValue(res(201, { id: 'n1' }))
    expect(await addMeetingPending('m1', 'Do it')).toEqual({ id: 'n1', added: true })
    expect(last()).toEqual({ url: '/api/meetings/m1/pendings', method: 'POST', body: { text: 'Do it' } })
    f.mockImplementation(async () => res(409, { error: 'already added', id: 'n0' }))
    expect(await addMeetingPending('m1', 'Do it')).toEqual({ id: 'n0', added: false })
    f.mockImplementation(async () => res(400, { error: 'meeting has no project' }))
    await expect(addMeetingPending('m1', 'x')).rejects.toMatchObject({ status: 400 })
    await expect(addMeetingPending('m1', 'x')).rejects.toBeInstanceOf(ApiError)
    f.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(addMeetingPending('m1', 'x')).rejects.toThrow('Failed to fetch')
  })
})
