// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import Terminal from './Terminal'
import { frames } from '../lib/frames'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ ansi: 'old', pane: 'p2', cols: 80, rows: 24 })))
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem: () => {}, removeItem: () => {} })
const calls = (suffix: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix))
const bodies = () => calls('/input').map((c) => JSON.parse(String(c[1]?.body)))
const fr = (o: object = {}) => ({ pane: 'p1', cols: 80, rows: 24, ansi: 'hello \x1b[31mworld\x1b[0m', closed: false, ...o })
const mount = (p: object = {}) => render(<Terminal machine="m1" pane="p1" onBack={vi.fn()} {...p} />)

const push = (o: object = {}) => act(() => { frames.set('m1', 'p1', fr(o)) })
afterEach(() => { cleanup(); fetchMock.mockClear(); vi.useRealTimers() })

describe('Terminal', () => {
  it('shows the snapshot', () => {
    mount(); push()
    expect(screen.getByText('world').style.color).not.toBe('')
    expect(screen.getByText(/hello/)).toBeTruthy()
  })
  it('Ctrl-C sends the key', () => {
    mount(); push()
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl-C' }))
    expect(bodies()).toEqual([{ keys: ['ctrl+c'] }])
  })
  it('ls + ⏎ sends text and then enter', async () => {
    mount(); push()
    fireEvent.change(screen.getByPlaceholderText('Type…'), { target: { value: 'ls' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '⏎' })) })
    expect(bodies()).toEqual([{ text: 'ls' }, { keys: ['enter'] }])
  })
  it('empty field: ⏎ only sends Enter', async () => {
    mount(); push()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '⏎' })) })
    expect(bodies()).toEqual([{ keys: ['enter'] }])
  })
  it('Closed shows a notice and Open another', () => {
    mount({ root: '/r', label: 'r' }); push({ closed: true })
    expect(screen.getByText('Terminal closed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open another' })).toBeTruthy()
  })
  it('renews watch every 5 s', async () => {
    vi.useFakeTimers()
    mount(); push()
    expect(calls('/watch').length).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(calls('/watch').length).toBe(3)
  })
  it('a stale snapshot from another visit is not shown on mount', async () => {
    frames.set('m1', 'p1', fr())
    await new Promise((r) => setTimeout(r, 5))
    mount()
    expect(screen.queryByText('world')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Ctrl-C' })).toBeTruthy()
    push({ ansi: 'fresh' })
    expect(screen.getByText('fresh')).toBeTruthy()
  })
  it('a watch failure shows No signal with the reason', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('offline', { status: 409 }))
    mount(); push()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('No signal')
  })
  it('no snapshot or watch ok in 10 s: No signal, retrying', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(() => new Promise(() => {}))
    mount(); push()
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    expect(screen.getByRole('status').textContent).toContain('retrying')
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ansi: 'old', pane: 'p2', cols: 80, rows: 24 })))
  })
  it('once closed it stops renewing the watch', async () => {
    vi.useFakeTimers()
    mount(); push({ closed: true })
    const n = calls('/watch').length
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(calls('/watch').length).toBe(n)
  })
  it('no snapshot in 3 s: Connecting', async () => {
    vi.useFakeTimers()
    mount({ pane: 'none' })
    expect(screen.queryByText('Connecting to the terminal…')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(screen.getByText('Connecting to the terminal…')).toBeTruthy()
  })
  it('History reads 400 lines and Live goes back', async () => {
    mount(); push()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'History' })) })
    expect(calls('/read?lines=400').length).toBe(1)
    expect(screen.getByText('old')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Live' }))
    expect(screen.getByText('world')).toBeTruthy()
  })
  it('Close terminal confirms, closes and goes back', async () => {
    const onBack = vi.fn()
    vi.stubGlobal('confirm', () => true)
    mount({ onBack, root: '/proj' }); push()
    fireEvent.click(screen.getByRole('button', { name: '⋯' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close terminal' })) })
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(true)
    expect(onBack).toHaveBeenCalled()
  })
  it('without root (not opened by Quorum) it does not offer Close terminal', () => {
    mount(); push()
    expect(screen.queryByRole('button', { name: '⋯' })).toBeNull()
    expect(screen.queryByText('Close terminal')).toBeNull()
  })
  it('if sending fails, the typed text goes back to the field', async () => {
    mount(); push()
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"no"}', { status: 502 }))
    const input = screen.getByPlaceholderText('Type…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'git status' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '⏎' })) })
    expect(input.value).toBe('git status')
    expect(bodies()).toEqual([{ text: 'git status' }])
  })
})
