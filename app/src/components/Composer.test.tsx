// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Composer from './Composer'
import type { SessionCommand, SessionCommands, SessionInfo } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 202 }))
vi.stubGlobal('fetch', fetchMock)

const sess = (o: Partial<SessionInfo>): SessionInfo => ({
  id: 's1', recap: '', previousId: '', machine: 'm', name: 'n', cwd: '/x', root: '/x', model: '', role: 'work' as any,
  state: 'idle' as any, contextPct: 0, startedAt: 0, updatedAt: 0, transcriptPath: '', repoUrl: '', branch: '', projectId: '', launchReq: '', herdrPane: '', herdrWorkspace: '', account: '', accountKey: '', configDir: '', plugins: [], contextEstimate: false, tokens: { in: 0, out: 0, cache: 0 }, rateLimits: [], usageAt: 0, imagesDir: '', background: { tasks: 0, wakeAt: 0 }, unread: false, effort: '', modelOptions: [], effortOptions: [], ...o,
})

function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'More send options' }), { key: 'Enter' })
}

async function send(s: SessionInfo, label: string) {
  render(<Composer session={s} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } })
  if (label === 'Send') fireEvent.click(screen.getByRole('button', { name: label }))
  else { openMenu(); fireEvent.click(await screen.findByRole('menuitem', { name: label })) }
  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  const [url, init] = fetchMock.mock.calls[0]
  return { url, body: JSON.parse(String(init?.body)) }
}

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); fetchMock.mockClear() })

