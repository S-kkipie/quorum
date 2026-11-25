// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

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
const store = new Map<string, string>([['quorum.token', 'tok']])
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
let isWide = true
vi.stubGlobal('matchMedia', () => ({ matches: isWide, addEventListener() {}, removeEventListener() {} }))
let restSessions: any[] = []
const ticketRow = { id: 't1', projectId: 'p1', externalId: '1', title: 'Fix login', status: 'todo', rawStatus: 'open', assignee: '', url: '', body: '', comments: [], updatedAt: 1 }
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (String(url).includes('/api/sessions?')) return new Response(JSON.stringify(restSessions))
  if (String(url).endsWith('/api/projects/p1/tickets')) return new Response(JSON.stringify([ticketRow]))
  if (String(url).endsWith('/api/launch')) return new Response(JSON.stringify({ reqId: 'r1' }), { status: 202 })
  if (init?.method === 'POST') return new Response('', { status: 202 })
  return new Response('[]')
})
vi.stubGlobal('fetch', fetchMock)
const { startPush } = vi.hoisted(() => ({ startPush: vi.fn(async (_open: (id: string) => void) => {}) }))
vi.mock('./lib/push', () => ({ startPush, stopPush: vi.fn() }))
import App from './App'

const info = (id: string, previousId = '') => ({ id, previousId, machine: 'm', name: 'session-' + id, cwd: '/x', root: '/x', model: '', role: 'work', state: 'idle', contextPct: 0, startedAt: 0, updatedAt: 0, transcriptPath: '' })
afterEach(() => { delete (window as any).Capacitor; startPush.mockClear(); isWide = true; cleanup(); restSessions = []; FakeWS.all = []; history.replaceState(null, '') })
const setVisibility = (v: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

function openMenu(name: string) {
  const t = screen.getByRole('button', { name })
  fireEvent.keyDown(t, { key: 'Enter' })
}

describe('App', () => {
  it('leaves the session view when the open session is removed (phone)', async () => {
    isWide = false
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    send({ type: 'session_upsert', payload: info('a') })
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy()
    fireEvent.click(await screen.findByText('session-a'))
    await screen.findByPlaceholderText('Type a message or / for commands')
    // inside a session the bottom nav is gone
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    send({ type: 'session_removed', session: 'a' })
    await waitFor(() => expect(screen.queryByPlaceholderText('Type a message or / for commands')).toBeNull())
    expect(screen.queryByText('Session not found.')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeTruthy()
  })

  it('the open, visible session never shows as unread; hidden it does', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    send({ type: 'session_upsert', payload: info('a') })
    send({ type: 'session_upsert', payload: info('b') })
    fireEvent.click(await screen.findByText('session-a'))
    await screen.findByPlaceholderText('Type a message or / for commands')
    send({ type: 'session_upsert', payload: { ...info('a'), unread: true } })
    send({ type: 'session_upsert', payload: { ...info('b'), unread: true } })
    expect(screen.getAllByRole('img', { name: 'Unread' })).toHaveLength(1) // b only
    setVisibility('hidden')
    expect(screen.getAllByRole('img', { name: 'Unread' })).toHaveLength(2)
    setVisibility('visible')
    expect(screen.getAllByRole('img', { name: 'Unread' })).toHaveLength(1)
  })

  it('follows the replaced session without remounting or losing the draft', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(await screen.findByText('session-a'))
    const box = (await screen.findByPlaceholderText('Type a message or / for commands')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'draft' } })
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('b', 'a') }) }))
    await waitFor(() => expect(screen.getAllByText('session-b').length).toBeGreaterThan(0))
    expect(screen.queryByText('Session not found.')).toBeNull()
    expect((screen.getByPlaceholderText('Type a message or / for commands') as HTMLTextAreaElement).value).toBe('draft')
    expect(screen.getByPlaceholderText('Type a message or / for commands')).toBe(box)
  })

  it('no modes: there is no "Away" control and the app sends no watch (not even when hidden)', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    fireEvent.click(await screen.findByText('session-a'))
    await screen.findByPlaceholderText('Type a message or / for commands')
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
    fireEvent.click(await screen.findByText('session-a'))
    const box = (await screen.findByPlaceholderText('Type a message or / for commands')) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'draft' } })
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('b', 'a') }) }))
    await waitFor(() => expect(screen.getAllByText('session-b').length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByText('session-b')[0])
    expect(screen.getByPlaceholderText('Type a message or / for commands')).toBe(box)
    expect(box.value).toBe('draft')
  })

  it('desktop starts on the projects board in the centre: card per workspace and project page with its tickets', async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    expect(screen.queryByRole('tab')).toBeNull() // no tabs on desktop
    send({ type: 'workspace_upsert', payload: { id: 'w1', name: 'ACME', color: '#f00', whoasProfile: '' } })
    send({ type: 'project_upsert', payload: { id: 'p1', workspaceId: 'w1', name: 'Quorum', repoUrl: '', connector: { kind: 'exec', settings: {}, hasToken: false, intervalMin: 5 }, summary: 'Going', summaryAt: 0, progress: { done: 1, total: 2 }, syncError: '', syncedAt: 0 } })
    send({ type: 'tickets', payload: { projectId: 'p1', tickets: [{ id: 't1', projectId: 'p1', externalId: '1', title: 'Fix login', status: 'todo', rawStatus: 'open', assignee: '', url: '', body: '', comments: [], updatedAt: 1 }] } })
    const centre = () => screen.getByRole('main')
    expect(within(centre()).getByText('ACME')).toBeTruthy()
    fireEvent.click(within(centre()).getByText('Quorum', { selector: 'span' }))
    // the project screen is sessions-only: tickets live behind the menu
    expect(await within(centre()).findByRole('heading', { name: 'Sessions' })).toBeTruthy()
    expect(screen.queryByText('Fix login')).toBeNull()
    openMenu('Project menu')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Tickets (1)' }))
    expect(await screen.findByText('Fix login')).toBeTruthy()
  })

  const setupProject = async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    send({ type: 'workspace_upsert', payload: { id: 'w1', name: 'ACME', color: '#f00', whoasProfile: '' } })
    send({ type: 'project_upsert', payload: { id: 'p1', workspaceId: 'w1', name: 'Quorum', repoUrl: '', connector: { kind: 'exec', settings: {}, hasToken: false, intervalMin: 5 }, summary: '', summaryAt: 0, progress: { done: 0, total: 1 }, syncError: '', syncedAt: 0 } })
    send({ type: 'tickets', payload: { projectId: 'p1', tickets: [{ id: 't1', projectId: 'p1', externalId: '1', title: 'Fix login', status: 'todo', rawStatus: 'open', assignee: '', url: '', body: '', comments: [], updatedAt: 1 }] } })
    // the phone lands on the session inbox: the projects board is its Projects tab
    if (!isWide) fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
    fireEvent.click(await within(screen.queryByRole('main') ?? document.body).findByText('Quorum', { selector: 'span' }))
    await screen.findByRole('heading', { name: 'Sessions' })
  }

  it('narrow: Tickets pushes a history entry and history.back() returns to the project', async () => {
    isWide = false
    await setupProject()
    const depth = history.state?.depth ?? 0
    openMenu('Project menu')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Tickets (1)' }))
    expect(await screen.findByText('Fix login')).toBeTruthy()
    expect(history.state.depth).toBe(depth + 1)
    expect(screen.queryByRole('heading', { name: 'Sessions' })).toBeNull()
    // the bottom nav stays on project pages
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    act(() => { history.back() })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sessions' })).toBeTruthy())
    expect(screen.queryByText('Fix login')).toBeNull()
  })

  it('narrow: Checkouts opens a sheet and Back closes it', async () => {
    isWide = false
    await setupProject()
    openMenu('Project menu')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Checkouts' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(history.state.checkouts).toBe(true)
    act(() => { history.back() })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeTruthy()
  })

  it('desktop: "Back" in Settings returns to the previous centre', async () => {
    render(<App />)
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText('Workspaces')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.queryByText('Workspaces')).toBeNull())
    expect(screen.getByText('No workspaces or projects yet.')).toBeTruthy()
  })

  it('desktop: "Back" in a deep-linked page with no app history goes up a level without leaving the app', async () => {
    history.replaceState({ config: '' }, '')
    const spy = vi.spyOn(history, 'back')
    render(<App />)
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
    await screen.findByPlaceholderText('Type a message or / for commands')
  })

  it('the web build never loads the push layer', async () => {
    render(<App />)
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(startPush).not.toHaveBeenCalled()
  })

  it('in the Android app, a notification tap opens its session', async () => {
    ;(window as any).Capacitor = { isNativePlatform: () => true }
    isWide = false
    render(<App />)
    await waitFor(() => expect(startPush).toHaveBeenCalledTimes(1))
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    act(() => ws().onmessage({ data: JSON.stringify({ type: 'session_upsert', payload: info('a') }) }))
    act(() => { startPush.mock.calls[0][0]('a') })
    await screen.findByPlaceholderText('Type a message or / for commands')
  })
})

