// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

class FakeWS {
  static OPEN = 1
  static all: FakeWS[] = []
  readyState = 1
  sent: any[] = []
  onopen: any; onmessage: any; onclose: any; onerror: any
  constructor(public url: string) { FakeWS.all.push(this); setTimeout(() => this.onopen?.(), 0) }
  send(m: string) { this.sent.push(JSON.parse(m)) }
  close() {}
}
vi.stubGlobal('WebSocket', FakeWS)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
let restSessions: any[] = []
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (String(url).includes('/api/sessions?')) return new Response(JSON.stringify(restSessions))
  if (String(url).endsWith('/api/launch')) return new Response(JSON.stringify({ reqId: 'r1' }), { status: 202 })
  if (init?.method === 'POST') return new Response('', { status: 202 })
  return new Response('[]')
})
vi.stubGlobal('fetch', fetchMock)
import App from './App'

const info = (id: string, previousId = '') => ({ id, previousId, machine: 'm', name: 'sesion-' + id, cwd: '/x', root: '/x', model: '', role: 'work', state: 'idle', contextPct: 0, startedAt: 0, updatedAt: 0, transcriptPath: '' })
afterEach(() => { cleanup(); restSessions = []; FakeWS.all = []; history.replaceState(null, '') })
const setVisibility = (v: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

describe('App', () => {
  it('sigue a la sesión reemplazada sin remontar ni perder el borrador', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Sesiones' }))
    fireEvent.click(await screen.findByText('sesion-a'))
    const box = (await screen.findByPlaceholderText('Escribe un mensaje…')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'borrador' } })
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('b', 'a') }) }))
    await waitFor(() => expect(screen.getAllByText('sesion-b').length).toBeGreaterThan(0))
    expect(screen.queryByText('Sesión no encontrada.')).toBeNull()
    expect((screen.getByPlaceholderText('Escribe un mensaje…') as HTMLTextAreaElement).value).toBe('borrador')
    expect(screen.getByPlaceholderText('Escribe un mensaje…')).toBe(box)
  })

  it('sin modos: no hay control "Fuera" ni la app manda watch (ni al ocultarse)', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Sesiones' }))
    fireEvent.click(await screen.findByText('sesion-a'))
    await screen.findByPlaceholderText('Escribe un mensaje…')
    expect(screen.queryByLabelText('Fuera')).toBeNull()
    expect(screen.queryByText('Fuera')).toBeNull()
    setVisibility('hidden')
    setVisibility('visible')
    expect(ws().sent.filter((m) => m.type === 'watch')).toEqual([])
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/presence'))).toBe(false)
  })

  it('al reconectar reemplaza las sesiones con el REST (renombre durante la caída)', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Sesiones' }))
    fireEvent.click(await screen.findByText('sesion-a'))
    // durante la caída, /clear renombra a -> b
    restSessions = [info('b', 'a')]
    const first = ws()
    act(() => first.onclose())
    await waitFor(() => expect(ws()).not.toBe(first), { timeout: 3000 })
    await waitFor(() => expect(screen.getAllByText('sesion-b').length).toBeGreaterThan(0))
    expect(screen.queryByText('sesion-a')).toBeNull()
    expect(ws().sent.filter((m) => m.type === 'watch')).toEqual([])
  })

  it('Ruling Q: la sesión vieja que vuelve se abre sin saltar a la nueva', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    send({ type: 'session_upsert', payload: info('a') })
    send({ type: 'session_upsert', payload: info('b', 'a') })
    send({ type: 'session_upsert', payload: info('a') }) // claude --resume a
    fireEvent.click(screen.getByRole('tab', { name: 'Sesiones' }))
    fireEvent.click(await screen.findByText('sesion-a'))
    send({ type: 'session_upsert', payload: { ...info('b', 'a'), state: 'working' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getAllByText('sesion-a').length).toBeGreaterThan(0)
  })

  it('volver a abrir desde la lista la sesión reemplazada que ya se ve no la remonta', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Sesiones' }))
    fireEvent.click(await screen.findByText('sesion-a'))
    const box = (await screen.findByPlaceholderText('Escribe un mensaje…')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'borrador' } })
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('b', 'a') }) }))
    await waitFor(() => expect(screen.getAllByText('sesion-b').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('sesion-b')[0])
    expect(screen.getByPlaceholderText('Escribe un mensaje…')).toBe(box)
    expect(box.value).toBe('borrador')
  })

  it('arranca en Proyectos: tarjeta por trabajo y detalle del proyecto con sus tickets', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    expect(screen.getByRole('tab', { name: 'Proyectos' }).getAttribute('aria-selected')).toBe('true')
    send({ type: 'workspace_upsert', payload: { id: 'w1', name: 'ACME', color: '#f00', whoasProfile: '' } })
    send({ type: 'project_upsert', payload: { id: 'p1', workspaceId: 'w1', name: 'Quorum', repoUrl: '', connector: { kind: 'exec', settings: {}, hasToken: false, intervalMin: 5 }, summary: 'En marcha', summaryAt: 0, progress: { done: 1, total: 2 }, syncError: '', syncedAt: 0 } })
    send({ type: 'tickets', payload: { projectId: 'p1', tickets: [{ id: 't1', projectId: 'p1', externalId: '1', title: 'Arreglar login', status: 'por_hacer', rawStatus: 'open', assignee: '', url: '', body: '', comments: [], updatedAt: 1 }] } })
    expect(screen.getByText('ACME')).toBeTruthy()
    fireEvent.click(screen.getByText('Quorum', { selector: 'span' }))
    expect(await screen.findByText('Arreglar login')).toBeTruthy()
    expect(screen.getByText('Checkouts')).toBeTruthy()
  })

  it('escritorio: "Volver" de Configuración no sale de la app (no usa history.back)', async () => {
    const spy = vi.spyOn(history, 'back')
    render(<App />)
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Configuración' }))
    expect(await screen.findByText('Trabajos')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Volver' }))
    expect(screen.queryByText('Trabajos')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('Lanzar muestra "Arrancando Claude en vps-1…" y launch_session abre la sesión', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    send({ type: 'machine_status', payload: { name: 'vps-1', os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: { herdr: true, terminal: true, root: false } } })
    fireEvent.click(screen.getByRole('button', { name: 'Lanzar' }))
    fireEvent.change(await screen.findByPlaceholderText('/ruta/al/proyecto'), { target: { value: '/srv/x' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Lanzar' }).pop()!)
    await screen.findByText('Arrancando Claude en vps-1…')
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/launch'))!
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ machine: 'vps-1', dir: '/srv/x', permissionMode: 'bypass' })
    // otro reqId: se ignora
    send({ type: 'launch_session', payload: { reqId: 'otro', sessionId: 'zz' } })
    expect(screen.getByText('Arrancando Claude en vps-1…')).toBeTruthy()
    send({ type: 'session_upsert', payload: info('nueva') })
    send({ type: 'launch_session', payload: { reqId: 'r1', sessionId: 'nueva' } })
    await waitFor(() => expect(screen.queryByText('Arrancando Claude en vps-1…')).toBeNull())
    await screen.findByPlaceholderText('Escribe un mensaje…')
  })
})
