// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Inbox from './Inbox'
import { INBOX_JOB_KEY } from '../lib/inbox'
import { initialState, type AppState } from '../lib/store'
import { proj, sess } from '../lib/fixtures.test-util'
import type { SessionInfo } from '../proto.gen'
import * as api from '../lib/api'

vi.mock('../lib/api', () => ({ closeSession: vi.fn() }))
const close = vi.mocked(api.closeSession)

let store: Map<string, string>
beforeEach(() => {
  close.mockResolvedValue(undefined as never)
  store = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); close.mockReset() })

const ws = (id: string, name: string) => ({ id, name, color: '#123456', whoasProfile: '' })
const NOW = Date.now()
const machine = (name: string, online = true) => ({ name, os: 'linux', env: '', version: '', online, lastSeen: 0, caps: { herdr: false, terminal: false, root: false } })
function build(sessions: SessionInfo[], o: Partial<AppState> = {}): AppState {
  return {
    ...initialState(),
    machines: { 'vps-1': machine('vps-1'), 'vps-2': machine('vps-2') },
    workspaces: { w1: ws('w1', 'ACME'), w2: ws('w2', 'Personal') },
    projects: { p1: proj('p1', { name: 'Web' }), p2: proj('p2', { workspaceId: 'w2', name: 'Notes' }) },
    sessions: Object.fromEntries(sessions.map((x) => [x.id, x])),
    order: sessions.map((x) => x.id),
    ...o,
  }
}
const view = (s: AppState, o: { onOpen?: (id: string) => void; onLaunch?: () => void } = {}) =>
  render(<Inbox state={s} connected onOpen={o.onOpen ?? vi.fn()} onLaunch={o.onLaunch ?? vi.fn()} />)
const rowText = (name: string) => screen.getByText(name).closest('button')!.textContent