describe('App: desktop shell', () => {
  const COMPOSER = 'Type a message or / for commands'
  const boot = async () => {
    render(<App />)
    const ws = () => FakeWS.all[FakeWS.all.length - 1]
    await waitFor(() => expect(FakeWS.all.length).toBeGreaterThan(0))
    const send = (e: any) => act(() => ws().onmessage({ data: JSON.stringify(e) }))
    return { send }
  }
  const side = () => screen.getByRole('navigation', { name: 'Sessions' })
  const evt = (session: string, seq: number) => ({ seq, session, ts: seq, kind: 'user', data: { text: 'hello ' + seq } })
  const seenCalls = () => fetchMock.mock.calls.filter(([u, init]) => String(u).includes('/seen') && init?.method === 'POST').map(([u]) => decodeURIComponent(String(u).split('/api/sessions/')[1].split('/')[0]))

  it('has the sidebar and no tabs; the projects board is the landing centre', async () => {
    await boot()
    expect(side()).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(within(screen.getByRole('main')).getByText('No workspaces or projects yet.')).toBeTruthy()
  })

  it('clicking a session sets the centre and pushes history; Back restores the previous centre', async () => {
    const { send } = await boot()
    send({ type: 'session_upsert', payload: info('a') })
    send({ type: 'session_upsert', payload: info('b') })
    const depth = history.state?.depth ?? 0
    fireEvent.click(within(side()).getByText('session-a'))
    await screen.findByPlaceholderText(COMPOSER)
    expect(history.state).toMatchObject({ session: 'a', depth: depth + 1 })
    expect(within(side()).getByText('session-a').closest('button')!.getAttribute('aria-current')).toBe('page')
    fireEvent.click(within(side()).getByText('session-b'))
    await waitFor(() => expect(history.state).toMatchObject({ session: 'b', depth: depth + 2 }))
    act(() => { history.back() })
    await waitFor(() => expect(within(side()).getByText('session-a').closest('button')!.getAttribute('aria-current')).toBe('page'))
    act(() => { history.back() })
    await waitFor(() => expect(within(screen.getByRole('main')).getByText('No workspaces or projects yet.')).toBeTruthy())
    expect(screen.queryByPlaceholderText(COMPOSER)).toBeNull()
  })

  it('Settings and the project page open in the centre and Back returns to the session', async () => {
    const { send } = await boot()
    send({ type: 'workspace_upsert', payload: { id: 'w1', name: 'ACME', color: '#f00', whoasProfile: '' } })
    send({ type: 'project_upsert', payload: { id: 'p1', workspaceId: 'w1', name: 'Web', repoUrl: '', connector: { kind: 'exec', settings: {}, hasToken: false, intervalMin: 5 }, summary: '', summaryAt: 0, progress: { done: 0, total: 0 }, syncError: '', syncedAt: 0 } })
    send({ type: 'session_upsert', payload: { ...info('a'), projectId: 'p1' } })
    fireEvent.click(within(side()).getByText('session-a'))
    await screen.findByPlaceholderText(COMPOSER)
    fireEvent.click(within(side()).getByRole('button', { name: 'Web' }))
    expect(await within(screen.getByRole('main')).findByRole('heading', { name: 'Sessions' })).toBeTruthy()
    expect(screen.queryByPlaceholderText(COMPOSER)).toBeNull()
    act(() => { history.back() })
    await screen.findByPlaceholderText(COMPOSER)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText('Workspaces')).toBeTruthy()
    expect(screen.queryByPlaceholderText(COMPOSER)).toBeNull()
    act(() => { history.back() })
    await screen.findByPlaceholderText(COMPOSER)
  })

  it('keeps each draft when switching A -> B -> A', async () => {
    const { send } = await boot()
    send({ type: 'session_upsert', payload: info('a') })
    send({ type: 'session_upsert', payload: info('b') })
    fireEvent.click(within(side()).getByText('session-a'))
    fireEvent.change(await screen.findByPlaceholderText(COMPOSER), { target: { value: 'draft for a' } })
    fireEvent.click(within(side()).getByText('session-b'))
    await waitFor(() => expect((screen.getByPlaceholderText(COMPOSER) as HTMLTextAreaElement).value).toBe(''))
    fireEvent.change(screen.getByPlaceholderText(COMPOSER), { target: { value: 'draft for b' } })
    fireEvent.click(within(side()).getByText('session-a'))
    await waitFor(() => expect((screen.getByPlaceholderText(COMPOSER) as HTMLTextAreaElement).value).toBe('draft for a'))
    fireEvent.click(within(side()).getByText('session-b'))
    await waitFor(() => expect((screen.getByPlaceholderText(COMPOSER) as HTMLTextAreaElement).value).toBe('draft for b'))
  })

  it('a seen mark is sent only for the session in the centre', async () => {
    const { send } = await boot()
    send({ type: 'session_upsert', payload: info('a') })
    send({ type: 'session_upsert', payload: info('b') })
    send({ type: 'events', session: 'a', payload: [evt('a', 5)] })
    send({ type: 'events', session: 'b', payload: [evt('b', 7)] })
    fetchMock.mockClear()
    fireEvent.click(within(side()).getByText('session-a'))
    await screen.findByPlaceholderText(COMPOSER)
    await waitFor(() => expect(seenCalls()).toEqual(['a']))
    // Settings takes the centre: new events of a are not marked
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByText('Workspaces')
    fetchMock.mockClear()
    send({ type: 'event', payload: evt('a', 6) })
    send({ type: 'event', payload: evt('b', 8) })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(seenCalls()).toEqual([])
    // b in the centre: only b
    fireEvent.click(within(side()).getByText('session-b'))
    await screen.findByPlaceholderText(COMPOSER)
    await waitFor(() => expect(seenCalls()).toEqual(['b']))
  })

  it('crossing from 1300 px to 800 px with a session open keeps the same session and its draft', async () => {
    let width = 1300
    const hs = new Set<() => void>()
    vi.stubGlobal('matchMedia', (q: string) => {
      const min = /min-width:\s*(\d+)px/.exec(q)?.[1]
      const max = /max-width:\s*(\d+)px/.exec(q)?.[1]
      return { get matches() { return (min ? width >= Number(min) : true) && (max ? width <= Number(max) : true) }, addEventListener: (_: string, h: () => void) => hs.add(h), removeEventListener: (_: string, h: () => void) => hs.delete(h) }
    })
    try {
      const { send } = await boot()
      send({ type: 'session_upsert', payload: { ...info('x1'), name: 'Alpha' } })
      send({ type: 'session_upsert', payload: { ...info('x2'), name: 'Beta' } })
      fireEvent.click(within(side()).getByText('Alpha'))
      fireEvent.change(await screen.findByPlaceholderText(COMPOSER), { target: { value: 'half a thought' } })
      act(() => { width = 800; hs.forEach((h) => h()) })
      // the phone layout: no sidebar, the session full screen with a Back button
      await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Sessions' })).toBeNull())
      expect(await screen.findByRole('button', { name: 'Back' })).toBeTruthy()
      expect(screen.getByText('Alpha')).toBeTruthy()
      expect(screen.queryByText('Beta')).toBeNull()
      await waitFor(() => expect((screen.getByPlaceholderText(COMPOSER) as HTMLTextAreaElement).value).toBe('half a thought'))
    } finally {
      vi.stubGlobal('matchMedia', () => ({ matches: isWide, addEventListener() {}, removeEventListener() {} }))
    }
  })

  it('a session that is not in the centre still shows unread in the sidebar', async () => {
    const { send } = await boot()
    send({ type: 'session_upsert', payload: { ...info('a'), unread: true } })
    expect(within(side()).getAllByRole('img', { name: 'Unread' })).toHaveLength(1)
    fireEvent.click(within(side()).getByText('session-a'))
    await screen.findByPlaceholderText(COMPOSER)
    expect(within(side()).queryAllByRole('img', { name: 'Unread' })).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByText('Workspaces')
    expect(within(side()).getAllByRole('img', { name: 'Unread' })).toHaveLength(1)
  })
})
