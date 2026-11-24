// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Composer, { applyPrefixes } from './Composer'
import { onPluginStateChanged } from '../lib/pluginBus'
import type { SessionInfo } from '../proto.gen'

const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 202 }))
vi.stubGlobal('fetch', fetchMock)

const sess = (o: Partial<SessionInfo>): SessionInfo => ({
  id: 's1', recap: '', previousId: '', machine: 'm', name: 'n', cwd: '/x', root: '/x', model: '', role: 'work' as any,
  state: 'idle' as any, contextPct: 0, startedAt: 0, updatedAt: 0, transcriptPath: '', repoUrl: '', branch: '', projectId: '', launchReq: '', herdrPane: '', herdrWorkspace: '', account: '', accountKey: '', configDir: '', plugins: [], contextEstimate: false, tokens: { in: 0, out: 0, cache: 0 }, rateLimits: [], usageAt: 0, imagesDir: '', background: { tasks: 0, wakeAt: 0 }, unread: false, ...o,
})

function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'More send options' }), { key: 'Enter' })
}

async function send(s: SessionInfo, label: string) {
  render(<Composer session={s} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
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
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } })
    expect(await state()).toEqual([false, false, false])
    cleanup()
    render(<Composer session={sess({ state: 'closed' as any })} />)
    expect(await state()).toEqual([true, true, true])
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true)
  })
  it('Queue and Interrupt live in the menu, not as top-level buttons', async () => {
    render(<Composer session={sess({ state: 'idle' as any })} />)
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Interrupt and send' })).toBeNull()
  })
  it('Enter adds a new line; Ctrl+Enter sends', async () => {
    render(<Composer session={sess({ state: 'working' as any })} />)
    const box = screen.getByRole('textbox')
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
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello')
  })
  it.each(['Send', 'Queue', 'Interrupt and send'])('%s clears the draft on success', async (label) => {
    const s = sess({ state: 'working' as any })
    const a = render(<Composer session={s} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    if (label === 'Send') fireEvent.click(screen.getByRole('button', { name: label }))
    else { openMenu(); fireEvent.click(await screen.findByRole('menuitem', { name: label })) }
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })
  it('keeps the draft when sending fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"boom"}', { status: 500 }))
    const s = sess({ state: 'working' as any })
    const a = render(<Composer session={s} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('alert')
    a.unmount()
    render(<Composer session={s} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello')
  })
  it('a replaced session with no draft of its own inherits the previous id draft', () => {
    localStorage.setItem('quorum.draft.old', 'carry me')
    render(<Composer session={sess({ id: 'new', previousId: 'old' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('carry me')
    expect(localStorage.getItem('quorum.draft.new')).toBe('carry me')
    expect(localStorage.getItem('quorum.draft.old')).toBeNull()
  })
  it('its own draft is not overwritten by the previous one', () => {
    localStorage.setItem('quorum.draft.old', 'old text')
    localStorage.setItem('quorum.draft.new', 'mine')
    render(<Composer session={sess({ id: 'new', previousId: 'old' })} />)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('mine')
  })
  describe('plugin chips', () => {
    const chip = (n: string) => screen.getByRole('button', { name: n })
    const both = ['use-haiku', 'think-hard']
    const sendWith = async (s: SessionInfo, chips: string[], via = 'Send') => {
      render(<Composer session={s} />)
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
      chips.forEach((c) => fireEvent.click(chip(c)))
      if (via === 'Send') fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      else { openMenu(); fireEvent.click(await screen.findByRole('menuitem', { name: via })) }
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      return JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    }
    it('render only for enabled plugins', () => {
      render(<Composer session={sess({})} />)
      expect(screen.queryByRole('button', { name: 'Haiku' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Think hard' })).toBeNull()
      cleanup()
      render(<Composer session={sess({ plugins: ['think-hard'] })} />)
      expect(screen.queryByRole('button', { name: 'Haiku' })).toBeNull()
      expect(chip('Think hard').getAttribute('aria-pressed')).toBe('false')
    })
    it('toggle aria-pressed and are mutually exclusive', () => {
      render(<Composer session={sess({ plugins: both })} />)
      fireEvent.click(chip('Haiku'))
      expect(chip('Haiku').getAttribute('aria-pressed')).toBe('true')
      fireEvent.click(chip('Think hard'))
      expect(chip('Think hard').getAttribute('aria-pressed')).toBe('true')
      expect(chip('Haiku').getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(chip('Think hard'))
      expect(chip('Think hard').getAttribute('aria-pressed')).toBe('false')
    })
    it('Haiku sends _text and Think hard sends +text', async () => {
      expect((await sendWith(sess({ plugins: both }), ['Haiku'])).text).toBe('_hello')
      cleanup(); fetchMock.mockClear(); localStorage.clear()
      expect((await sendWith(sess({ plugins: both }), ['Think hard'])).text).toBe('+hello')
    })
    it.each(['Queue', 'Interrupt and send'])('prefix applies through %s', async (via) => {
      expect((await sendWith(sess({ plugins: both, state: 'idle' as any }), ['Haiku'], via)).text).toBe('_hello')
    })
    it('chips reset after a successful send, not after a failure', async () => {
      render(<Composer session={sess({ plugins: both })} />)
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
      fireEvent.click(chip('Think hard'))
      fetchMock.mockImplementationOnce(async () => new Response('{"error":"boom"}', { status: 500 }))
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await screen.findByRole('alert')
      expect(chip('Think hard').getAttribute('aria-pressed')).toBe('true')
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await waitFor(() => expect(chip('Think hard').getAttribute('aria-pressed')).toBe('false'))
    })
    it('Haiku is disabled while working', () => {
      render(<Composer session={sess({ plugins: both, state: 'working' as any })} />)
      const h = chip('Haiku') as HTMLButtonElement
      expect(h.disabled).toBe(true)
      expect(h.title).toBe('Haiku applies when Claude is idle')
      expect((chip('Think hard') as HTMLButtonElement).disabled).toBe(false)
    })
    it('Haiku un-presses when the session starts working', () => {
      const r = render(<Composer session={sess({ plugins: both, state: 'idle' as any })} />)
      fireEvent.click(chip('Haiku'))
      expect(chip('Haiku').getAttribute('aria-pressed')).toBe('true')
      r.rerender(<Composer session={sess({ plugins: both, state: 'working' as any })} />)
      expect(chip('Haiku').getAttribute('aria-pressed')).toBe('false')
      r.rerender(<Composer session={sess({ plugins: both, state: 'idle' as any })} />)
      expect(chip('Haiku').getAttribute('aria-pressed')).toBe('false')
    })
    it('applyPrefixes does not double-prefix', () => {
      expect(applyPrefixes('hi', { haiku: true, think: false })).toBe('_hi')
      expect(applyPrefixes('hi', { haiku: false, think: true })).toBe('+hi')
      expect(applyPrefixes('hi', { haiku: false, think: false })).toBe('hi')
      expect(applyPrefixes('_hi', { haiku: true, think: false })).toBe('_hi')
      expect(applyPrefixes('+hi', { haiku: false, think: true })).toBe('+hi')
    })
  })
  it('Queue uses /after literally when the after plugin is present', async () => {
    const r = await send(sess({ state: 'working' as any, plugins: ['after'] }), 'Queue')
    expect(r.url).toContain('/api/sessions/s1/plugin')
    expect(r.body).toEqual({ command: 'after', args: '-- hello' })
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })
  it('a Queue sent with /after tells the queue section to re-read', async () => {
    const seen: string[] = []
    const off = onPluginStateChanged((id, p) => seen.push(`${id}:${p}`))
    try {
      await send(sess({ state: 'working' as any, plugins: ['after'] }), 'Queue')
      await waitFor(() => expect(seen).toEqual(['s1:after']))
    } finally { off() }
  })
  it('idle with after: Send still sends the prompt (with the chip prefix); only the Queue item uses /after', async () => {
    const plugins = ['after', 'use-haiku', 'think-hard']
    render(<Composer session={sess({ state: 'idle' as any, plugins })} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Haiku' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toContain('/api/sessions/s1/prompt')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ text: '_hello', mode: 'queue' })
    cleanup(); fetchMock.mockClear(); localStorage.clear()
    const r = await send(sess({ state: 'idle' as any, plugins }), 'Queue')
    expect(r.url).toContain('/api/sessions/s1/plugin')
    expect(r.body).toEqual({ command: 'after', args: '-- hello' })
  })
  it('Queue with after refuses multi-line text and a leading slash', async () => {
    for (const v of ['a\nb', '/clear']) {
      cleanup(); fetchMock.mockClear()
      render(<Composer session={sess({ plugins: ['after'] })} />)
      fireEvent.change(screen.getByRole('textbox'), { target: { value: v } })
      openMenu(); fireEvent.click(await screen.findByRole('menuitem', { name: 'Queue' }))
      expect((await screen.findByRole('alert')).textContent).toBe('Use one line that does not start with /')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })
})
