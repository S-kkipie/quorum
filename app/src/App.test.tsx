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

const info = (id: string, previousId = '') => ({ id, previousId, machine: 'm', name: 'session-' + id, cwd: '/x', root: '/x', model: '', role: 'work', state: 'idle', contextPct: 0, startedAt: 0, updatedAt: 0, transcriptPath: '' })
afterEach(() => { cleanup(); restSessions = []; FakeWS.all = []; history.replaceState(null, '') })
const setVisibility = (v: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

describe('App', () => {
  it('follows the replaced session without remounting or losing the draft', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    fireEvent.click(await screen.findByText('session-a'))
    const box = (await screen.findByPlaceholderText('Type a message…')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'draft' } })
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('b', 'a') }) }))
    await waitFor(() => expect(screen.getAllByText('session-b').length).toBeGreaterThan(0))
    expect(screen.queryByText('Session not found.')).toBeNull()
    expect((screen.getByPlaceholderText('Type a message…') as HTMLTextAreaElement).value).toBe('draft')
    expect(screen.getByPlaceholderText('Type a message…')).toBe(box)
  })

  it('no modes: there is no "Away" control and the app sends no watch (not even when hidden)', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    fireEvent.click(await screen.findByText('session-a'))
    await screen.findByPlaceholderText('Type a message…')
    expect(screen.queryByLabelText('Away')).toBeNull()
    expect(screen.queryByText('Away')).toBeNull()
    setVisibility('hidden')
    setVisibility('visible')
    expect(ws().sent.filter((m) => m.type === 'watch')).toEqual([])
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/presence'))).toBe(false)
  })

  it('on reconnect it replaces the sessions with the REST list (rename during the outage)', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    fireEvent.click(await screen.findByText('session-a'))
    // during the outage, /clear renames a -> b
    restSessions = [info('b', 'a')]
    const first = ws()
    act(() => first.onclose())
    await waitFor(() => expect(ws()).not.toBe(first), { timeout: 3000 })
    await waitFor(() => expect(screen.getAllByText('session-b').length).toBeGreaterThan(0))
    expect(screen.queryByText('session-a')).toBeNull()
    expect(ws().sent.filter((m) => m.type === 'watch')).toEqual([])
  })

  it('Ruling Q: the old session that comes back opens without jumping to the new one', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    send({ type: 'session_upsert', payload: info('a') })
    send({ type: 'session_upsert', payload: info('b', 'a') })
    send({ type: 'session_upsert', payload: info('a') }) // claude --resume a
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    fireEvent.click(await screen.findByText('session-a'))
    send({ type: 'session_upsert', payload: { ...info('b', 'a'), state: 'working' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getAllByText('session-a').length).toBeGreaterThan(0)
  })

  it('reopening from the list the replaced session already shown does not remount it', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }))
    fireEvent.click(await screen.findByText('session-a'))
    const box = (await screen.findByPlaceholderText('Type a message…')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'draft' } })
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('b', 'a') }) }))
    await waitFor(() => expect(screen.getAllByText('session-b').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('session-b')[0])
    expect(screen.getByPlaceholderText('Type a message…')).toBe(box)
    expect(box.value).toBe('draft')
  })

  it('starts on Projects: card per workspace and project detail with its tickets', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    expect(screen.getByRole('tab', { name: 'Projects' }).getAttribute('aria-selected')).toBe('true')
    send({ type: 'workspace_upsert', payload: { id: 'w1', name: 'ACME', color: '#f00', whoasProfile: '' } })
    send({ type: 'project_upsert', payload: { id: 'p1', workspaceId: 'w1', name: 'Quorum', repoUrl: '', connector: { kind: 'exec', settings: {}, hasToken: false, intervalMin: 5 }, summary: 'Going', summaryAt: 0, progress: { done: 1, total: 2 }, syncError: '', syncedAt: 0 } })
    send({ type: 'tickets', payload: { projectId: 'p1', tickets: [{ id: 't1', projectId: 'p1', externalId: '1', title: 'Fix login', status: 'todo', rawStatus: 'open', assignee: '', url: '', body: '', comments: [], updatedAt: 1 }] } })
    expect(screen.getByText('ACME')).toBeTruthy()
    fireEvent.click(screen.getByText('Quorum', { selector: 'span' }))
    expect(await screen.findByText('Fix login')).toBeTruthy()
    expect(screen.getByText('Checkouts')).toBeTruthy()
  })

  it('desktop: "Back" in Settings does not leave the app (no history.back)', async () => {
    const spy = vi.spyOn(history, 'back')
    render(<App />)
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText('Workspaces')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByText('Workspaces')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('Launch shows "Starting Claude on vps-1…" and launch_session opens the session', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    send({ type: 'machine_status', payload: { name: 'vps-1', os: 'linux', env: 'linux', version: '', online: true, lastSeen: 0, caps: { herdr: true, terminal: true, root: false } } })
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    fireEvent.change(await screen.findByPlaceholderText('/path/to/project'), { target: { value: '/srv/x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByText('Starting Claude on vps-1…')
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/launch'))!
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ machine: 'vps-1', dir: '/srv/x', permissionMode: 'bypass' })
    // other reqId: ignored
    send({ type: 'launch_session', payload: { reqId: 'other', sessionId: 'zz' } })
    expect(screen.getByText('Starting Claude on vps-1…')).toBeTruthy()
    send({ type: 'session_upsert', payload: info('new') })
    send({ type: 'launch_session', payload: { reqId: 'r1', sessionId: 'new' } })
    await waitFor(() => expect(screen.queryByText('Starting Claude on vps-1…')).toBeNull())
    await screen.findByPlaceholderText('Type a message…')
  })
})
