// @vitest-environment jsdom
import INSPECTOR_SOURCE from './Inspector.tsx?raw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import Session from '../../screens/Session'
import ArtifactsCard from './ArtifactsCard'
import BackgroundCard from './BackgroundCard'
import UsageCard from './UsageCard'
import { isHtmlArtifact } from '../../lib/artifacts'
import { initialState } from '../../lib/store'
import { sess } from '../../lib/fixtures.test-util'
import { LAYOUT_KEY, resetLayout } from '../../lib/useLayout'
import type { Event } from '../../proto.gen'

const built = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../lib/timeline', async (orig) => {
  const m = await orig<typeof import('../../lib/timeline')>()
  return { ...m, buildTimeline: (...a: Parameters<typeof m.buildTimeline>) => { built.n++; return m.buildTimeline(...a) } }
})
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), seen: vi.fn(async () => {}) }))
vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})

let width = 1300
const listeners = new Set<() => void>()
const mq = (q: string) => {
  const min = /min-width:\s*(\d+)px/.exec(q)?.[1]
  const max = /max-width:\s*(\d+)px/.exec(q)?.[1]
  return { get matches() { return (min ? width >= Number(min) : true) && (max ? width <= Number(max) : true) }, addEventListener: (_: string, h: () => void) => listeners.add(h), removeEventListener: (_: string, h: () => void) => listeners.delete(h) }
}
const resize = (w: number) => act(() => { width = w; listeners.forEach((h) => h()) })
let store: Map<string, string>

beforeEach(() => {
  width = 1300
  store = new Map()
  vi.stubGlobal('matchMedia', mq)
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? (k.includes('token') ? 'tok' : null), setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
  resetLayout()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); listeners.clear(); vi.stubGlobal('fetch', vi.fn(async () => new Response('[]'))) })

const ev = (seq: number, kind: string, data: unknown): Event => ({ seq, session: 'a', ts: 1, kind, data })
const edits = [
  ev(1, 'tool_start', { id: 't1', name: 'Edit', input: { file_path: '/r/src/a.ts', old_string: 'a', new_string: 'b\nc' } }),
  ev(2, 'tool_end', { id: 't1', ok: true, output: '' }),
  ev(3, 'assistant', { text: 'Report at [Q3](/v/ab12/q3.html), notes at [Notes](/v/ab12/notes.md)' }),
]
const st = (o = {}, evs: Event[] = []) => ({ ...initialState(), sessions: { a: sess('a', o) }, order: ['a'], events: { a: evs } })
const show = (s = st()) => render(<Session state={s} id="a" onEvents={vi.fn()} />)

