// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Session from './Session'
import { initialState } from '../lib/store'
import { sess } from '../lib/fixtures.test-util'

vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})
afterEach(cleanup)

const st = () => ({ ...initialState(), sessions: { a: sess('a', { herdrPane: 'p1' }) }, order: ['a'],
  machines: { 'vps-2': { name: 'vps-2', os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: { herdr: true, terminal: true, root: false } } } })

const openMenu = () => fireEvent.keyDown(screen.getByLabelText('More actions'), { key: 'Enter' })

describe('Session: not found', () => {
  it('offers Back so the dead end can be left', () => {
    const onBack = vi.fn()
    render(<Session state={st()} id="gone" onEvents={vi.fn()} onBack={onBack} />)
    expect(screen.getByText('Session not found.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalled()
  })
})

describe('Session: menu ⋯', () => {
  it('"New session here" stays disabled while a launch is in progress', () => {
    const onGuard = vi.fn()
    render(<Session state={st()} id="a" onEvents={vi.fn()} busy onGuard={onGuard} />)
    openMenu()
    const it = screen.getByRole('menuitem', { name: 'New session here' })
    expect(it.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(it)
    expect(onGuard).not.toHaveBeenCalled()
  })
  it('closes with Escape; "View in terminal" opens the pane', () => {
    const onViewTerminal = vi.fn()
    render(<Session state={st()} id="a" onEvents={vi.fn()} onViewTerminal={onViewTerminal} />)
    openMenu()
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View in terminal' }))
    expect(onViewTerminal).toHaveBeenCalledWith('vps-2', 'p1')
  })
  it('a closed session does not offer "View in terminal"', () => {
    const s = st()
    s.sessions.a = sess('a', { herdrPane: 'p1', state: 'closed' })
    render(<Session state={s} id="a" onEvents={vi.fn()} onViewTerminal={vi.fn()} />)
    openMenu()
    expect(screen.queryByRole('menuitem', { name: 'View in terminal' })).toBeNull()
  })
})

describe('Session header', () => {
  it('Interrupt only when working', () => {
    const s = st()
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull()
    cleanup()
    s.sessions.a = sess('a', { state: 'working' })
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()
  })
  it('working shows the working indicator in the transcript', () => {
    const s = st()
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.queryByText('Working…')).toBeNull()
    cleanup()
    s.sessions.a = sess('a', { state: 'working' })
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Working…')
  })
  it('artifact card Open passes the machine and the path', () => {
    const s = st()
    const ev = (seq: number, kind: string, data: any) => ({ seq, session: 'a', ts: 0, kind, data })
    s.events = { a: [ev(1, 'tool_start', { id: 'w', name: 'Write', summary: '', input: { file_path: '/r/out.html' } }), ev(2, 'tool_end', { id: 'w', ok: true, ms: 1, output: '' })] }
    const onOpenFile = vi.fn()
    render(<Session state={s} id="a" onEvents={vi.fn()} onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenFile).toHaveBeenCalledWith('vps-2', '/r/out.html')
  })
  it('menu has Close session, which asks for confirmation', () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    render(<Session state={st()} id="a" onEvents={vi.fn()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close session' }))
    expect(confirm).toHaveBeenCalled()
    expect((fetch as any).mock.calls.some(([u]: [string]) => String(u).includes('/close'))).toBe(false)
  })
  it('subtitle has no cwd path', () => {
    const s = st()
    s.sessions.a = sess('a', { cwd: '/srv/secret-dir', root: '/srv/secret-dir', model: 'opus', branch: 'main' })
    const { container } = render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByText('vps-2 · opus · main')).toBeTruthy()
    expect(container.querySelector('header')!.textContent).not.toContain('/srv/secret-dir')
  })
})

describe('Session: narrow header', () => {
  it('Interrupt is icon-only and the state pill moves to the second line', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    const s = { ...st(), sessions: { a: sess('a', { state: 'working' as any, model: 'opus' }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Interrupt' })
    expect(btn.textContent).toBe('')
    const pill = screen.getByText('Working')
    expect(pill.closest('header')!.querySelectorAll('div')[0].contains(pill)).toBe(false)
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
  })
})
