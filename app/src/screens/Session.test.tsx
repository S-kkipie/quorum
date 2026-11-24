// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Session from './Session'
import { initialState } from '../lib/store'
import { sess } from '../lib/fixtures.test-util'
import * as api from '../lib/api'

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), seen: vi.fn(async () => {}) }))
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

describe('Session: no plugin bar', () => {
  it('the Timeline / Queue row is gone', () => {
    const s = { ...st(), sessions: { a: sess('a', { plugins: ['after', 'time-machine'] }) } }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.queryByTestId('plugin-bar')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Timeline/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Queue/ })).toBeNull()
  })
})

const OPTS = [
  { value: 'default', label: 'Default', description: 'The recommended model' },
  { value: 'opus', label: 'Opus', description: 'Most capable, for complex work' },
  { value: 'sonnet', label: 'Sonnet', description: 'Fast and capable' },
]
const withModel = (o: Partial<ReturnType<typeof sess>> = {}) => {
  const s = st()
  s.sessions.a = sess('a', { account: 'work', model: 'claude-opus-5-5', effort: 'high', modelOptions: OPTS, effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'], ...o })
  return s
}
const cmdEv = (seq: number, d: any) => ({ seq, session: 'a', ts: Date.now(), kind: 'command', data: { origin: 'device', args: '', ...d } })

describe('Session: model and effort', () => {
  it('chips after the account chip follow the session model and effort', () => {
    render(<Session state={withModel()} id="a" onEvents={vi.fn()} />)
    const m = screen.getByRole('button', { name: 'Model: Opus 5.5' })
    const e = screen.getByRole('button', { name: 'Effort: high' })
    expect(m.textContent).toContain('Opus 5.5')
    expect(e.textContent).toContain('effort: high')
    const acct = screen.getByText('work')
    expect(acct.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('hidden when the session has no options (older mod)', () => {
    render(<Session state={withModel({ modelOptions: [], effortOptions: [] })} id="a" onEvents={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Model:/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Effort:/ })).toBeNull()
  })
  it('the sheet lists the models with the current one checked; picking one sets it', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response('', { status: 202 }))
    vi.stubGlobal('fetch', f)
    try {
      render(<Session state={withModel()} id="a" onEvents={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Model: Opus 5.5' }))
      const radios = await screen.findAllByRole('radio')
      expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
      expect(screen.getByText('Most capable, for complex work')).toBeTruthy()
      fireEvent.click(screen.getByRole('radio', { name: /Sonnet/ }))
      await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).endsWith('/api/sessions/a/model'))).toBe(true))
      const call = f.mock.calls.find(([u]) => String(u).endsWith('/model'))!
      expect(JSON.parse(String(call[1]?.body))).toEqual({ value: 'sonnet' })
      await waitFor(() => expect(screen.queryByRole('radio')).toBeNull())
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    }
  })
  it('effort is read-only from the phone: the sheet says to use the terminal', async () => {
    render(<Session state={withModel()} id="a" onEvents={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Effort: high' }))
    expect(await screen.findByText('Change effort in the terminal (/effort).')).toBeTruthy()
    const levels = screen.getAllByRole('button', { name: /^(low|medium|high|xhigh|max)$/ })
    expect(levels).toHaveLength(5)
    for (const l of levels) expect((l as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'high' }).getAttribute('aria-pressed')).toBe('true')
  })
  it('a queued model command shows a spinner on the chip; the chip text waits for the mod', () => {
    const s = withModel()
    s.events = { a: [cmdEv(1, { id: 'm1', name: 'model', args: 'sonnet', status: 'queued' })] }
    const r = render(<Session state={s} id="a" onEvents={vi.fn()} />)
    const chip = screen.getByRole('button', { name: 'Model: Opus 5.5' })
    expect(chip.getAttribute('aria-busy')).toBe('true')
    const done = { ...s, events: { a: [...s.events.a, cmdEv(2, { id: 'm1', name: 'model', args: 'sonnet', status: 'done', text: 'Set model to Sonnet' })] } }
    r.rerender(<Session state={done} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Model: Opus 5.5' }).getAttribute('aria-busy')).toBe('false')
    const moved = { ...done, sessions: { a: { ...done.sessions.a, model: 'claude-sonnet-5-5' } } }
    r.rerender(<Session state={moved} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Model: Sonnet 5.5' })).toBeTruthy()
  })
})

describe('Session: model chip', () => {
  it('shows the exact option label when the model is an option value', () => {
    render(<Session state={withModel({ model: 'opus', modelOptions: [...OPTS, { value: 'opus[1m]', label: 'Opus (1M context)', description: '' }] })} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Model: Opus' })).toBeTruthy()
    cleanup()
    render(<Session state={withModel({ model: 'opus[1m]', modelOptions: [...OPTS, { value: 'opus[1m]', label: 'Opus (1M context)', description: '' }] })} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Model: Opus (1M context)' })).toBeTruthy()
  })
  it('a full model id still reads as its short name (not the family option label)', () => {
    render(<Session state={withModel({ model: 'claude-sonnet-5-5' })} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Model: Sonnet 5.5' })).toBeTruthy()
  })
  it('an old queued model command (over 2 min) does not keep the chip spinning', () => {
    const s = withModel()
    s.events = { a: [{ ...cmdEv(1, { id: 'm1', name: 'model', args: 'sonnet', status: 'queued' }), ts: Date.now() - 3 * 60_000 }] }
    render(<Session state={s} id="a" onEvents={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Model: Opus 5.5' }).getAttribute('aria-busy')).toBe('false')
  })
  it('a fresh queued model command spins until it is 2 min old', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const s = withModel()
      s.events = { a: [{ ...cmdEv(1, { id: 'm1', name: 'model', args: 'sonnet', status: 'queued' }), ts: Date.now() }] }
      render(<Session state={s} id="a" onEvents={vi.fn()} />)
      const chip = () => screen.getByRole('button', { name: 'Model: Opus 5.5' })
      expect(chip().getAttribute('aria-busy')).toBe('true')
      act(() => { vi.advanceTimersByTime(2 * 60_000 + 10) })
      expect(chip().getAttribute('aria-busy')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })
  it('a pick with no answer from the mod stops spinning after 20 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response('', { status: 202 }))
    vi.stubGlobal('fetch', f)
    try {
      render(<Session state={withModel()} id="a" onEvents={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Model: Opus 5.5' }))
      fireEvent.click(screen.getByRole('radio', { name: /Sonnet/ }))
      const chip = () => screen.getByRole('button', { name: 'Model: Opus 5.5' })
      expect(chip().getAttribute('aria-busy')).toBe('true')
      act(() => { vi.advanceTimersByTime(19_000) })
      expect(chip().getAttribute('aria-busy')).toBe('true')
      act(() => { vi.advanceTimersByTime(1_100) })
      expect(chip().getAttribute('aria-busy')).toBe('false')
    } finally {
      vi.useRealTimers()
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    }
  })
  it('a failed set_model request stops the spinner and shows the error', async () => {
    const f = vi.fn(async (u: string, _i?: RequestInit) =>
      String(u).endsWith('/model') ? new Response('model switch failed', { status: 500 }) : new Response('[]'))
    vi.stubGlobal('fetch', f)
    try {
      render(<Session state={withModel()} id="a" onEvents={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Model: Opus 5.5' }))
      fireEvent.click(await screen.findByRole('radio', { name: /Sonnet/ }))
      expect(await screen.findByRole('alert')).toBeTruthy()
      await waitFor(() => expect(screen.getByRole('button', { name: 'Model: Opus 5.5' }).getAttribute('aria-busy')).toBe('false'))
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    }
  })
})

describe('Session: commands', () => {
  it('re-reads the command list after the live feed reconnects', async () => {
    const list = { session: 'a', commands: [], hash: 'h' }
    const f = vi.fn(async (u: string) => new Response(String(u).endsWith('/commands') ? JSON.stringify(list) : '[]'))
    vi.stubGlobal('fetch', f)
    try {
      const onCommands = vi.fn()
      const s = { ...st(), commandsRev: { a: 2 } }
      const r = render(<Session state={s} id="a" onEvents={vi.fn()} onCommands={onCommands} reconnects={0} />)
      await waitFor(() => expect(onCommands).toHaveBeenCalledTimes(1))
      const reads = () => f.mock.calls.filter(([u]) => String(u).endsWith('/commands')).length
      expect(reads()).toBe(1)
      const s2 = { ...s, commandsRev: { a: 3 } }
      r.rerender(<Session state={s2} id="a" onEvents={vi.fn()} onCommands={onCommands} reconnects={1} />)
      await waitFor(() => expect(onCommands).toHaveBeenCalledTimes(2))
      expect(reads()).toBe(2)
      // the revision is the one read before that request
      expect(onCommands.mock.calls[1][1]).toBe(3)
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    }
  })
  it('reads the command list on open with the revision taken before the request', async () => {
    const list = { session: 'a', commands: [{ name: 'compact', description: '', source: 'builtin', plugin: '', group: 'session', terminalOnly: false }], hash: 'h' }
    vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response(String(u).endsWith('/commands') ? JSON.stringify(list) : '[]')))
    try {
      const s = { ...st(), commandsRev: { a: 4 } }
      const onCommands = vi.fn()
      render(<Session state={s} id="a" onEvents={vi.fn()} onCommands={onCommands} />)
      await waitFor(() => expect(onCommands).toHaveBeenCalledWith(list, 4))
    } finally {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    }
  })
})

describe('Session: seen', () => {
  const ev = (seq: number) => ({ seq, session: 'a', ts: seq, kind: 'assistant', data: { text: 'hi' } })
  it('marks seen at mount with the last seq, clears unread via onSeen, and reports the header state', async () => {
    const s = st()
    s.sessions.a = sess('a', { state: 'idle', unread: true })
    s.events = { a: [ev(3), ev(9)] }
    const onSeen = vi.fn()
    render(<Session state={s} id="a" onEvents={vi.fn()} onSeen={onSeen} />)
    expect(api.seen).toHaveBeenCalledWith('a', 9)
    await waitFor(() => expect(onSeen).toHaveBeenCalledWith('a'))
    expect(screen.getAllByText('Done · unread').length).toBeGreaterThan(0)
  })
  it('a turn_end arriving while open is marked seen within 2 s', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.seen).mockClear()
      const s = st()
      s.sessions.a = sess('a', { state: 'working' })
      s.events = { a: [ev(3)] }
      const onSeen = vi.fn()
      const { rerender } = render(<Session state={s} id="a" onEvents={vi.fn()} onSeen={onSeen} />)
      expect(api.seen).toHaveBeenLastCalledWith('a', 3)
      await vi.advanceTimersByTimeAsync(0)
      onSeen.mockClear()
      const next = { ...s, sessions: { ...s.sessions, a: { ...s.sessions.a, state: 'idle' as const, unread: true } },
        events: { a: [ev(3), { seq: 4, session: 'a', ts: 4, kind: 'turn_end', data: {} }] } }
      rerender(<Session state={next} id="a" onEvents={vi.fn()} onSeen={onSeen} />)
      expect(api.seen).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(api.seen).toHaveBeenLastCalledWith('a', 4)
      expect(onSeen).toHaveBeenCalledWith('a')
    } finally {
      vi.useRealTimers()
    }
  })
})
