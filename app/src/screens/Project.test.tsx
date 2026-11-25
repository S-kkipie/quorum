// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Project from './Project'
import { initialState, reduce, setCheckouts, setConversations, setTickets } from '../lib/store'
import { proj, sess, tk } from '../lib/fixtures.test-util'
import type { AppState } from '../lib/store'

// what GET /briefing answers (null: an empty briefing)
let briefing: any = null
const defaultFetch = async (u: string, _i?: RequestInit) => {
  if (String(u).endsWith('/briefing')) return new Response(JSON.stringify(briefing ?? { whereLeftOff: null, newSince: [], myTickets: [], meetings: { decisions: [], openPoints: [], actions: [] }, pinned: [], sessions: [], seenAt: 0, prevSeenAt: 0 }))
  if (String(u).endsWith('/visit')) return new Response(JSON.stringify({ seenAt: 1, prevSeenAt: 0 }))
  if (String(u).includes('/conversations')) return new Response(JSON.stringify([{ id: 'c9', title: 'Old', firstPrompt: '', messages: 4, updatedAt: Date.now(), open: false }]))
  if (String(u).endsWith('/api/launch')) return new Response(JSON.stringify({ reqId: 'r1' }))
  return new Response('[]')
}
const fetchMock = vi.fn(defaultFetch)
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear(); briefing = null })

function state(kind = 'exec') {
  let s = setCheckouts(initialState(), 'p1', [{ id: 'c1', projectId: 'p1', machine: 'm1', root: '/r', repoUrl: '', branch: '', updatedAt: 1 }])
  s = setTickets(s, 'p1', [tk('1'), tk('2'), tk('3')] as any)
  s = { ...s, projects: { p1: proj('p1', { connector: { kind, settings: {}, hasToken: false, intervalMin: 5 } }) }, machines: { m1: { name: 'm1', os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: { herdr: false, terminal: false, root: false } } } }
  return s
}
// same semantics as App's guard: synchronous, one at a time
function makeGuard(onLaunched: (p: any) => void) {
  let busy = false
  return async (fn: () => Promise<any>) => {
    if (busy) return
    busy = true
    try { onLaunched(await fn()) } finally { busy = false }
  }
}
// like App: conversation lists go into the state
function P(props: Omit<React.ComponentProps<typeof Project>, 'state' | 'id' | 'onConversations'> & { kind?: string }) {
  const [s, setS] = useState(() => state(props.kind))
  return <Project {...props} state={s} id="p1" onConversations={(m, r, l) => setS((x) => setConversations(x, m, r, l))} />
}
function openMenu() {
  const t = screen.getByRole('button', { name: 'Project menu' })
  fireEvent.keyDown(t, { key: 'Enter' })
}

