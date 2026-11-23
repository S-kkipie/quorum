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

describe('Session: menu ⋯', () => {
  it('"New session here" stays disabled while a launch is in progress', () => {
    const onGuard = vi.fn()
    render(<Session state={st()} id="a" onEvents={vi.fn()} busy onGuard={onGuard} />)
    fireEvent.click(screen.getByLabelText('More actions'))
    const it = screen.getByRole('menuitem', { name: 'New session here' }) as HTMLButtonElement
    expect(it.disabled).toBe(true)
    fireEvent.click(it)
    expect(onGuard).not.toHaveBeenCalled()
  })
  it('closes with Escape and on an outside click; "View in terminal" opens the pane', () => {
    const onViewTerminal = vi.fn()
    render(<Session state={st()} id="a" onEvents={vi.fn()} onViewTerminal={onViewTerminal} />)
    fireEvent.click(screen.getByLabelText('More actions'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByLabelText('More actions'))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByLabelText('More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'View in terminal' }))
    expect(onViewTerminal).toHaveBeenCalledWith('vps-2', 'p1')
  })
  it('a closed session does not offer "View in terminal"', () => {
    const s = st()
    s.sessions.a = sess('a', { herdrPane: 'p1', state: 'closed' })
    render(<Session state={s} id="a" onEvents={vi.fn()} onViewTerminal={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('More actions'))
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
  it('menu has Close session, which asks for confirmation', () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    render(<Session state={st()} id="a" onEvents={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('More actions'))
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
