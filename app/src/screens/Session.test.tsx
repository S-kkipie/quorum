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

const openMenu = () => fireEvent.keyDown(screen.getByLabelText('More actions'), { key: 'Enter' })

describe('Session: not found', () => {
  it('offers Back so the dead end can be left', () => {
    const onBack = vi.fn()
    render(<Session state={st()} id="gone" onEvents={vi.fn()} onBack={onBack} />)
    expect(screen.getByText('Session not found.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalled()
  })
})

describe('Session: menu ⋯', () => {
  it('"New session here" stays disabled while a launch is in progress', () => {
    const onGuard = vi.fn()
    render(<Session state={st()} id="a" onEvents={vi.fn()} busy onGuard={onGuard} />)
    openMenu()
    const it = screen.getByRole('menuitem', { name: 'New session here' })
    expect(it.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(it)
    expect(onGuard).not.toHaveBeenCalled()
  })
  it('closes with Escape; "View in terminal" opens the pane', () => {
    const onViewTerminal = vi.fn()
    render(<Session state={st()} id="a" onEvents={vi.fn()} onViewTerminal={onViewTerminal} />)
    openMenu()
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View in terminal' }))
    expect(onViewTerminal).toHaveBeenCalledWith('vps-2', 'p1')
  })
  it('a closed session does not offer "View in terminal"', () => {
    const s = st()
    s.sessions.a = sess('a', { herdrPane: 'p1', state: 'closed' })
    render(<Session state={s} id="a" onEvents={vi.fn()} onViewTerminal={vi.fn()} />)
    openMenu()
    expect(screen.queryByRole('menuitem', { name: 'View in terminal' })).toBeNull()
  })
})

describe('Session header', () => {
  it('Interrupt only when working', () => {
    const s = st()
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull()
    cleanup()
    s.sessions.a = sess('a', { state: 'working' })
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()
  })
  it('working shows the working indicator in the transcript', () => {
    const s = st()
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.queryByText('Working…')).toBeNull()
    cleanup()
    s.sessions.a = sess('a', { state: 'working' })
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Working…')
  })
  it('artifact card Open passes the machine and the path', () => {
    const s = st()
    const ev = (seq: number, kind: string, data: any) => ({ seq, session: 'a', ts: 0, kind, data })
    s.events = { a: [ev(1, 'tool_start', { id: 'w', name: 'Write', summary: '', input: { file_path: '/r/out.html' } }), ev(2, 'tool_end', { id: 'w', ok: true, ms: 1, output: '' })] }
    const onOpenFile = vi.fn()
    render(<Session state={s} id="a" onEvents={vi.fn()} onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenFile).toHaveBeenCalledWith('vps-2', '/r/out.html')
  })
  it('menu has Close session, which asks for confirmation', () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    render(<Session state={st()} id="a" onEvents={vi.fn()} />)
    openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close session' }))
    expect(confirm).toHaveBeenCalled()
    expect((fetch as any).mock.calls.some(([u]: [string]) => String(u).includes('/close'))).toBe(false)
  })
  it('subtitle has no cwd path', () => {
    const s = st()
    s.sessions.a = sess('a', { cwd: '/srv/secret-dir', root: '/srv/secret-dir', model: 'opus', branch: 'main' })
    const { container } = render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByText('vps-2 · opus · main')).toBeTruthy()
    expect(container.querySelector('header')!.textContent).not.toContain('/srv/secret-dir')
  })
})

