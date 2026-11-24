// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Project from './Project'
import { initialState, setCheckouts, setConversations, setTickets } from '../lib/store'
import { proj, tk } from '../lib/fixtures.test-util'

const fetchMock = vi.fn(async (u: string, _i?: RequestInit) => {
  if (String(u).includes('/conversations')) return new Response(JSON.stringify([{ id: 'c9', title: 'Old', firstPrompt: '', messages: 4, updatedAt: Date.now(), open: false }]))
  if (String(u).endsWith('/api/launch')) return new Response(JSON.stringify({ reqId: 'r1' }))
  return new Response('[]')
})
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear() })

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
