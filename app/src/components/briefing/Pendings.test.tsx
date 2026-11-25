// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Pendings from './Pendings'
import type { Pending } from '../../proto.gen'

vi.mock('../../lib/pendingsApi', async (orig) => ({ ...(await orig<typeof import('../../lib/pendingsApi')>()), patchPending: vi.fn(), deletePending: vi.fn() }))
import { deletePending, patchPending } from '../../lib/pendingsApi'

const pd = (id: string, text: string, o: Partial<Pending> = {}): Pending => ({
  id, projectId: 'p1', text, detail: '', note: '', source: 'manual', sourceRef: '', status: 'open', createdAt: 100, updatedAt: 100, doneAt: 0, ...o,
})
function Harness({ items, prevSeenAt = 50 }: { items: Pending[]; prevSeenAt?: number }) {
  const [l, setL] = useState(items)
  return <Pendings items={l} prevSeenAt={prevSeenAt} onChange={setL} />
}
beforeEach(() => {
  vi.mocked(patchPending).mockImplementation(async (id, b) => pd(id, 'x', { status: b.status ?? 'open', note: b.note ?? '' }))
  vi.mocked(deletePending).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('Pendings (briefing)', () => {
  it('lists the open items in the order given (oldest first)', () => {
    render(<Harness items={[pd('a', 'First'), pd('b', 'Second'), pd('c', 'Third')]} />)
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['First', 'Second', 'Third'])
    expect(screen.getByRole('region', { name: 'Pending' })).toBeTruthy()
  })
  it('shows the new dot only on agent items newer than the previous visit', () => {
    render(<Harness items={[pd('a', 'Old agent', { source: 'agent', createdAt: 10 }), pd('b', 'New agent', { source: 'agent', createdAt: 90 }), pd('c', 'New manual', { createdAt: 95 })]} />)
    expect(screen.getAllByRole('img', { name: 'New' })).toHaveLength(1)
    expect(within(screen.getByText('New agent').closest('li')!).getByRole('img', { name: 'New' })).toBeTruthy()
    expect(screen.getAllByText('agent')).toHaveLength(2)
  })
  it('ticking with a note closes the item with that note', async () => {
    render(<Harness items={[pd('a', 'Ship it'), pd('b', 'Other')]} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ship it' }))
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: ' shipped ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(patchPending).toHaveBeenCalledWith('a', { status: 'done', note: 'shipped' }))
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Ship it' })).toBeNull())
    expect(screen.getByRole('checkbox', { name: 'Other' })).toBeTruthy()
  })
  it('Skip note sends no note, even when one was typed', async () => {
    render(<Harness items={[pd('a', 'Ship it')]} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ship it' }))
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'typed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Skip note' }))
    await waitFor(() => expect(patchPending).toHaveBeenCalledWith('a', { status: 'done' }))
  })
  it('shows at most 8 items and "Show all (N)" scrolls to the list', () => {
    const scroll = vi.fn()
    const el = document.createElement('div')
    el.id = 'pending-items'
    el.scrollIntoView = scroll
    document.body.appendChild(el)
    render(<Harness items={Array.from({ length: 11 }, (_, i) => pd('i' + i, 'Item ' + i))} />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(8)
    fireEvent.click(screen.getByRole('button', { name: 'Show all (11)' }))
    expect(scroll).toHaveBeenCalled()
    el.remove()
  })
  it('has no Show all button for 8 items or fewer', () => {
    render(<Harness items={Array.from({ length: 8 }, (_, i) => pd('i' + i, 'Item ' + i))} />)
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull()
  })
})
