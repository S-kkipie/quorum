// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ProposalCard from './ProposalCard'
import type { Proposal } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ...p, status: 'approved' })))
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear() })

const p: Proposal = { id: 'x1', ticketId: 't1', kind: 'comment', body: 'Progress (Quorum, vps-2):\ndone', status: 'pending', error: '', createdAt: 1 }

describe('ProposalCard', () => {
  it('approving sends the edited body', async () => {
    const onDone = vi.fn()
    render(<ProposalCard proposal={p} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Comment text'), { target: { value: 'Done, check PR #4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/proposals/x1/approve')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ body: 'Done, check PR #4' })
  })
  it('without editing it sends no body; reject goes to /reject', async () => {
    render(<ProposalCard proposal={p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1][0]).toContain('/api/proposals/x1/reject')
  })
  it('409: shows the hub\'s error', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'the proposal is no longer pending' }), { status: 409 }))
    render(<ProposalCard proposal={p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect((await screen.findByRole('alert')).textContent).toBe('the proposal is no longer pending')
  })
  it('failed shows the error and has no buttons', () => {
    render(<ProposalCard proposal={{ ...p, kind: 'status', body: 'done', status: 'failed', error: 'HTTP 403' }} />)
    expect(screen.getByText('HTTP 403')).toBeTruthy()
    expect(screen.getByText('done')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('adopts the hub\'s new draft only if it is not being edited', () => {
    const { rerender } = render(<ProposalCard proposal={p} />)
    const box = () => screen.getByLabelText('Comment text') as HTMLTextAreaElement
    rerender(<ProposalCard proposal={{ ...p, body: 'turn 2' }} />)
    expect(box().value).toBe('turn 2')
    fireEvent.change(box(), { target: { value: 'mine' } })
    rerender(<ProposalCard proposal={{ ...p, body: 'turn 3' }} />)
    expect(box().value).toBe('mine')
  })
})
