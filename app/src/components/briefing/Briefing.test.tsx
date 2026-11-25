// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Briefing, { useVisit } from './Briefing'
import { emptyBriefing } from '../../lib/briefing'
import type { Briefing as BriefingData } from '../../lib/api'
import { tk } from '../../lib/fixtures.test-util'

const fetchMock = vi.fn(async (u: string, i?: RequestInit) => {
  if (String(u).endsWith('/pinned') && i?.method === 'POST') {
    const { text } = JSON.parse(String(i.body))
    return new Response(JSON.stringify({ id: 'n9', text, at: 5 }))
  }
  return new Response(null, { status: 204 })
})
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear() })

const full = (): BriefingData => ({
  ...emptyBriefing(),
  whereLeftOff: { text: 'You were finishing the Acme importer.', at: 1, sessions: 3 },
  newSince: [{ kind: 'ticket', title: 'Ticket assigned to you: Acme export', detail: 'New', at: Date.now() - 60_000, ref: 't2' }],
  myTickets: [tk('1', { title: 'Acme import', assignee: 'Ana' })],
  meetings: { decisions: [{ text: 'Ship on Monday', noteTitle: 'Weekly', date: '2026-11-20' }], openPoints: [], actions: [] },
  pinned: [{ id: 'n1', text: 'Staging is on vps-1', at: 1 }],
  pendings: [{ id: 'q1', projectId: 'p1', text: 'Ask Ben about the certificate', detail: '', note: '', source: 'manual', sourceRef: '', status: 'open', createdAt: 5, updatedAt: 5, doneAt: 0 }],
  prevSeenAt: 1,
})

function Harness({ b: initial, hasSource = true, hasPerson = true, pinOpen = false, onEditSource }: { b: BriefingData; hasSource?: boolean; hasPerson?: boolean; pinOpen?: boolean; onEditSource?: () => void }) {
  const [b, setB] = useState(initial)
  return <Briefing b={b} projectId="p1" hasSource={hasSource} hasPerson={hasPerson} pinOpen={pinOpen} onBriefing={setB} onEditSource={onEditSource} />
}
const regions = () => screen.queryAllByRole('region').map((r) => r.getAttribute('aria-label'))

