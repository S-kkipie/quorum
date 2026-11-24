// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ProjectTickets from './ProjectTickets'
import { initialState, setTickets } from '../lib/store'
import { proj, sess, tk } from '../lib/fixtures.test-util'

const fetchMock = vi.fn(async (u: string, _i?: RequestInit) => new Response('[]'))
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear() })

function state(kind = 'exec') {
  let s = setTickets(initialState(), 'p1', [tk('1'), tk('2', { status: 'in_progress' }), tk('3', { status: 'done' })] as any)
  s = { ...s, projects: { p1: proj('p1', { connector: { kind, settings: {}, hasToken: false, intervalMin: 5 } }) } }
  return s
}

describe('ProjectTickets', () => {
  it('groups tickets by status and folds done', () => {
    render(<ProjectTickets state={state()} id="p1" />)
    expect(screen.getByText('to do (1)')).toBeTruthy()
    expect(screen.getByText('in progress (1)')).toBeTruthy()
    expect(screen.getByText(/done \(1\)/)).toBeTruthy()
    expect(screen.getByText('Ticket 1')).toBeTruthy()
  })
  it('opens a ticket', () => {
    const onOpenTicket = vi.fn()
    render(<ProjectTickets state={state()} id="p1" onOpenTicket={onOpenTicket} />)
    fireEvent.click(screen.getByText('Ticket 1'))
    expect(onOpenTicket).toHaveBeenCalledWith('1')
  })
  it('empty texts', () => {
    const s = { ...state(), tickets: { p1: [] } }
    const { unmount } = render(<ProjectTickets state={s} id="p1" />)
    expect(screen.getByText('No tickets yet.')).toBeTruthy()
    unmount()
    render(<ProjectTickets state={{ ...s, projects: { p1: proj('p1', { connector: { kind: 'none', settings: {}, hasToken: false, intervalMin: 5 } }) } }} id="p1" />)
    expect(screen.getByText('This project has no ticket source configured.')).toBeTruthy()
  })
  it('shows link suggestions', () => {
    const s = { ...state(), sessions: { s1: sess('s1', { name: 'sess-one' }) }, order: ['s1'], links: { '1': { s1: false } } } as any
    render(<ProjectTickets state={s} id="p1" />)
    expect(screen.getByText('Link suggestions')).toBeTruthy()
    expect(screen.getByText('Confirm')).toBeTruthy()
  })
})