describe('Composer', () => {
  it('working: Send uses mode now', async () => {
    const r = await send(sess({ state: 'working' as any }), 'Send')
    expect(r.url).toContain('/api/sessions/s1/prompt')
    expect(r.body).toEqual({ text: 'hello', mode: 'now' })
  })
  it('idle: Send uses mode queue', async () => {
    expect((await send(sess({ state: 'idle' as any }), 'Send')).body.mode).toBe('queue')
  })
  it('only a running turn (working, needs_you) sends now; background sends like idle', async () => {
    expect((await send(sess({ state: 'needs_you' as any }), 'Send')).body.mode).toBe('now')
    cleanup(); fetchMock.mockClear()
    expect((await send(sess({ state: 'background' as any, background: { tasks: 1, wakeAt: 0 } }), 'Send')).body.mode).toBe('queue')
  })
  it('Queue and Interrupt', async () => {
    expect((await send(sess({ state: 'working' as any }), 'Queue')).body.mode).toBe('queue')
    cleanup(); fetchMock.mockClear()
    expect((await send(sess({ state: 'working' as any }), 'Interrupt and send')).body.mode).toBe('interrupt')
  })
  it('renders through PromptInput', () => {
    const { container } = render(<Composer session={sess({})} />)
    expect(container.querySelector('form [data-slot=input-group] textarea')).toBeTruthy()
  })
  it('Send and the menu items are off without text and while blocked', async () => {
    const isOff = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled')
    const state = async () => {
      openMenu()
      const items = await screen.findAllByRole('menuitem')
      expect(items.map((i) => i.textContent)).toEqual(['Queue', 'Interrupt and send'])
      const r = [isOff(screen.getByRole('button', { name: 'Send' })), ...items.map(isOff)]
      fireEvent.keyDown(items[0], { key: 'Escape' })
      return r
    }
    render(<Composer session={sess({ state: 'working' as any })} />)
    expect(await state()).toEqual([true, true, true])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hi' } })
    expect(await state()).toEqual([false, false, false])
    cleanup()
    render(<Composer session={sess({ state: 'closed' as any })} />)
    expect(await state()).toEqual([true, true, true])
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).disabled).toBe(true)
  })
  it('Queue and Interrupt live in the menu, not as top-level buttons', async () => {
    render(<Composer session={sess({ state: 'idle' as any })} />)
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Interrupt and send' })).toBeNull()
  })
  it('on a computer Enter sends and Shift+Enter is a new line', async () => {
    const prev = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('pointer: fine'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia
    try {
      render(<Composer session={sess({ state: 'working' as any })} />)
      const box = screen.getByRole('combobox')
      fireEvent.change(box, { target: { value: 'hello' } })
      fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
      await new Promise((r) => setTimeout(r, 10))
      expect(fetchMock).not.toHaveBeenCalled()
      fireEvent.keyDown(box, { key: 'Enter' })
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    } finally { window.matchMedia = prev }
  })
  it('on a touch screen Enter adds a new line; Ctrl+Enter sends', async () => {
    render(<Composer session={sess({ state: 'working' as any })} />)
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ text: 'hello', mode: 'now' })
  })
  it('service: disabled', () => {
    render(<Composer session={sess({ role: 'service' as any })} />)
    expect(screen.getByText('Service session')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('closed', () => {
    render(<Composer session={sess({ state: 'closed' as any })} />)
    expect(screen.getByText('Session closed')).toBeTruthy()
  })
  it('keeps the draft across remount', () => {
    const s = sess({})
    const a = render(<Composer session={s} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } })
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('hello')
  })
  it.each(['Send', 'Queue', 'Interrupt and send'])('%s clears the draft on success', async (label) => {
    const s = sess({ state: 'working' as any })
    const a = render(<Composer session={s} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } })
    if (label === 'Send') fireEvent.click(screen.getByRole('button', { name: label }))
    else { openMenu(); fireEvent.click(await screen.findByRole('menuitem', { name: label })) }
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe(''))
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('')
  })
  it('keeps the draft when sending fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"boom"}', { status: 500 }))
    const s = sess({ state: 'working' as any })
    const a = render(<Composer session={s} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('alert')
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('hello')
  })
  it('a replaced session with no draft of its own inherits the previous id draft', () => {
    localStorage.setItem('quorum.draft.old', 'carry me')
    render(<Composer session={sess({ id: 'new', previousId: 'old' })} />)
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('carry me')
    expect(localStorage.getItem('quorum.draft.new')).toBe('carry me')
    expect(localStorage.getItem('quorum.draft.old')).toBeNull()
  })
  it('its own draft is not overwritten by the previous one', () => {
    localStorage.setItem('quorum.draft.old', 'old text')
    localStorage.setItem('quorum.draft.new', 'mine')
    render(<Composer session={sess({ id: 'new', previousId: 'old' })} />)
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).value).toBe('mine')
  })
  it('the placeholder invites slash commands', () => {
    render(<Composer session={sess({})} />)
    expect((screen.getByRole('combobox') as HTMLTextAreaElement).placeholder).toBe('Type a message or / for commands')
  })
  it('the old Haiku / Think hard chips are gone', () => {
    render(<Composer session={sess({ plugins: ['use-haiku', 'think-hard', 'after'] })} />)
    expect(screen.queryByRole('button', { name: 'Haiku' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Think hard' })).toBeNull()
  })
  it('Queue sends a queued prompt even with the after plugin', async () => {
    const r = await send(sess({ state: 'working' as any, plugins: ['after'] }), 'Queue')
    expect(r.url).toContain('/api/sessions/s1/prompt')
    expect(r.body).toEqual({ text: 'hello', mode: 'queue' })
  })
})

const cmd = (name: string, group = 'session', o: Partial<SessionCommand> = {}): SessionCommand => ({
  name, description: `Does ${name}`, source: group === 'session' ? 'builtin' : 'plugin', plugin: '', group, terminalOnly: false, ...o,
})
const LIST: SessionCommands = { session: 's1', hash: 'h1', commands: [
  cmd('model', 'session', { terminalOnly: true, description: 'Switch the model' }), cmd('compact', 'session', { description: 'Summarize and free context' }),
  cmd('config', 'session', { terminalOnly: true, description: 'Settings' }), cmd('brainstorming', 'skill', { plugin: 'superpowers' }),
  cmd('after', 'plugin', { plugin: 'after', description: 'Queue a task' }), cmd('mcp__db__query', 'mcp'),
] }

describe('Composer: slash commands', () => {
  const box = () => screen.getByRole('combobox') as HTMLTextAreaElement
  const type = (v: string, caret = v.length) => {
    fireEvent.change(box(), { target: { value: v } })
    box().setSelectionRange(caret, caret)
    fireEvent.select(box())
  }
  const list = () => screen.queryByRole('listbox', { name: 'Commands' })
  const names = () => screen.getAllByRole('option').map((o) => o.getAttribute('data-name'))

  it('"/" at the start opens the grouped list', () => {
    render(<Composer session={sess({})} commands={LIST} />)
    expect(list()).toBeNull()
    type('/')
    expect(list()).toBeTruthy()
    expect(within(list()!).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Session', 'Skills', 'Plugins', 'MCP'])
    expect(names()).toEqual(['model', 'compact', 'config', 'brainstorming', 'after', 'mcp__db__query'])
  })
  it('filters as you type', () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type('/co')
    expect(names()).toEqual(['compact', 'config'])
    type('/zzz')
    expect(screen.getByText('No matching commands')).toBeTruthy()
  })
  it('a "/" mid-sentence or past the first token does not open it', () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type('fix /co')
    expect(list()).toBeNull()
    type('/compact now')
    expect(list()).toBeNull()
  })
  it('terminal-only rows are dimmed with a terminal tag and cannot be picked', () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type('/conf')
    const row = screen.getByRole('option', { name: /config/ })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    expect(row.textContent).toContain('terminal')
    fireEvent.click(row)
    expect(box().value).toBe('/conf')
    expect(screen.getByText('Only in the terminal')).toBeTruthy()
  })
  it('keyboard: arrows skip terminal-only rows, Enter completes with a space, Esc closes', () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type('/')
    const sel = () => screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')?.getAttribute('data-name')
    expect(sel()).toBe('compact')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(sel()).toBe('brainstorming')
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(sel()).toBe('compact')
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(sel()).toBe('mcp__db__query')
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(box().value).toBe('/mcp__db__query ')
    expect(list()).toBeNull()
    type('/a')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('/after ')
    expect(fetchMock).not.toHaveBeenCalled()
    type('/')
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(list()).toBeNull()
    type('/c')
    expect(list()).toBeTruthy()
  })
  it('the textarea is a combobox whose active descendant is a unique option id', () => {
    const clash: SessionCommands = { session: 's1', hash: 'h2', commands: [cmd('a:b', 'skill'), cmd('a_b', 'skill'), cmd('a.b', 'skill')] }
    render(<Composer session={sess({})} commands={clash} />)
    type('/a')
    expect(box().getAttribute('role')).toBe('combobox')
    expect(box().getAttribute('aria-expanded')).toBe('true')
    const ids = screen.getAllByRole('option').map((o) => o.id)
    expect(new Set(ids).size).toBe(3)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    const active = box().getAttribute('aria-activedescendant')!
    expect(document.getElementById(active)?.getAttribute('data-name')).toBe('a_b')
  })
  it('tap completes the name', () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type('/br')
    fireEvent.click(screen.getByRole('option', { name: /brainstorming/ }))
    expect(box().value).toBe('/brainstorming ')
  })
  it('sending a listed command runs it and clears the draft', async () => {
    render(<Composer session={sess({ state: 'working' as any })} commands={LIST} />)
    type('/after run the tests')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/sessions/s1/command')
    expect(JSON.parse(String(init?.body))).toEqual({ command: 'after', args: 'run the tests' })
    await waitFor(() => expect(box().value).toBe(''))
  })
  it('a failed command keeps the draft and shows the error', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"session is offline"}', { status: 409 }))
    render(<Composer session={sess({})} commands={LIST} />)
    type('/compact')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('session is offline')
    expect(box().value).toBe('/compact')
  })
  it('an unknown command is not sent and says how to send it as text', async () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type('/nope x')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Unknown command /nope. Start with a space to send it as text.')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(box().value).toBe('/nope x')
  })
  it('a terminal-only command is not sent', async () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type('/config')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('/config: Only in the terminal')
    type('/after')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect((await screen.findByRole('alert')).textContent).toBe('/after: Only in the terminal without arguments')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('a leading space sends the text as a prompt', async () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type(' /nope literal')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toContain('/prompt')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).text).toBe(' /nope literal')
  })
  it('older mod (no list): the menu says to update the plugin, plain prompts still send', async () => {
    render(<Composer session={sess({})} />)
    type('/')
    expect(screen.getByText('Update the Quorum plugin on this machine to see commands')).toBeTruthy()
    type('hello')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toContain('/prompt')
    cleanup(); fetchMock.mockClear()
    render(<Composer session={sess({})} commands={{ session: 's1', commands: [], hash: '' }} />)
    type('/')
    expect(screen.getByText('Update the Quorum plugin on this machine to see commands')).toBeTruthy()
  })
  it('the list is capped at half the viewport and scrolls', () => {
    render(<Composer session={sess({})} commands={LIST} />)
    type('/')
    expect(list()!.className).toMatch(/max-h-\[50dvh\]/)
    expect(list()!.className).toMatch(/overflow-y-auto/)
  })
})