describe('Inbox', () => {
  it('has the Seats mark, the title and a + that launches', () => {
    const onLaunch = vi.fn()
    view(build([]), { onLaunch })
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onLaunch).toHaveBeenCalled()
  })

  it('shows sections in attention order and hides the empty ones', () => {
    const s = build([
      sess('a', { recap: 'Idle one' }),
      sess('b', { recap: 'Bg one', state: 'background', background: { tasks: 2, wakeAt: 0 } }),
      sess('c', { recap: 'Working one', state: 'working' }),
      sess('d', { recap: 'Done one', unread: true }),
      sess('e', { recap: 'Needs one', state: 'needs_you' }),
    ])
    view(s)
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Needs you', 'Done · unread', 'Working', 'Background', 'Idle'])
    cleanup()
    view(build([sess('a', { recap: 'Idle one' }), sess('c', { recap: 'Working one', state: 'working' })]))
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Working', 'Idle'])
  })

  it('shows project, machine and the reason of each kind', () => {
    const asks = {
      k1: { askId: 'k1', kind: 'permission', tool: 'Bash', summary: '', detail: '', questions: null, session: 'a' },
      k2: { askId: 'k2', kind: 'question', tool: '', summary: '', detail: '', questions: null, session: 'b' },
    }
    const s = build([
      sess('a', { recap: 'Perm', state: 'needs_you', machine: 'vps-1' }),
      sess('b', { recap: 'Ask', state: 'needs_you' }),
      sess('c', { recap: 'Work', state: 'working' }),
      sess('d', { recap: 'Bg', state: 'background', background: { tasks: 3, wakeAt: 0 } }),
      sess('e', { recap: 'Fin', unread: true }),
      sess('f', { recap: 'Old', updatedAt: NOW - 2 * 3600_000 }),
    ], {
      asks,
      events: { c: [
        { seq: 1, session: 'c', ts: 1, kind: 'tool_start', data: { id: 't1', name: 'Read', summary: 'a.ts' } },
        { seq: 2, session: 'c', ts: 2, kind: 'tool_start', data: { id: 't2', name: 'Bash', summary: 'npm test' } },
      ] },
    })
    view(s)
    expect(rowText('Perm')).toContain('Permission: Bash · Web · vps-1')
    expect(rowText('Ask')).toContain('Question · Web · vps-2')
    expect(rowText('Work')).toContain('Bash npm test · Web · vps-2')
    expect(rowText('Bg')).toContain('3 background tasks · Web · vps-2')
    expect(rowText('Fin')).toContain('Finished · Web · vps-2')
    expect(rowText('Old')).toContain('2 h ago · Web · vps-2')
  })

  it('marks a row whose machine is offline or unknown, and not the online ones', () => {
    view(build([
      sess('a', { recap: 'Up', machine: 'vps-1' }),
      sess('b', { recap: 'Down', machine: 'vps-2' }),
      sess('c', { recap: 'Unknown', machine: 'laptop' }),
    ], { machines: { 'vps-1': machine('vps-1'), 'vps-2': machine('vps-2', false) } as never }))
    expect(rowText('Up')).not.toContain('offline')
    expect(rowText('Down')).toMatch(/· vps-2 · offline$/)
    expect(rowText('Unknown')).toMatch(/· laptop · offline$/)
  })

  it('with no machines it says how to connect one; with machines and no sessions, no sessions', () => {
    const { unmount } = view(build([], { machines: {} }))
    expect(screen.getByText('No machines yet. Connect a daemon to the hub.')).toBeTruthy()
    expect(screen.queryByText('No sessions.')).toBeNull()
    unmount()
    view(build([]))
    expect(screen.getByText('No sessions.')).toBeTruthy()
    expect(screen.queryByText(/No machines yet/)).toBeNull()
  })

  it('opens a session on tap', () => {
    const onOpen = vi.fn()
    view(build([sess('a', { recap: 'Hello' })]), { onOpen })
    fireEvent.click(screen.getByText('Hello'))
    expect(onOpen).toHaveBeenCalledWith('a')
  })

  it('filters by job with chips and remembers the choice', () => {
    const s = build([sess('a', { recap: 'In web' }), sess('b', { recap: 'In notes', projectId: 'p2' }), sess('c', { recap: 'Loose', projectId: 'zz' })])
    view(s)
    expect(screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual(['All'])
    fireEvent.click(screen.getByRole('button', { name: 'Personal' }))
    expect(screen.queryByText('In web')).toBeNull()
    expect(screen.queryByText('Loose')).toBeNull()
    expect(screen.getByText('In notes')).toBeTruthy()
    expect(store.get(INBOX_JOB_KEY)).toBe('w2')
    cleanup()
    view(s)
    expect(screen.queryByText('In web')).toBeNull()
    expect(screen.getByRole('button', { name: 'Personal' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('In web')).toBeTruthy()
    expect(store.get(INBOX_JOB_KEY)).toBe('')
  })

  it('falls back to All when the stored job is gone', () => {
    store.set(INBOX_JOB_KEY, 'gone')
    view(build([sess('a', { recap: 'In web' })]))
    expect(screen.getByText('In web')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('320 px with long names: rows truncate and nothing sets a fixed wide width', () => {
    const long = 'An-extremely-long-unbreakable-session-name-that-would-push-the-layout-sideways-'.repeat(3)
    const s = build([sess('a', { recap: long, machine: 'machine-'.repeat(12), state: 'needs_you' })], { workspaces: { w1: ws('w1', long) } })
    const { container } = view(s)
    const row = screen.getAllByText(long).find((e) => e.closest('li'))!
    expect(row.className).toContain('truncate')
    expect(row.parentElement!.className).toContain('min-w-0')
    expect(within(screen.getByRole('group', { name: 'Filter by job' })).getByRole('button', { name: long }).className).toMatch(/max-w-.*truncate|truncate.*max-w-/)
    // the chips scroll inside their own row, the page never does
    expect(screen.getByRole('group', { name: 'Filter by job' }).closest('[data-slot="scroll-area"]')).toBeTruthy()
    expect(container.innerHTML).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/)
  })

  it('every row has a close menu that confirms before closing, beside the open button', async () => {
    const onOpen = vi.fn()
    view(build([sess('a', { recap: 'Hello' })]), { onOpen })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Session actions' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close session' }))
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith('a'))
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Hello'))
    expect(onOpen).toHaveBeenCalledWith('a')
  })

  it('a service row has no close menu', () => {
    view(build([sess('a', { recap: 'Work' }), sess('svc', { recap: 'Prod service', role: 'service' })]))
    const sec = screen.getByRole('region', { name: 'Services' })
    expect(within(sec).getByText('Prod service')).toBeTruthy()
    expect(within(sec).queryByRole('button', { name: 'Session actions' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Session actions' })).toHaveLength(1)
  })
})