describe('Project: sessions only', () => {
  it('has a Sessions heading and no ticket rows or Conversations heading', async () => {
    render(<P />)
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeTruthy()
    expect(screen.queryByText('Conversations')).toBeNull()
    expect(screen.queryByText('Ticket 1')).toBeNull()
    await screen.findByText('Old')
  })
  it('the menu exposes Tickets (3), Sync, Edit and Checkouts', async () => {
    render(<P onEdit={vi.fn()} />)
    openMenu()
    expect(await screen.findByRole('menuitem', { name: 'Tickets (3)' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Sync' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Checkouts' })).toBeTruthy()
  })
  it('no Sync item when the connector kind is none', async () => {
    render(<P kind="none" onEdit={vi.fn()} />)
    openMenu()
    await screen.findByRole('menuitem', { name: 'Edit' })
    expect(screen.queryByRole('menuitem', { name: 'Sync' })).toBeNull()
  })
  it('shows no ticket progress bar', async () => {
    render(<P />)
    await screen.findByText('Old')
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
  it('no Sync item when the project has no connector', async () => {
    const Q = () => { const s = state(); return <Project state={{ ...s, projects: { p1: { ...s.projects.p1, connector: undefined as any } } }} id="p1" onEdit={vi.fn()} /> }
    render(<Q />)
    openMenu()
    await screen.findByRole('menuitem', { name: 'Edit' })
    expect(screen.queryByRole('menuitem', { name: 'Sync' })).toBeNull()
  })
  it('Back buttons are touch-sized', async () => {
    render(<P onBack={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Back' }).className).toContain('min-h-11')
    await screen.findByText('Old')
  })
  it('Tickets item calls onOpenTickets', async () => {
    const onOpenTickets = vi.fn()
    render(<P onOpenTickets={onOpenTickets} />)
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Tickets (3)' }))
    expect(onOpenTickets).toHaveBeenCalledWith('p1')
  })
})

describe('Project: resume', () => {
  it('double tap on a closed conversation launches only once, with resume', async () => {
    const onLaunched = vi.fn()
    render(<P onGuard={makeGuard(onLaunched)} onLaunched={onLaunched} />)
    const row = await screen.findByText('Old')
    fireEvent.click(row)
    fireEvent.click(row)
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1))
    const calls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/launch'))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0][1]?.body)).resume).toBe('c9')
  })
  it('with a launch in progress (pending) nothing is resumed', async () => {
    render(<P pending onGuard={makeGuard(vi.fn())} onLaunched={vi.fn()} />)
    fireEvent.click(await screen.findByText('Old'))
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/launch'))).toHaveLength(0)
  })
})

const calls = (end: string, method?: string) => fetchMock.mock.calls.filter(([u, i]) => String(u).endsWith(end) && (!method || i?.method === method))
const fullBriefing = () => ({
  whereLeftOff: { text: 'You were finishing the Acme importer.', at: 1, sessions: 2 },
  newSince: [], myTickets: [tk('9', { title: 'Acme import CSV', assignee: 'Ana' })],
  meetings: { decisions: [], openPoints: [], actions: [] }, pinned: [],
  sessions: [sess('old', { machine: 'm1', root: '/old', updatedAt: 1 }), sess('new', { machine: 'm1', root: '/r/latest', updatedAt: 9 })], seenAt: 1, prevSeenAt: 0,
})

describe('Project: briefing', () => {
  it('replaces the summary line at the top of the page', async () => {
    briefing = fullBriefing()
    const Q = () => { const s = state(); return <Project state={{ ...s, projects: { p1: { ...s.projects.p1, summary: 'OLD SUMMARY' } } }} id="p1" /> }
    render(<Q />)
    expect(await screen.findByText('You were finishing the Acme importer.')).toBeTruthy()
    expect(screen.queryByText('OLD SUMMARY')).toBeNull()
    expect(String(calls('/briefing')[0][0])).toContain('/api/projects/p1/briefing')
  })
  it('no ticket source, no sessions, no notes: only the hint, Meetings and the Sessions section', async () => {
    const onEdit = vi.fn()
    render(<P kind="none" onEdit={onEdit} />)
    const hint = await screen.findByRole('button', { name: 'Connect a ticket source to see your tickets here' })
    expect(screen.queryAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Meetings', 'Sessions'])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue where I left off' })).toBeNull()
    fireEvent.click(hint)
    expect(onEdit).toHaveBeenCalledWith('p1')
    await screen.findByText('Old')
  })
  it('the Meetings section follows "From meetings", lists the project\'s meetings and refetches on meeting_changed', async () => {
    briefing = { whereLeftOff: null, newSince: [], myTickets: [], meetings: { decisions: [{ text: 'Ship it', noteTitle: 'Weekly', date: '2026-11-20' }], openPoints: [], actions: [] }, pinned: [], sessions: [], seenAt: 0, prevSeenAt: 0 }
    const row = { id: 'm1', projectId: 'p1', title: 'Weekly sync', startedAt: 0, durationS: 1800, language: 'en', status: 'transcribing', progress: 30, error: '', provider: '', createdAt: 1, updatedAt: 1, hasAudio: true, audioBytes: 1, channels: '', speakerCount: 0 }
    fetchMock.mockImplementation(async (u: string) => {
      if (String(u).endsWith('/briefing')) return new Response(JSON.stringify(briefing))
      if (String(u).includes('/api/meetings?projectId=p1')) return new Response(JSON.stringify([row]))
      return new Response('[]')
    })
    try {
      const onOpenMeeting = vi.fn()
      let s = state()
      const { rerender } = render(<Project state={s} id="p1" onOpenMeeting={onOpenMeeting} />)
      await screen.findByRole('region', { name: 'From meetings' })
      const names = screen.queryAllByRole('region').map((r) => r.getAttribute('aria-label'))
      expect(names.indexOf('Meetings')).toBe(names.indexOf('From meetings') + 1)
      const section = screen.getByRole('region', { name: 'Meetings' })
      expect(screen.getByRole('button', { name: 'Upload recording' })).toBeTruthy()
      fireEvent.click(await within(section).findByRole('button', { name: /Weekly sync.*Transcribing 30%/ }))
      expect(onOpenMeeting).toHaveBeenCalledWith('m1')
      const lists = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/meetings?projectId=p1')).length
      expect(lists()).toBe(1)
      s = reduce(s, { type: 'meeting_changed', payload: { id: 'm1', projectId: 'p1', status: 'summarising' } } as any)
      rerender(<Project state={s} id="p1" onOpenMeeting={onOpenMeeting} />)
      await waitFor(() => expect(lists()).toBe(2))
    } finally {
      fetchMock.mockImplementation(defaultFetch)
    }
  })
  it('refetches on project_briefing_changed and posts the visit once after 5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let bump: () => void = () => {}
      const Q = () => {
        const [s, setS] = useState<AppState>(() => state())
        bump = () => setS((x) => ({ ...x, briefingRev: { p1: (x.briefingRev.p1 ?? 0) + 1 } }))
        return <Project state={s} id="p1" />
      }
      // waitFor polls with setTimeout, which is faked here: flush the fetch promises by hand
      const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
      render(<Q />)
      await flush()
      expect(calls('/briefing')).toHaveLength(1)
      act(() => { vi.advanceTimersByTime(4900) })
      act(() => bump())
      await flush()
      expect(calls('/briefing')).toHaveLength(2)
      expect(calls('/visit', 'POST')).toHaveLength(0)
      act(() => { vi.advanceTimersByTime(100) })
      expect(calls('/visit', 'POST')).toHaveLength(1)
      act(() => bump())
      await flush()
      expect(calls('/briefing')).toHaveLength(3)
      act(() => { vi.advanceTimersByTime(60_000) })
      expect(calls('/visit', 'POST')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('Continue where I left off: the briefing as an editable prompt, in the latest session\'s machine and folder', async () => {
    briefing = fullBriefing()
    const onLaunched = vi.fn()
    render(<P onLaunched={onLaunched} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue where I left off' }))
    const box = await screen.findByLabelText('First prompt') as HTMLTextAreaElement
    expect(box.value).toContain('Acme import CSV')
    expect(box.value).toContain('You were finishing the Acme importer.')
    expect(box.value.length).toBeLessThanOrEqual(1500)
    expect((screen.getByPlaceholderText('/path/to/project') as HTMLInputElement).value).toBe('/r/latest')
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(onLaunched).toHaveBeenCalled())
    const body = JSON.parse(String(calls('/api/launch')[0][1]?.body))
    expect(body).toMatchObject({ machine: 'm1', dir: '/r/latest', projectId: 'p1' })
    expect(body.prompt).toContain('Acme import CSV')
    expect(body.ticketId).toBeUndefined()
  })
  it('the menu\'s Pin a note opens the pinned notes card', async () => {
    render(<P onEdit={vi.fn()} />)
    await waitFor(() => expect(calls('/briefing')).toHaveLength(1))
    expect(screen.queryByLabelText('New pinned note')).toBeNull()
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin a note' }))
    expect(await screen.findByLabelText('New pinned note')).toBeTruthy()
  })
})
