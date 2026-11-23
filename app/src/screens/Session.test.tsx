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

describe('Session: menú ⋯', () => {
  it('"Nueva sesión aquí" queda deshabilitada mientras hay un lanzamiento', () => {
    const onGuard = vi.fn()
    render(<Session state={st()} id="a" onEvents={vi.fn()} busy onGuard={onGuard} />)
    fireEvent.click(screen.getByLabelText('Más acciones'))
    const it = screen.getByRole('menuitem', { name: 'Nueva sesión aquí' }) as HTMLButtonElement
    expect(it.disabled).toBe(true)
    fireEvent.click(it)
    expect(onGuard).not.toHaveBeenCalled()
  })
  it('se cierra con Escape y al hacer clic fuera; "Ver en terminal" abre el panel', () => {
    const onViewTerminal = vi.fn()
    render(<Session state={st()} id="a" onEvents={vi.fn()} onViewTerminal={onViewTerminal} />)
    fireEvent.click(screen.getByLabelText('Más acciones'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByLabelText('Más acciones'))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByLabelText('Más acciones'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ver en terminal' }))
    expect(onViewTerminal).toHaveBeenCalledWith('vps-2', 'p1')
  })
  it('una sesión cerrada no ofrece "Ver en terminal"', () => {
    const s = st()
    s.sessions.a = sess('a', { herdrPane: 'p1', state: 'closed' })
    render(<Session state={s} id="a" onEvents={vi.fn()} onViewTerminal={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Más acciones'))
    expect(screen.queryByRole('menuitem', { name: 'Ver en terminal' })).toBeNull()
  })
})
