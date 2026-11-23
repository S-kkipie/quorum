// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Project from './Project'
import { initialState, setCheckouts } from '../lib/store'
import { proj } from '../lib/fixtures.test-util'

const fetchMock = vi.fn(async (u: string, _i?: RequestInit) => {
  if (String(u).includes('/conversations')) return new Response(JSON.stringify([{ id: 'c9', title: 'Vieja', firstPrompt: '', messages: 4, updatedAt: Date.now(), open: false }]))
  if (String(u).endsWith('/api/launch')) return new Response(JSON.stringify({ reqId: 'r1' }))
  return new Response('[]')
})
vi.stubGlobal('fetch', fetchMock)
vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
afterEach(() => { cleanup(); fetchMock.mockClear() })

function state() {
  let s = setCheckouts(initialState(), 'p1', [{ id: 'c1', projectId: 'p1', machine: 'm1', root: '/r', repoUrl: '', branch: '', updatedAt: 1 }])
  s = { ...s, projects: { p1: proj('p1') }, machines: { m1: { name: 'm1', os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: { herdr: false, terminal: false, root: false } } } }
  return s
}
// misma semántica que la guarda de App: síncrona, una a la vez
function makeGuard(onLaunched: (p: any) => void) {
  let busy = false
  return async (fn: () => Promise<any>) => {
    if (busy) return
    busy = true
    try { onLaunched(await fn()) } finally { busy = false }
  }
}

describe('Project: retomar', () => {
  it('doble toque en una conversación cerrada lanza una sola vez, con resume', async () => {
    const onLaunched = vi.fn()
    render(<Project state={state()} id="p1" onGuard={makeGuard(onLaunched)} onLaunched={onLaunched} />)
    const row = await screen.findByText('Vieja')
    fireEvent.click(row)
    fireEvent.click(row)
    await waitFor(() => expect(onLaunched).toHaveBeenCalledTimes(1))
    const calls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/launch'))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0][1]?.body)).resume).toBe('c9')
  })
  it('con un lanzamiento en curso (pending) no se retoma', async () => {
    render(<Project state={state()} id="p1" pending onGuard={makeGuard(vi.fn())} onLaunched={vi.fn()} />)
    fireEvent.click(await screen.findByText('Vieja'))
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/launch'))).toHaveLength(0)
  })
})
