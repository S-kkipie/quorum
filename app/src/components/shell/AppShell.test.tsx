// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import AppShell from './AppShell'
import { initialState, type AppState } from '../../lib/store'
import { LAYOUT_KEY, SIDEBAR_DEFAULT, resetLayout } from '../../lib/useLayout'
import { proj, sess } from '../../lib/fixtures.test-util'
import type { Centre } from '../../lib/nav'
import type { SessionInfo } from '../../proto.gen'
import * as api from '../../lib/api'

vi.mock('../../lib/api', () => ({ closeSession: vi.fn() }))

let store: Map<string, string>
beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  resetLayout()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(api.closeSession).mockReset() })

const ws = (id: string, name: string) => ({ id, name, color: '#123456', whoasProfile: '' })
function build(sessions: SessionInfo[], o: Partial<AppState> = {}): AppState {
  return {
    ...initialState(),
    machines: { 'vps-1': { name: 'vps-1', os: 'linux', env: '', version: '', online: true, lastSeen: 0 } as any },
    workspaces: { w1: ws('w1', 'ACME'), w2: ws('w2', 'Personal') },
    projects: { p1: proj('p1', { name: 'Web' }), p2: proj('p2', { name: 'Empty' }), p3: proj('p3', { workspaceId: 'w2', name: 'Notes' }) },
    sessions: Object.fromEntries(sessions.map((x) => [x.id, x])),
    order: sessions.map((x) => x.id),
    ...o,
  }
}

function shell(state: AppState, o: { centre?: Centre; onOpenSession?: (id: string) => void; onOpenProject?: (id: string) => void; onLaunch?: (s: { projectId?: string; workspaceId?: string }) => void; onSettings?: () => void } = {}) {
  const props = { onOpenSession: vi.fn(), onOpenProject: vi.fn(), onLaunch: vi.fn(), onSettings: vi.fn(), ...o }
  const r = render(
    <AppShell state={state} centre={o.centre ?? { kind: 'projects' }} connected {...props}>
      <p>centre content</p>
    </AppShell>,
  )
  return { ...r, ...props }
}
const nav = () => screen.getByRole('navigation', { name: 'Sessions' })

