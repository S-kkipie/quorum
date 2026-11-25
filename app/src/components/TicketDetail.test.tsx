// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TicketDetail from './TicketDetail'
import { initialState, setCheckouts, setTickets } from '../lib/store'
import { proj, sess, tk } from '../lib/fixtures.test-util'

const fetchMock = vi.fn(async (u: string, _i?: RequestInit) => {
  if (String(u).endsWith('/checkouts')) return new Response(JSON.stringify([{ id: 'c1', projectId: 'p1', machine: 'mac', root: '/Users/yo/repo', repoUrl: '', branch: 'main', updatedAt: 1 }]))
  if (String(u).endsWith('/launch')) return new Response(JSON.stringify({ error: 'a session is already working on this ticket', session: 's7' }), { status: 409 })
  return new Response(JSON.stringify({ ...tk('t1'), sessions: [], proposals: [] }))
})
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear() })

describe('TicketDetail', () => {
  it('Open session: project checkout; a 409 offers to go to the existing session', async () => {
    let s = setTickets(initialState(), 'p1', [{ ...tk('t1'), sessions: [] }])
    s = { ...s, machines: { 'vps-2': { name: 'vps-2', os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: { herdr: false, terminal: false, root: false } } }, sessions: { a: sess('a', { state: 'closed', root: '/srv/repo' }) }, order: ['a'] }
    const onOpenSession = vi.fn()
    render(<TicketDetail state={s} ticketId="t1" onOpenSession={onOpenSession} />)
    expect((screen.getByPlaceholderText('/path/to/repo') as HTMLInputElement).value).toBe('/srv/repo')
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }))
    const go = await screen.findByRole('button', { name: 'Go to session' })
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/launch'))!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ machine: 'vps-2', checkoutRoot: '/srv/repo', permissionMode: 'bypass' })
    fireEvent.click(go)
    expect(onOpenSession).toHaveBeenCalledWith('s7')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already working'))
  })
  it('requests the project\'s saved checkouts and offers them in the selector', async () => {
    let s = setTickets(initialState(), 'p1', [{ ...tk('t1'), sessions: [] }])
    s = { ...s, machines: { mac: { name: 'mac', os: 'darwin', env: 'darwin', version: '', online: true, lastSeen: 0, caps: { herdr: false, terminal: false, root: false } } } }
    const onCheckouts = vi.fn()
    const { rerender } = render(<TicketDetail state={s} ticketId="t1" onCheckouts={onCheckouts} />)
    await waitFor(() => expect(onCheckouts).toHaveBeenCalled())
    expect(String(fetchMock.mock.calls.find(([u]) => String(u).endsWith('/checkouts'))![0])).toContain('/api/projects/p1/checkouts')
    s = setCheckouts(s, 'p1', onCheckouts.mock.calls[0][1])
    rerender(<TicketDetail state={s} ticketId="t1" onCheckouts={onCheckouts} />)
    expect((screen.getByPlaceholderText('/path/to/repo') as HTMLInputElement).value).toBe('/Users/yo/repo')
  })
  it('a read-only source (kind moontech) hides proposals and the status change', async () => {
    let s = setTickets(initialState(), 'p1', [{ ...tk('t1'), sessions: [] }])
    s = { ...s, projects: { p1: proj('p1', { connector: { kind: 'moontech', settings: {}, hasToken: true, intervalMin: 5 } }) }, proposals: { pr1: { id: 'pr1', ticketId: 't1', kind: 'comment', body: 'Done', status: 'pending', createdAt: 1 } as any } }
    render(<TicketDetail state={s} ticketId="t1" />)
    expect(screen.getByText(/Read-only source/)).toBeTruthy()
    expect(screen.queryByText('Change status')).toBeNull()
    expect(screen.queryByText('Pending proposals')).toBeNull()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
  it('a parked ticket reads parked, like the briefing', async () => {
    const s = setTickets(initialState(), 'p1', [{ ...tk('t1', { status: 'blocked', rawStatus: 'aparcado' }), sessions: [] }])
    render(<TicketDetail state={s} ticketId="t1" />)
    expect(screen.getByText(/^parked \(aparcado\)/)).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
  it('a writable source keeps the status change', async () => {
    const s = setTickets(initialState(), 'p1', [{ ...tk('t1'), sessions: [] }])
    render(<TicketDetail state={s} ticketId="t1" />)
    expect(screen.getByText('Change status')).toBeTruthy()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })
})
