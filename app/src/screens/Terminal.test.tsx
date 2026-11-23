// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import Terminal from './Terminal'
import { frames } from '../lib/frames'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ansi: 'viejo', pane: 'p2', cols: 80, rows: 24 })))
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem: () => {}, removeItem: () => {} })
const calls = (suffix: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix))
const bodies = () => calls('/input').map((c) => JSON.parse(String(c[1]?.body)))
const fr = (o: object = {}) => ({ pane: 'p1', cols: 80, rows: 24, ansi: 'hola \x1b[31mmundo\x1b[0m', closed: false, ...o })
const mount = (p: object = {}) => render(<Terminal machine="m1" pane="p1" onBack={vi.fn()} {...p} />)

const push = (o: object = {}) => act(() => { frames.set('m1', 'p1', fr(o)) })
afterEach(() => { cleanup(); fetchMock.mockClear(); vi.useRealTimers() })

describe('Terminal', () => {
  it('muestra la foto', () => {
    mount(); push()
    expect(screen.getByText('mundo').style.color).not.toBe('')
    expect(screen.getByText(/hola/)).toBeTruthy()
  })
  it('Ctrl-C manda la tecla', () => {
    mount(); push()
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl-C' }))
    expect(bodies()).toEqual([{ keys: ['ctrl+c'] }])
  })
  it('ls + ⏎ manda texto y luego enter', async () => {
    mount(); push()
    fireEvent.change(screen.getByPlaceholderText('Escribe…'), { target: { value: 'ls' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '⏎' })) })
    expect(bodies()).toEqual([{ text: 'ls' }, { keys: ['enter'] }])
  })
  it('campo vacío: ⏎ solo manda Enter', async () => {
    mount(); push()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '⏎' })) })
    expect(bodies()).toEqual([{ keys: ['enter'] }])
  })
  it('Closed muestra aviso y Abrir otra', () => {
    mount({ root: '/r', label: 'r' }); push({ closed: true })
    expect(screen.getByText('La terminal se cerró')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Abrir otra' })).toBeTruthy()
  })
  it('renueva watch cada 5 s', async () => {
    vi.useFakeTimers()
    mount(); push()
    expect(calls('/watch').length).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(calls('/watch').length).toBe(3)
  })
  it('foto vieja de otra visita no se muestra al montar', async () => {
    frames.set('m1', 'p1', fr())
    await new Promise((r) => setTimeout(r, 5))
    mount()
    expect(screen.queryByText('mundo')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ctrl-C' })).toBeTruthy()
    push({ ansi: 'fresca' })
    expect(screen.getByText('fresca')).toBeTruthy()
  })
  it('falla de watch muestra Sin señal con el motivo', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('offline', { status: 409 }))
    mount(); push()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Sin señal')
  })
  it('sin foto ni watch ok en 10 s: Sin señal reintentando', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(() => new Promise(() => {}))
    mount(); push()
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    expect(screen.getByRole('status').textContent).toContain('reintentando')
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ansi: 'viejo', pane: 'p2', cols: 80, rows: 24 })))
  })
  it('al cerrarse deja de renovar el watch', async () => {
    vi.useFakeTimers()
    mount(); push({ closed: true })
    const n = calls('/watch').length
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(calls('/watch').length).toBe(n)
  })
  it('sin foto en 3 s: Conectando', async () => {
    vi.useFakeTimers()
    mount({ pane: 'nada' })
    expect(screen.queryByText('Conectando con la terminal…')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(screen.getByText('Conectando con la terminal…')).toBeTruthy()
  })
  it('Historial lee 400 líneas y En vivo vuelve', async () => {
    mount(); push()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Historial' })) })
    expect(calls('/read?lines=400').length).toBe(1)
    expect(screen.getByText('viejo')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'En vivo' }))
    expect(screen.getByText('mundo')).toBeTruthy()
  })
  it('Cerrar terminal confirma, cierra y vuelve', async () => {
    const onBack = vi.fn()
    vi.stubGlobal('confirm', () => true)
    mount({ onBack, root: '/proj' }); push()
    fireEvent.click(screen.getByRole('button', { name: '⋯' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cerrar terminal' })) })
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(true)
    expect(onBack).toHaveBeenCalled()
  })
  it('sin root (no la abrió Quorum) no ofrece Cerrar terminal', () => {
    mount(); push()
    expect(screen.queryByRole('button', { name: '⋯' })).toBeNull()
    expect(screen.queryByText('Cerrar terminal')).toBeNull()
  })
  it('si el envío falla, devuelve lo escrito al campo', async () => {
    mount(); push()
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"no"}', { status: 502 }))
    const input = screen.getByPlaceholderText('Escribe…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'git status' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '⏎' })) })
    expect(input.value).toBe('git status')
    expect(bodies()).toEqual([{ text: 'git status' }])
  })
})