describe('AppShell sidebar', () => {
  it('a session row closes from its menu after a confirmation; the name still opens it', async () => {
    vi.mocked(api.closeSession).mockResolvedValue(undefined as never)
    const { onOpenSession } = shell(build([sess('a', { recap: 'Closable' })]))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Session actions' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close session' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => expect(api.closeSession).toHaveBeenCalledWith('a'))
    expect(onOpenSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Closable'))
    expect(onOpenSession).toHaveBeenCalledWith('a')
  })
  it('shows the brand, the jobs with their projects and sessions, and the centre', () => {
    shell(build([sess('a', { recap: 'Fix login' }), sess('b', { projectId: 'p3', recap: 'Write notes' })]))
    expect(screen.getByText('Quorum')).toBeTruthy()
    expect(screen.getByText('centre content')).toBeTruthy()
    const side = nav()
    expect(within(side).getByText('ACME')).toBeTruthy()
    expect(within(side).getByText('Personal')).toBeTruthy()
    expect(within(side).getByText('Fix login')).toBeTruthy()
    expect(within(side).getByText('Write notes')).toBeTruthy()
    // a project with no sessions
    const empty = within(side).getByRole('button', { name: 'Empty' }).closest('li')!
    expect(within(empty).getByText(/No sessions/)).toBeTruthy()
  })

  it('Needs you is pinned with the project name, and hidden when empty', () => {
    const { unmount } = shell(build([sess('a', { state: 'needs_you', recap: 'Approve deploy' }), sess('b')]))
    const pinned = screen.getByRole('region', { name: 'Needs you' })
    expect(within(pinned).getByText('Approve deploy')).toBeTruthy()
    expect(within(pinned).getByText(/Web/)).toBeTruthy()
    unmount()
    shell(build([sess('b', { state: 'working' })]))
    expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull()
  })

  it('search filters by name, project and machine', () => {
    shell(build([sess('a', { recap: 'Fix login' }), sess('b', { projectId: 'p3', recap: 'Write notes', machine: 'laptop' })]))
    const box = screen.getByRole('searchbox', { name: 'Search sessions' })
    fireEvent.change(box, { target: { value: 'LOGIN' } })
    expect(within(nav()).queryByText('Write notes')).toBeNull()
    expect(within(nav()).getByText('Fix login')).toBeTruthy()
    fireEvent.change(box, { target: { value: 'notes' } }) // project name
    expect(within(nav()).getByText('Write notes')).toBeTruthy()
    expect(within(nav()).queryByText('Fix login')).toBeNull()
    fireEvent.change(box, { target: { value: 'laptop' } }) // machine
    expect(within(nav()).getByText('Write notes')).toBeTruthy()
    expect(within(nav()).queryByText('Fix login')).toBeNull()
    fireEvent.change(box, { target: { value: 'zzz' } })
    expect(within(nav()).getByText('No matching sessions.')).toBeTruthy()
  })

  it('Ctrl+K and Cmd+K focus the search, also when the sidebar is hidden', () => {
    shell(build([sess('a')]))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search sessions' }))
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByRole('searchbox', { name: 'Search sessions' })).toBeNull()
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search sessions' }))
  })

  it('Ctrl+B toggles the sidebar and the choice is persisted', () => {
    shell(build([sess('a')]))
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeNull()
    expect(JSON.parse(store.get(LAYOUT_KEY)!).sidebarOpen).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Show sidebar' }))
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'B', metaKey: true, shiftKey: false })
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeNull()
  })

  it('a session click opens it; the open one carries aria-current', () => {
    const { onOpenSession } = shell(build([sess('a', { recap: 'Fix login' }), sess('b', { recap: 'Other' })]), { centre: { kind: 'session', id: 'b' } })
    fireEvent.click(within(nav()).getByText('Fix login'))
    expect(onOpenSession).toHaveBeenCalledWith('a')
    expect(within(nav()).getByText('Other').closest('button')!.getAttribute('aria-current')).toBe('page')
    expect(within(nav()).getByText('Fix login').closest('button')!.getAttribute('aria-current')).toBeNull()
  })

  it('a needs-you session that is open is aria-current only on its tree row, not on the pinned copy', () => {
    shell(build([sess('a', { state: 'needs_you', recap: 'Approve deploy' })]), { centre: { kind: 'session', id: 'a' } })
    const current = nav().querySelectorAll('[aria-current]')
    expect(current).toHaveLength(1)
    expect(within(screen.getByRole('region', { name: 'Needs you' })).getByText('Approve deploy').closest('button')!.getAttribute('aria-current')).toBeNull()
    expect(current[0].textContent).toContain('Approve deploy')
  })

  it('Ctrl+B and Ctrl+K are ignored while a modal dialog is open or when the key was already handled', () => {
    shell(build([sess('a')]))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    document.body.appendChild(dialog)
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeTruthy()
    expect(document.activeElement).not.toBe(screen.getByRole('searchbox', { name: 'Search sessions' }))
    dialog.remove()
    const e = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, cancelable: true, bubbles: true })
    e.preventDefault()
    act(() => { window.dispatchEvent(e) })
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeNull()
  })

  it('project names open the project page; the toggle collapses it and is persisted', () => {
    const { onOpenProject, unmount } = shell(build([sess('a', { recap: 'Fix login' })]))
    fireEvent.click(within(nav()).getByRole('button', { name: 'Web' }))
    expect(onOpenProject).toHaveBeenCalledWith('p1')
    const toggle = within(nav()).getByRole('button', { name: 'Collapse Web' })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(within(nav()).queryByText('Fix login')).toBeNull()
    unmount()
    shell(build([sess('a', { recap: 'Fix login' })]))
    expect(within(nav()).queryByText('Fix login')).toBeNull()
    expect(within(nav()).getByRole('button', { name: 'Expand Web' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('the job + and "Start one" open the launch dialog scoped; the footer opens an unscoped one', () => {
    const { onLaunch, onSettings } = shell(build([]))
    fireEvent.click(within(nav()).getByRole('button', { name: 'New session in ACME' }))
    expect(onLaunch).toHaveBeenLastCalledWith({ workspaceId: 'w1' })
    const empty = within(nav()).getByRole('button', { name: 'Empty' }).closest('li')!
    fireEvent.click(within(empty).getByRole('button', { name: 'Start one' }))
    expect(onLaunch).toHaveBeenLastCalledWith({ projectId: 'p2' })
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onLaunch).toHaveBeenLastCalledWith({})
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSettings).toHaveBeenCalled()
    expect(screen.getByText('connected')).toBeTruthy()
  })

  it('120 sessions with 200-character CJK and emoji names truncate on one line with a title', () => {
    const long = (i: number) => ('修复登录页面并部署到生产环境🚀✨ ' + i + ' ').repeat(12).slice(0, 200)
    const many = Array.from({ length: 120 }, (_, i) => sess('s' + i, { recap: long(i), projectId: ['p1', 'p3'][i % 2], state: i % 7 === 0 ? 'needs_you' : 'idle' }))
    shell(build(many))
    const side = nav()
    const rows = within(side).getAllByRole('button').filter((b) => b.getAttribute('data-session'))
    expect(rows.length).toBeGreaterThanOrEqual(120)
    for (const r of rows) {
      expect(r.className).toContain('min-w-0')
      const name = r.querySelector('[data-name]')!
      expect(name.className).toContain('truncate')
      expect(r.getAttribute('title')).toBe(name.textContent)
    }
    // the sidebar never scrolls sideways
    expect(side.closest('[data-slot="scroll-area"]')).toBeTruthy()
  })

  it('the resize handle: arrows change the width within 220–380 px, and it persists', () => {
    shell(build([]))
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT))
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT + 10))
    fireEvent.keyDown(handle, { key: 'End' })
    expect(handle.getAttribute('aria-valuenow')).toBe('380')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(handle.getAttribute('aria-valuenow')).toBe('380')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(handle.getAttribute('aria-valuenow')).toBe('220')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle.getAttribute('aria-valuenow')).toBe('220')
    expect(JSON.parse(store.get(LAYOUT_KEY)!).sidebarWidth).toBe(220)
  })

  it('dragging the handle resizes the sidebar', () => {
    shell(build([]))
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    act(() => { fireEvent.pointerDown(handle, { clientX: 270, button: 0 }) })
    act(() => { fireEvent.pointerMove(window, { clientX: 320 }) })
    act(() => { fireEvent.pointerUp(window, { clientX: 320 }) })
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
    act(() => { fireEvent.pointerMove(window, { clientX: 100 }) })
    expect(handle.getAttribute('aria-valuenow')).toBe('320')
  })

  it('a drag keeps the width local while moving and stores it once, on release', () => {
    const writes: string[] = []
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(k); store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    shell(build([]))
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const aside = () => screen.getByRole('complementary')
    act(() => { fireEvent.pointerDown(handle, { clientX: 270, button: 0 }) })
    act(() => { fireEvent.pointerMove(window, { clientX: 290 }) })
    act(() => { fireEvent.pointerMove(window, { clientX: 310 }) })
    act(() => { fireEvent.pointerMove(window, { clientX: 999 }) })
    expect(handle.getAttribute('aria-valuenow')).toBe('380')
    expect(aside().style.width).toBe('380px')
    expect(writes).toEqual([])
    act(() => { fireEvent.pointerMove(window, { clientX: 300 }) })
    act(() => { fireEvent.pointerUp(window, { clientX: 300 }) })
    expect(writes).toEqual([LAYOUT_KEY])
    expect(JSON.parse(store.get(LAYOUT_KEY)!).sidebarWidth).toBe(300)
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
    // a stray pointerup with no drag writes nothing
    act(() => { fireEvent.pointerUp(window, { clientX: 300 }) })
    expect(writes).toEqual([LAYOUT_KEY])
  })

  it('a throwing storage still renders with the default width', () => {
    const boom = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    resetLayout()
    shell(build([sess('a', { recap: 'Fix login' })]))
    expect(screen.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT))
    fireEvent.click(within(nav()).getByRole('button', { name: 'Collapse Web' }))
    expect(within(nav()).queryByText('Fix login')).toBeNull()
  })
})