describe('Session: narrow header', () => {
  it('Interrupt is icon-only and the state pill moves to the second line', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    const s = { ...st(), sessions: { a: sess('a', { state: 'working' as any, model: 'opus' }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Interrupt' })
    expect(btn.textContent).toBe('')
    const pill = screen.getByText('Working')
    expect(pill.closest('header')!.querySelectorAll('div')[0].contains(pill)).toBe(false)
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    vi.stubGlobal('localStorage', { getItem: () => 'tok', setItem() {}, removeItem() {} })
  })
})

describe('Session: meters', () => {
  it('shows account chip, estimated context with tone and session tokens', () => {
    const s = { ...st(), sessions: { a: sess('a', { account: 'work', contextPct: 58, contextEstimate: true, tokens: { in: 12_000, out: 3_000, cache: 0 } }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByText('work')).toBeTruthy()
    const ctx = screen.getByText('ctx ~58%')
    expect(ctx.getAttribute('data-tone')).toBe('warn')
    expect(screen.getByText('↑12k ↓3k')).toBeTruthy()
  })
  it('the meters row wraps instead of overflowing a 320 px header', () => {
    const s = { ...st(), sessions: { a: sess('a', { account: 'personal-test', contextPct: 58, tokens: { in: 1_200_000, out: 300_000, cache: 0 } }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    const row = screen.getByText('ctx 58%').parentElement!
    expect(row.className).toMatch(/\bflex-wrap\b/)
    expect(row.className).toMatch(/\bgap-y-/)
  })
  it('measured context has no tilde; nothing shown without data', () => {
    const s = { ...st(), sessions: { a: sess('a', { contextPct: 80 }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByText('ctx 80%').getAttribute('data-tone')).toBe('danger')
    expect(screen.queryByText(/↑/)).toBeNull()
  })
})

describe('Session: account usage', () => {
  const NOW = Date.now()
  const iso = (ms: number) => new Date(NOW + ms).toISOString()
  const usage = (key: string, five: number, week: number, o: any = {}) => ({ key, alias: 'work', fiveHour: { pct: five, resetsAt: iso(3_600_000) }, sevenDay: { pct: week, resetsAt: iso(86_400_000) }, at: NOW, ...o })
  const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  it('shows the account usage after the chip, by accountKey, with tones', () => {
    const s = { ...st(), usage: { k1: usage('k1', 58, 96), 'vps-2/work': usage('vps-2/work', 1, 1) }, sessions: { a: sess('a', { account: 'work', accountKey: 'k1', machine: 'vps-2' }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    const el = screen.getByTestId('session-usage')
    expect(text(el)).toBe('5h 58% · week 96%')
    expect(el.previousElementSibling?.textContent).toBe('work')
    expect(screen.getByText('5h 58%').getAttribute('data-tone')).toBe('ok')
    expect(screen.getByText('week 96%').getAttribute('data-tone')).toBe('danger')
    expect(el.hasAttribute('data-stale')).toBe(false)
    expect(el.parentElement!.className).toMatch(/\bflex-wrap\b/)
  })
  it('falls back to machine/account; omits an unreported window; dims a stale report', () => {
    const s = { ...st(), usage: { 'vps-2/work': usage('vps-2/work', 82, 24, { sevenDay: { pct: 0, resetsAt: '' }, at: NOW - 2 * 3_600_000 }) }, sessions: { a: sess('a', { account: 'work', accountKey: '', machine: 'vps-2' }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    const el = screen.getByTestId('session-usage')
    expect(text(el)).toBe('5h 82%')
    expect(screen.getByText('5h 82%').getAttribute('data-tone')).toBe('warn')
    expect(el.hasAttribute('data-stale')).toBe(true)
    expect(el.className).toMatch(/opacity-50/)
  })
  it('nothing without usage for the account', () => {
    const s = { ...st(), usage: { other: usage('other', 50, 50) }, sessions: { a: sess('a', { account: 'work', accountKey: 'k1', machine: 'vps-2' }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.queryByTestId('session-usage')).toBeNull()
    expect(screen.queryByText(/5h/)).toBeNull()
  })
})

describe('Session: plugin bar', () => {
  it('Timeline and Queue share one row; the queue panel opens below it', async () => {
    const f = vi.fn(async (u: string) => {
      if (String(u).includes('/plugins/after')) return new Response(JSON.stringify({ items: [{ id: 1, text: 'task one' }, { id: 2, text: 'task two' }] }))
      if (String(u).includes('/plugins/time-machine')) return new Response(JSON.stringify({ cursor: 1, states: [{ id: 1, label: 'start', at: 1, files: [] }] }))
      return new Response('[]')
    })
    vi.stubGlobal('fetch', f)
    try {
      const s = { ...st(), sessions: { a: sess('a', { plugins: ['after', 'time-machine'] }) } }
      render(<Session state={s} id="a" onEvents={vi.fn()} />)
      const tl = await screen.findByRole('button', { name: 'Timeline (1)' })
      const q = await screen.findByRole('button', { name: 'Queue (2)' })
      expect(tl.textContent).toBe('Timeline1')
      expect(q.textContent).toBe('Queue2')
      const row = screen.getByTestId('plugin-bar')
      expect(row.contains(tl) && row.contains(q)).toBe(true)
      expect(tl.className).toMatch(/\bmin-h-11\b/)
      expect(q.className).toMatch(/\bmin-h-11\b/)
      fireEvent.click(q)
      expect(await screen.findByText('task one')).toBeTruthy()
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    }
  })
})
