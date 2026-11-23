// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NewSessionCard from './NewSessionCard'
import { initialState, setCheckouts } from '../lib/store'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ reqId: 'r1' })))
vi.stubGlobal('fetch', fetchMock)
const mem: Record<string, string> = { 'quorum.token': 'tok' }
vi.stubGlobal('localStorage', { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v }, removeItem: (k: string) => { delete mem[k] } })
beforeEach(() => { for (const k of Object.keys(mem)) if (k !== 'quorum.token') delete mem[k] })
afterEach(() => { cleanup(); fetchMock.mockClear() })

const caps = (o: Partial<{ herdr: boolean; terminal: boolean; root: boolean }> = {}) => ({ herdr: false, terminal: false, root: false, ...o })
function st(c = caps()) {
  const s = setCheckouts(initialState(), 'p1', [{ id: 'c1', projectId: 'p1', machine: 'vps-1', root: '/srv/repo', repoUrl: '', branch: 'main', updatedAt: 1 }])
  return { ...s, machines: { 'vps-1': { name: 'vps-1', os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: c } } }
}
const guard = (onLaunched: (p: any) => void) => async (fn: () => Promise<any>) => { onLaunched(await fn()) }
const onLaunchedDefault = vi.fn()
const props = { projectId: 'p1', pending: false, onLaunched: onLaunchedDefault, onGuard: guard(onLaunchedDefault), onTerminal: vi.fn() }

describe('NewSessionCard', () => {
  it('un toque lanza con la máquina, carpeta y modo; avisa onLaunched', async () => {
    const onLaunched = vi.fn()
    render(<NewSessionCard {...props} state={st()} onLaunched={onLaunched} onGuard={guard(onLaunched)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Nueva sesión' }))
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith({ reqId: 'r1', machine: 'vps-1', label: '/srv/repo' }))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ machine: 'vps-1', dir: '/srv/repo', permissionMode: 'bypass', projectId: 'p1' })
    expect(JSON.parse(mem['quorum.launch.p1'])).toEqual({ machine: 'vps-1', bypass: true })
  })
  it('con pending queda deshabilitada y no lanza', () => {
    render(<NewSessionCard {...props} state={st()} pending />)
    const b = screen.getByRole('button', { name: /Lanzando/ }) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    fireEvent.click(b)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('doble toque lanza una sola vez', async () => {
    render(<NewSessionCard {...props} state={st()} />)
    const b = screen.getByRole('button', { name: 'Nueva sesión' })
    fireEvent.click(b)
    fireEvent.click(b)
    await waitFor(() => expect(props.onLaunched).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('máquina root: "Sin permisos" deshabilitado con el motivo y lanza en default', async () => {
    render(<NewSessionCard {...props} state={st(caps({ root: true }))} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('Sin permisos no funciona como root')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Nueva sesión' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).permissionMode).toBe('default')
  })
  it('sin terminal muestra que falta herdr; con terminal, el botón llama onTerminal', () => {
    const { unmount } = render(<NewSessionCard {...props} state={st()} />)
    expect(screen.getByText('Terminal no disponible en esta máquina (falta herdr)')).toBeTruthy()
    unmount()
    const onTerminal = vi.fn()
    render(<NewSessionCard {...props} state={st(caps({ terminal: true }))} onTerminal={onTerminal} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(onTerminal).toHaveBeenCalledWith('vps-1', '/srv/repo')
  })
  it('Terminal: doble toque abre una sola vez', async () => {
    let done: () => void = () => {}
    const onTerminal = vi.fn(() => new Promise<void>((r) => { done = r }))
    render(<NewSessionCard {...props} state={st(caps({ terminal: true }))} onTerminal={onTerminal} />)
    const b = screen.getByRole('button', { name: 'Terminal' })
    fireEvent.click(b)
    fireEvent.click(b)
    expect(onTerminal).toHaveBeenCalledTimes(1)
    done()
  })
  it('sin checkouts: texto y enlace "Otra carpeta…"', () => {
    render(<NewSessionCard {...props} state={initialState()} />)
    expect(screen.getByText('Este proyecto todavía no tiene carpeta en ninguna máquina')).toBeTruthy()
    fireEvent.click(screen.getByText('Otra carpeta…'))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
  it('usa la máquina de las preferencias si está en línea', () => {
    mem['quorum.launch.p1'] = JSON.stringify({ machine: 'mac', bypass: false })
    let s = setCheckouts(st(), 'p1', [
      { id: 'c1', projectId: 'p1', machine: 'vps-1', root: '/a', repoUrl: '', branch: '', updatedAt: 1 },
      { id: 'c2', projectId: 'p1', machine: 'mac', root: '/b', repoUrl: '', branch: '', updatedAt: 1 },
    ])
    s = { ...s, machines: { ...s.machines, mac: { ...s.machines['vps-1'], name: 'mac' } } }
    const onSelect = vi.fn()
    render(<NewSessionCard {...props} state={s} onSelect={onSelect} />)
    expect(onSelect).toHaveBeenCalledWith('mac', '/b')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
})
