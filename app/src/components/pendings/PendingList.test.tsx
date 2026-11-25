// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PendingList, { splitPending } from './PendingList'
import type { Pending } from '../../proto.gen'

vi.mock('../../lib/pendingsApi', async (orig) => ({
  ...(await orig<typeof import('../../lib/pendingsApi')>()), listPendings: vi.fn(), addPending: vi.fn(), patchPending: vi.fn(), deletePending: vi.fn(),
}))
import { addPending, deletePending, listPendings, patchPending } from '../../lib/pendingsApi'

const pd = (id: string, text: string, o: Partial<Pending> = {}): Pending => ({
  id, projectId: 'p1', text, detail: '', note: '', source: 'manual', sourceRef: '', status: 'open', createdAt: 100, updatedAt: 100, doneAt: 0, ...o,
})
const open = [pd('a', 'Alpha'), pd('b', 'Bravo')]
const everything = [...open, pd('c', 'Charlie', { status: 'done', note: 'finished' }), pd('d', 'Delta', { status: 'dropped' })]

beforeEach(() => {
  vi.mocked(listPendings).mockImplementation(async (_p, all) => (all ? everything : open))
  vi.mocked(addPending).mockImplementation(async (_p, b) => pd('n1', b.text, { detail: b.detail ?? '' }))
  vi.mocked(patchPending).mockImplementation(async (id, b) => pd(id, 'Alpha', { status: b.status ?? 'open' }))
  vi.mocked(deletePending).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

const menu = (name: string) => {
  const row = screen.getByText(name).closest('li')!
  fireEvent.keyDown(row.querySelector('button[aria-label="Item menu"]')!, { key: 'Enter' })
}

describe('PendingList', () => {
  it('lists open items, and adds with the Add button', async () => {
    render(<PendingList projectId="p1" />)
    await screen.findByText('Alpha')
    expect(listPendings).toHaveBeenCalledWith('p1', false)
    fireEvent.change(screen.getByLabelText('New pending item'), { target: { value: ' Echo ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(addPending).toHaveBeenCalledWith('p1', { text: 'Echo' }))
    await screen.findByText('Echo')
    expect((screen.getByLabelText('New pending item') as HTMLTextAreaElement).value).toBe('')
  })
  it('Enter adds on a computer; Shift+Enter stays a new line and the rest becomes the detail', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    render(<PendingList projectId="p1" />)
    await screen.findByText('Alpha')
    const f = screen.getByLabelText('New pending item')
    fireEvent.change(f, { target: { value: 'Echo\nmore words' } })
    expect(fireEvent.keyDown(f, { key: 'Enter', shiftKey: true })).toBe(true) // not prevented: a new line
    expect(addPending).not.toHaveBeenCalled()
    fireEvent.keyDown(f, { key: 'Enter' })
    await waitFor(() => expect(addPending).toHaveBeenCalledWith('p1', { text: 'Echo', detail: 'more words' }))
  })
  it('on a touch screen Enter is a new line (it does not add)', async () => {
    render(<PendingList projectId="p1" />)
    await screen.findByText('Alpha')
    const f = screen.getByLabelText('New pending item')
    fireEvent.change(f, { target: { value: 'Echo' } })
    expect(fireEvent.keyDown(f, { key: 'Enter' })).toBe(true)
    expect(addPending).not.toHaveBeenCalled()
  })
  it('splits text and detail at the first line break', () => {
    expect(splitPending('  a\n\n b \n c ')).toEqual({ text: 'a', detail: 'b \n c' })
    expect(splitPending('only')).toEqual({ text: 'only', detail: '' })
  })
  it('All shows done items struck through', async () => {
    render(<PendingList projectId="p1" />)
    await screen.findByText('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    const done = await screen.findByText('Charlie')
    expect(listPendings).toHaveBeenCalledWith('p1', true)
    expect(done.className).toContain('line-through')
    expect((screen.getByRole('checkbox', { name: 'Charlie' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Delta').className).not.toContain('line-through')
  })
  it('Drop and Delete call the API and take the item off the list', async () => {
    render(<PendingList projectId="p1" />)
    await screen.findByText('Alpha')
    menu('Alpha')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Drop' }))
    await waitFor(() => expect(patchPending).toHaveBeenCalledWith('a', { status: 'dropped' }))
    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull())
    menu('Bravo')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(deletePending).toHaveBeenCalledWith('b'))
    await waitFor(() => expect(screen.queryByText('Bravo')).toBeNull())
  })
  it('refetches when the revision changes', async () => {
    const { rerender } = render(<PendingList projectId="p1" rev={0} />)
    await screen.findByText('Alpha')
    expect(listPendings).toHaveBeenCalledTimes(1)
    vi.mocked(listPendings).mockResolvedValue([pd('z', 'Zulu')])
    rerender(<PendingList projectId="p1" rev={1} />)
    await screen.findByText('Zulu')
    expect(listPendings).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Alpha')).toBeNull()
  })
  it('shows an error from the hub', async () => {
    vi.mocked(addPending).mockRejectedValue(new Error('boom'))
    render(<PendingList projectId="p1" />)
    await screen.findByText('Alpha')
    fireEvent.change(screen.getByLabelText('New pending item'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toBe('boom')
  })
})