describe('Briefing sections', () => {
  it('in the mockup order', () => {
    render(<Harness b={full()} />)
    expect(regions()).toEqual(['Where you left off', 'Pending', 'New since you were here', 'Your tickets', 'From meetings', 'Pinned notes'])
  })
  it('hides empty sections', () => {
    render(<Harness b={{ ...emptyBriefing(), myTickets: [tk('1')] }} />)
    expect(regions()).toEqual(['Your tickets'])
  })
  it('shows nothing at all for an empty project with a source', () => {
    const { container } = render(<Harness b={emptyBriefing()} />)
    expect(regions()).toEqual([])
    expect(container.textContent).toBe('')
  })
  it('labels the generated paragraph', () => {
    render(<Harness b={full()} />)
    expect(screen.getByText('Written by Haiku from your last 3 sessions · not a source of truth')).toBeTruthy()
  })
  it('two columns from 900 px of the page width (container query), one below; long text wraps (320 px)', () => {
    const b = full()
    b.whereLeftOff!.text = 'x'.repeat(400)
    b.myTickets = [tk('1', { title: 'https://example.com/' + 'y'.repeat(300) })]
    const { container } = render(<Harness b={b} />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain('@container')
    const grids = [...container.querySelectorAll('[data-briefing-row]')]
    expect(grids).toHaveLength(2)
    for (const g of grids) {
      expect(g.className).toContain('grid')
      expect(g.className).toContain('@min-[900px]:grid-cols-2')
      expect(g.className).not.toMatch(/(^|\s)grid-cols-2/)
    }
    for (const r of screen.getAllByRole('region')) expect(r.className).toContain('min-w-0')
    // nothing has a fixed width that could overflow a 320 px screen
    expect(container.innerHTML).not.toMatch(/\b(min-)?w-\[\d{3,}px\]/)
    expect(screen.getByText('x'.repeat(400)).className).toContain('[overflow-wrap:anywhere]')
    expect(screen.getByText(/^https:\/\/example.com/).className).toContain('[overflow-wrap:anywhere]')
  })
})

describe('Your tickets', () => {
  it('an overdue open ticket shows the warning tone and Due <date>', () => {
    const past = new Date()
    past.setDate(past.getDate() - 2)
    const b = { ...emptyBriefing(), myTickets: [tk('1', { plannedEnd: past.getTime() }), tk('2', { title: 'Later', plannedEnd: Date.now() + 5 * 86_400_000 })] }
    render(<Harness b={b} />)
    const due = screen.getAllByText(/^Due /)
    expect(due[0].className).toContain('text-warning')
    expect(due[1].className).not.toContain('text-warning')
  })
})

describe('No source', () => {
  it('shows the hint, linking to the connector settings', () => {
    const onEditSource = vi.fn()
    render(<Harness b={emptyBriefing()} hasSource={false} onEditSource={onEditSource} />)
    const hint = screen.getByRole('button', { name: 'Connect a ticket source to see your tickets here' })
    expect(hint.className).toContain('min-h-11')
    fireEvent.click(hint)
    expect(onEditSource).toHaveBeenCalled()
    expect(regions()).toEqual([])
  })
})

describe('Source without "You are"', () => {
  it('shows the hint instead of an empty Your tickets', () => {
    const onEditSource = vi.fn()
    render(<Harness b={emptyBriefing()} hasPerson={false} onEditSource={onEditSource} />)
    const hint = screen.getByRole('button', { name: 'Set \u201cYou are\u201d in the ticket source to see your tickets' })
    fireEvent.click(hint)
    expect(onEditSource).toHaveBeenCalled()
    expect(screen.queryByText('Connect a ticket source to see your tickets here')).toBeNull()
  })
  it('a source with a person shows no hint', () => {
    const { container } = render(<Harness b={emptyBriefing()} />)
    expect(container.textContent).toBe('')
  })
})

describe('Pinned notes', () => {
  it('pins a note through the hub and lists it', async () => {
    render(<Harness b={full()} />)
    const box = screen.getByLabelText('New pinned note')
    fireEvent.change(box, { target: { value: '  Deploys on Fridays  ' } })
    const pin = screen.getByRole('button', { name: 'Pin' })
    expect(pin.className).toContain('min-h-11')
    fireEvent.click(pin)
    await screen.findByText('Deploys on Fridays')
    const call = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith('/api/projects/p1/pinned') && i?.method === 'POST')!
    expect(JSON.parse(String(call[1]!.body))).toEqual({ text: 'Deploys on Fridays' })
    expect((box as HTMLInputElement).value).toBe('')
  })
  it('deletes a note from its menu', async () => {
    render(<Harness b={full()} />)
    const note = screen.getByText('Staging is on vps-1').closest('li')!
    fireEvent.keyDown(within(note).getByRole('button', { name: 'Note menu' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('Staging is on vps-1')).toBeNull())
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/api/projects/p1/pinned/n1') && i?.method === 'DELETE')).toBe(true)
  })
  it('over 500 characters shows an inline error and does not pin', () => {
    render(<Harness b={full()} />)
    fireEvent.change(screen.getByLabelText('New pinned note'), { target: { value: 'a'.repeat(501) } })
    expect(screen.getByRole('alert').textContent).toMatch(/500 characters/)
    expect((screen.getByRole('button', { name: 'Pin' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('counts code points like the hub: 500 emoji fit', () => {
    render(<Harness b={full()} />)
    fireEvent.change(screen.getByLabelText('New pinned note'), { target: { value: '\u{1F680}'.repeat(500) } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect((screen.getByRole('button', { name: 'Pin' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('New pinned note'), { target: { value: '\u{1F680}'.repeat(501) } })
    expect(screen.getByRole('alert').textContent).toContain('this one has 501')
  })
  it('a hub error shows inline', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'note too long' }), { status: 400 }))
    render(<Harness b={full()} />)
    fireEvent.change(screen.getByLabelText('New pinned note'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    expect((await screen.findByRole('alert')).textContent).toContain('note too long')
  })
  it('with no notes the section is hidden unless opened from the menu', () => {
    const { rerender } = render(<Harness b={emptyBriefing()} />)
    expect(screen.queryByLabelText('New pinned note')).toBeNull()
    rerender(<Harness b={emptyBriefing()} pinOpen />)
    expect(screen.getByLabelText('New pinned note')).toBeTruthy()
  })
})

describe('useVisit', () => {
  let vis: DocumentVisibilityState = 'visible'
  beforeEach(() => {
    vis = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => { vi.useRealTimers() })
  const visits = () => fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith('/api/projects/p1/visit') && i?.method === 'POST').length
  function V({ n }: { n: number }) { useVisit('p1'); return <span>{n}</span> }

  it('posts once after 5 s visible, never again on re-render', () => {
    const { rerender } = render(<V n={1} />)
    act(() => { vi.advanceTimersByTime(4999) })
    expect(visits()).toBe(0)
    act(() => { vi.advanceTimersByTime(1) })
    expect(visits()).toBe(1)
    rerender(<V n={2} />)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(visits()).toBe(1)
  })
  it('waits while the page is hidden and restarts the 5 s when it is visible again', () => {
    vis = 'hidden'
    render(<V n={1} />)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(visits()).toBe(0)
    vis = 'visible'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    act(() => { vi.advanceTimersByTime(3000) })
    vis = 'hidden'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(visits()).toBe(0)
    vis = 'visible'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    act(() => { vi.advanceTimersByTime(5000) })
    expect(visits()).toBe(1)
  })
  it('unmounting before 5 s posts nothing', () => {
    const { unmount } = render(<V n={1} />)
    act(() => { vi.advanceTimersByTime(4000) })
    unmount()
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(visits()).toBe(0)
  })
})
