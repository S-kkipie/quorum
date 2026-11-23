// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import TicketRow from './TicketRow'
import { initialState, reduce } from '../lib/store'
import { sess, tk } from '../lib/fixtures.test-util'

afterEach(cleanup)

describe('TicketRow', () => {
  it('estado combinado con la sesión confirmada trabajando', () => {
    let s = reduce(initialState(), { type: 'session_upsert', machine: 'vps-2', session: 's1', payload: sess('s1', { state: 'working', updatedAt: Date.now() - 12 * 60000 }) })
    s = reduce(s, { type: 'session_ticket', machine: '', session: 's1', payload: { sessionId: 's1', ticketId: 't1', confirmed: true } })
    render(<ul><TicketRow state={s} ticket={tk('t1', { status: 'en_curso', rawStatus: 'In Progress' })} /></ul>)
    expect(screen.getByText('en curso · vps-2 · trabajando hace 12 min')).toBeTruthy()
  })
  it('en review: listo, esperando tu review', () => {
    render(<ul><TicketRow state={initialState()} ticket={tk('t1', { status: 'en_review', rawStatus: 'review' })} pending={1} /></ul>)
    expect(screen.getByText('listo, esperando tu review')).toBeTruthy()
    expect(screen.getByTitle('propuestas pendientes').textContent).toBe('1')
  })
})
