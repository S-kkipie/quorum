// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import TicketRow from './TicketRow'
import { initialState, reduce } from '../lib/store'
import { sess, tk } from '../lib/fixtures.test-util'

afterEach(cleanup)

describe('TicketRow', () => {
  it('combined state with the confirmed session working', () => {
    let s = reduce(initialState(), { type: 'session_upsert', machine: 'vps-2', session: 's1', payload: sess('s1', { state: 'working', updatedAt: Date.now() - 12 * 60000 }) })
    s = reduce(s, { type: 'session_ticket', machine: '', session: 's1', payload: { sessionId: 's1', ticketId: 't1', confirmed: true } })
    render(<ul><TicketRow state={s} ticket={tk('t1', { status: 'in_progress', rawStatus: 'In Progress' })} /></ul>)
    expect(screen.getByText('in progress · vps-2 · working 12 min ago')).toBeTruthy()
  })
  it('in review: done, waiting for your review', () => {
    render(<ul><TicketRow state={initialState()} ticket={tk('t1', { status: 'in_review', rawStatus: 'review' })} pending={1} /></ul>)
    expect(screen.getByText('done, waiting for your review')).toBeTruthy()
    expect(screen.getByTitle('pending proposals').textContent).toBe('1')
  })
})