describe('cards', () => {
  it('are hidden when empty', () => {
    const { container } = render(<><BackgroundCard background={{ tasks: 0, wakeAt: 0 }} /><ArtifactsCard links={[]} /></>)
    expect(container.innerHTML).toBe('')
  })
  it('the usage card is hidden without an account and shows the account meters with one', () => {
    const usage = { key: 'k', alias: 'work', at: Date.now(), fiveHour: { pct: 58, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, sevenDay: { pct: 24, resetsAt: new Date(Date.now() + 86_400_000).toISOString() } } as never
    const { container, rerender } = render(<UsageCard session={sess('a', { account: '' })} usage={usage} />)
    expect(container.innerHTML).toBe('')
    rerender(<UsageCard session={sess('a', { account: 'work', contextPct: 40 })} usage={usage} />)
    expect(screen.getByRole('progressbar', { name: '5-hour window 58%' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Week 24%' })).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'Context 40%' })).toBeTruthy()
    expect(screen.getByText('work')).toBeTruthy()
    expect(screen.getAllByText(/resets in/).length).toBe(2)
  })
  it('the usage meters tone their bar and number at warn and danger levels', () => {
    const usage = { key: 'k', alias: 'work', at: Date.now(), fiveHour: { pct: 97, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, sevenDay: { pct: 85, resetsAt: new Date(Date.now() + 86_400_000).toISOString() } } as never
    render(<UsageCard session={sess('a', { account: 'work' })} usage={usage} />)
    expect(screen.getByText('97%').getAttribute('data-tone')).toBe('danger')
    expect(screen.getByText('85%').getAttribute('data-tone')).toBe('warn')
    const bar = screen.getByRole('progressbar', { name: '5-hour window 97%' }).firstElementChild as HTMLElement
    expect(bar.className).toContain('bg-danger')
  })
  it('the inspector lists usage before background work', () => {
    expect(INSPECTOR_SOURCE.indexOf('<UsageCard')).toBeLessThan(INSPECTOR_SOURCE.indexOf('<BackgroundCard'))
  })
  it('card headings are sentence case with no caps or tracking', () => {
    render(<ArtifactsCard links={[{ title: 'Q3', url: '/v/ab12/q3.html', eventKey: 'a:1' }]} />)
    const h = screen.getByRole('heading', { name: 'Artifacts' })
    expect(h.className).not.toMatch(/uppercase|tracking/)
  })
  it('only HTML pages count as artifacts', () => {
    const is = (url: string) => isHtmlArtifact({ title: '', url, eventKey: '' })
    expect(is('/v/ab12/q3.html')).toBe(true)
    expect(is('https://hub.example/v/ab12/Report.HTM?x=1#top')).toBe(true)
    expect(is('/v/ab12/notes.md')).toBe(false)
    expect(is('/v/ab12/data.html.json')).toBe(false)
  })
})

describe('Session inspector', () => {
  it('builds nothing for the cards while the inspector is closed', () => {
    width = 1100
    show(st({}, edits))
    const closed = built.n
    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
    expect(built.n - closed).toBe(1)
    const open = built.n
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(built.n).toBe(open)
  })
  it('is docked and open at 1300 px, with cards built from the loaded events', () => {
    show(st({}, edits))
    const aside = screen.getByRole('complementary', { name: 'Inspector' })
    expect(within(aside).queryByText('Changed files')).toBeNull()
    expect(within(aside).getByRole('button', { name: 'Q3' })).toBeTruthy()
    expect(within(aside).queryByRole('button', { name: 'Notes' })).toBeNull()
    expect(within(aside).queryByText('Usage')).toBeNull()
    expect(within(aside).queryByText('Background')).toBeNull()
  })
  it('the header button and Ctrl+. toggle it, and the state is persisted per placement', () => {
    show()
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy()
    fireEvent.keyDown(window, { key: '.', metaKey: true })
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    expect(JSON.parse(store.get(LAYOUT_KEY)!).inspector.docked).toBe(false)
  })
  it('an open sheet or overlay is closed again when another session view mounts', () => {
    for (const w of [800, 1100]) {
      width = w
      const find = () => w < 1024 ? screen.queryByRole('dialog') : screen.queryByRole('complementary', { name: 'Inspector' })
      const { unmount } = show(st({}, edits))
      fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
      expect(find()).toBeTruthy()
      unmount()
      show(st({}, edits))
      expect(find()).toBeNull()
      cleanup()
    }
    expect(JSON.parse(store.get(LAYOUT_KEY) ?? '{"inspector":{}}').inspector.overlay).toBeUndefined()
  })
  it('the toggle is a 44 px target', () => {
    show()
    expect(screen.getByRole('button', { name: 'Inspector' }).className).toContain('size-11')
  })
  it('overlay (1100 px) starts closed and closes with Esc or an outside click', () => {
    width = 1100
    show(st({}, edits))
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
    fireEvent.pointerDown(screen.getByRole('complementary', { name: 'Inspector' }))
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
  })
  it('Ctrl+. and the overlay Esc are ignored while a modal dialog is open', () => {
    width = 1100
    show(st({}, edits))
    const aside = () => screen.queryByRole('complementary', { name: 'Inspector' })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    document.body.appendChild(dialog)
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(aside()).toBeNull()
    dialog.remove()
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(aside()).toBeTruthy()
    document.body.appendChild(dialog)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(aside()).toBeTruthy()
    fireEvent.keyDown(window, { key: '.', metaKey: true })
    expect(aside()).toBeTruthy()
    dialog.remove()
    // an Esc another handler already took leaves it open too
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    e.preventDefault()
    act(() => { document.dispatchEvent(e) })
    expect(aside()).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(aside()).toBeNull()
  })
  it('on a phone it opens a bottom sheet', () => {
    width = 800
    show(st({}, edits))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
    const d = screen.getByRole('dialog')
    expect(within(d).getByText('Artifacts')).toBeTruthy()
  })
  it('crossing breakpoints keeps the open session and the draft', () => {
    show(st({}, edits))
    const box = () => screen.getByRole('combobox') as HTMLTextAreaElement
    fireEvent.change(box(), { target: { value: 'half a thought' } })
    const el = box()
    resize(1100)
    expect(box()).toBe(el)
    expect(box().value).toBe('half a thought')
    resize(800)
    expect(box()).toBe(el)
    expect(box().value).toBe('half a thought')
  })
})

describe('Background card', () => {
  const items = [
    { id: 'c1', kind: 'command', label: 'npm run watch', startedAt: Date.now() - 60_000 },
    { id: 'ag1', kind: 'subagent', label: 'Audit the docs', startedAt: Date.now() - 60_000 },
    { id: 'lp1', kind: 'loop', label: 'check the build', startedAt: Date.now() - 60_000, nextWake: Date.now() + 60_000 },
  ]
  const live = (o = {}) => st({ background: { tasks: 3, wakeAt: 0, items }, ...o })
  const facts = (o = {}) => ({ found: true, size: 5, mtime: Date.now() - 3 * 60_000, tail: 'watching files\nready', procsKnown: true, procs: [{ pid: 9, state: 'S', cpuMs: 2100 }], ...o })
  const stubFacts = (f: object | (() => object) = facts) => {
    const fn = vi.fn(async (u: string) => (String(u).includes('/output') ? new Response(JSON.stringify(typeof f === 'function' ? f() : f)) : new Response('[]')))
    vi.stubGlobal('fetch', fn)
    return fn
  }
  const card = () => screen.getByRole('region', { name: 'Background' })

  it('lists live items in a scroll region with a max height, with facts for commands', async () => {
    stubFacts()
    show(live())
    expect(within(card()).getAllByRole('listitem')).toHaveLength(3)
    expect(card().querySelector('[class*="max-h-80"]')).toBeTruthy()
    expect(await within(card()).findByText('last output 3 min ago · sleeping · 2.1 s CPU')).toBeTruthy()
    expect(within(card()).queryByText('Dead')).toBeNull()
  })
  it('marks an item Dead in the danger tone when its processes are gone', async () => {
    stubFacts(() => facts({ procs: [] }))
    show(live())
    const dead = await within(card()).findByText('Dead')
    expect(dead.className).toContain('text-danger')
    expect(card().textContent).not.toMatch(/hung/i)
  })
  it('marks every live item Dead when the session is closed', () => {
    stubFacts()
    show(live({ state: 'closed' }))
    expect(within(card()).getAllByText('Dead')).toHaveLength(3)
  })
  it('opens a subagent through onOpenAgent and does not make loops clickable', () => {
    stubFacts()
    const onOpenAgent = vi.fn()
    render(<BackgroundCard background={{ tasks: 3, wakeAt: 0, items }} sessionId="a" sessionState="idle" events={[]} onOpenAgent={onOpenAgent} />)
    fireEvent.click(screen.getByRole('button', { name: /Audit the docs/ }))
    expect(onOpenAgent).toHaveBeenCalledWith('ag1')
    expect(screen.queryByRole('button', { name: /check the build/ })).toBeNull()
  })
  it('a command opens the output view with the fetched tail', async () => {
    stubFacts()
    show(live())
    fireEvent.click(within(card()).getByRole('button', { name: /npm run watch/ }))
    const d = await screen.findByRole('dialog')
    expect((await within(d).findByText(/watching files/)).tagName).toBe('PRE')
    expect(within(d).getByText('last output 3 min ago · sleeping · 2.1 s CPU')).toBeTruthy()
  })
  it('stops fetching when the inspector closes', async () => {
    vi.useFakeTimers()
    try {
      const fn = stubFacts()
      show(live())
      await act(async () => { await vi.advanceTimersByTimeAsync(10_500) })
      const calls = () => fn.mock.calls.filter((c) => String(c[0]).includes('/output')).length
      expect(calls()).toBeGreaterThanOrEqual(2)
      fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
      const n = calls()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(calls()).toBe(n)
    } finally { vi.useRealTimers() }
  })
  it('a background subagent row opens its screen, and a floating inspector closes', () => {
    stubFacts()
    const evs = [
      ev(1, 'tool_start', { id: 'call1', name: 'Agent', input: { description: 'Audit the docs', subagent_type: 'general-purpose', prompt: 'Audit everything' } }),
      ev(2, 'tool_end', { id: 'call1', ok: true, output: 'started', background: { taskId: 'ag1' } }),
    ]
    width = 1100
    show(st({ background: { tasks: 1, wakeAt: 0, items: [items[1]] } }, evs))
    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
    fireEvent.click(within(card()).getByRole('button', { name: /Audit the docs/ }))
    expect(screen.getByRole('dialog', { name: 'Audit the docs' })).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull()
  })
  it('clicking the output dialog backdrop does not close the overlay inspector', async () => {
    stubFacts()
    width = 1100
    show(live())
    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }))
    fireEvent.click(within(card()).getByRole('button', { name: /npm run watch/ }))
    await screen.findByRole('dialog')
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')!
    fireEvent.pointerDown(overlay)
    // aria-hidden while the modal is open
    expect(screen.getByRole('complementary', { name: 'Inspector', hidden: true })).toBeTruthy()
  })
  it('a task already ended is not listed as running and gets no Dead badge', () => {
    stubFacts()
    const evs = [ev(5, 'task_end', { taskId: 'c1', kind: 'command', summary: 'npm run watch', status: 'completed', exitCode: 0 })]
    show(st({ background: { tasks: 1, wakeAt: 0, items: [items[0]] } }, evs))
    expect(within(card()).getAllByRole('listitem')).toHaveLength(1)
    expect(within(card()).queryByText('Dead')).toBeNull()
    expect(within(card()).getByText('Ended')).toBeTruthy()
  })
  it('found:false reads "no output yet" with no Dead badge', async () => {
    stubFacts(() => facts({ found: false, procs: [] }))
    show(live())
    expect(await within(card()).findByText('no output yet')).toBeTruthy()
    expect(within(card()).queryByText('Dead')).toBeNull()
  })
  it('the output view stops polling once closed', async () => {
    vi.useFakeTimers()
    try {
      const fn = stubFacts()
      show(live())
      fireEvent.click(within(card()).getByRole('button', { name: /npm run watch/ }))
      await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })
      const calls = () => fn.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      const n = calls()
      await act(async () => { await vi.advanceTimersByTimeAsync(7_000) })
      expect(calls()).toBe(n)
    } finally { vi.useRealTimers() }
  })
  it('lists ended tasks with status and exit code, and shows the tail on click', async () => {
    stubFacts()
    const evs = [ev(5, 'task_end', { taskId: 'e1', kind: 'command', summary: 'npm test', status: 'failed', exitCode: 2, outputTail: 'boom: 3 failed' })]
    show(st({}, evs))
    const row = within(card()).getByRole('button', { name: /npm test/ })
    expect(row.textContent).toMatch(/failed/)
    expect(row.textContent).toMatch(/exit 2/)
    fireEvent.click(row)
    expect(await within(await screen.findByRole('dialog')).findByText(/boom: 3 failed/)).toBeTruthy()
  })
})
