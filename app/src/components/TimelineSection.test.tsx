// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import TimelineSection from './TimelineSection'
import { parseTimeMachine } from '../lib/timemachine'
import type { Event, SessionInfo } from '../proto.gen'

const api = vi.hoisted(() => ({ pluginState: vi.fn(), pluginCommand: vi.fn() }))
vi.mock('../lib/api', () => api)

const NOW = 1_700_000_000_000
const sess = (o: Partial<SessionInfo> = {}) => ({ id: 's1', state: 'idle', plugins: ['time-machine'], ...o }) as SessionInfo
const st = (id: number, o: object = {}) => ({ id, kind: 'turn', label: `turn ${id}`, at: NOW - (10 - id) * 60_000, commit: 'c', tree: 't', head: null, parent: id > 1 ? id - 1 : null, files: [], ...o })
// The plugin stores states oldest first and its ids are not positions: #3 and #4 were pruned here
const tl = (o: object = {}) => ({
  at: NOW, cursor: 7,
  states: [st(1, { kind: 'start', label: 'start of the session' }), st(2), st(5, { files: [{ path: 'src/a.ts', status: 'M', added: 10, removed: 3 }, { path: 'src/b.ts', status: 'A', added: 2, removed: 1 }, { path: 'c.md', status: 'D', added: 0, removed: 0 }] }), st(7)],
  ...o,
})
const turnEnd = (seq: number) => ({ seq, session: 's1', ts: 0, kind: 'turn_end', data: {} }) as Event

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
async function show(props: { session?: SessionInfo; events?: Event[]; t?: unknown } = {}) {
  api.pluginState.mockResolvedValue('t' in props ? props.t : tl())
  const r = render(<TimelineSection session={props.session ?? sess()} events={props.events ?? []} />)
  await flush()
  return r
}
const open = async () => { fireEvent.click(screen.getByRole('button', { name: /^Timeline \(/ })); await flush() }
const rows = () => screen.getAllByTestId('timeline-row')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); api.pluginState.mockReset(); api.pluginCommand.mockReset(); api.pluginCommand.mockResolvedValue({}) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('parseTimeMachine', () => {
  it('tolerates unknown shapes', () => {
    expect(parseTimeMachine(null)).toBeNull()
    expect(parseTimeMachine('x')).toBeNull()
    expect(parseTimeMachine({})).toEqual({ states: [], cursor: null })
    const p = parseTimeMachine({ cursor: 'x', states: [null, { id: 'a' }, { id: 3, label: 5, at: 'z', files: [{ path: 1 }, { path: 'f', added: 'q' }] }] })!
    expect(p.cursor).toBeNull()
    expect(p.states).toEqual([{ id: 3, kind: '', label: '', at: 0, files: [{ path: 'f', status: '', added: 0, removed: 0 }] }])
  })
})

describe('TimelineSection', () => {
  it('is hidden without the plugin or without state', async () => {
    const a = await show({ session: sess({ plugins: ['after'] }) })
    expect(a.container.firstChild).toBeNull()
    expect(api.pluginState).not.toHaveBeenCalled()
    cleanup()
    expect((await show({ t: null })).container.firstChild).toBeNull()
    cleanup()
    expect((await show({ t: { states: [], cursor: null } })).container.firstChild).toBeNull()
  })
  it('lists states newest first with label, age and file digest; marks the cursor state Current', async () => {
    await show()
    expect(screen.getByRole('button', { name: 'Timeline (4)' })).toBeTruthy()
    await open()
    const r = rows()
    expect(r.map((x) => within(x).getByTestId('timeline-label').textContent)).toEqual(['turn 7', 'turn 5', 'turn 2', 'start of the session'])
    expect(within(r[1]).getByText('3 files +12 −4')).toBeTruthy()
    expect(within(r[1]).getByText('5 min ago')).toBeTruthy()
    expect(screen.getAllByText('Current')).toHaveLength(1)
    expect(within(r[0]).getByText('Current')).toBeTruthy()
  })
  it('a long label is clamped to 2 lines in the list and shown in full when expanded', async () => {
    await show()
    await open()
    const label = () => within(rows()[1]).getByTestId('timeline-label')
    expect(label().className).toMatch(/\bline-clamp-2\b/)
    expect(label().className).toContain('[overflow-wrap:anywhere]')
    fireEvent.click(within(rows()[1]).getByRole('button', { name: /turn 5/ }))
    expect(label().className).not.toMatch(/\bline-clamp-2\b/)
    expect(label().className).toContain('[overflow-wrap:anywhere]')
  })
  it('expanding a row lists its files', async () => {
    await show()
    await open()
    expect(screen.queryByText('src/a.ts')).toBeNull()
    fireEvent.click(within(rows()[1]).getByRole('button', { name: /turn 5/ }))
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('c.md')).toBeTruthy()
  })
  it('Go to this state sends the plugin state id (not the list position)', async () => {
    await show()
    await open()
    expect(within(rows()[0]).queryByRole('button', { name: 'Go to this state' })).toBeNull()
    fireEvent.click(within(rows()[1]).getByRole('button', { name: /turn 5/ }))
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Go to this state' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'timeline', '5')
  })
  it('re-reads right before go-to and resolves n from the tapped id', async () => {
    await show()
    await open()
    fireEvent.click(within(rows()[2]).getByRole('button', { name: /turn 2/ }))
    api.pluginState.mockResolvedValue(tl({ states: [st(1), st(2)], cursor: 2 }))
    fireEvent.click(within(rows()[2]).getByRole('button', { name: 'Go to this state' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'timeline', '2')
  })
  it('a vanished state sends nothing and refreshes the list', async () => {
    await show()
    await open()
    fireEvent.click(within(rows()[1]).getByRole('button', { name: /turn 5/ }))
    api.pluginState.mockResolvedValue(tl({ states: [st(1), st(2), st(7)] }))
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Go to this state' }))
    await flush()
    expect(api.pluginCommand).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('This state no longer exists. The list was refreshed.')
    expect(screen.getByRole('button', { name: 'Timeline (3)', hidden: true })).toBeTruthy()
  })
  it('Undo and Redo send timeline undo|redo', async () => {
    await show({ t: tl({ cursor: 5 }) })
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'timeline', 'undo')
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'timeline', 'redo')
  })
  it('Undo is off at the oldest state, Redo when there is nothing to redo', async () => {
    const off = (n: string) => (screen.getByRole('button', { name: n }) as HTMLButtonElement).disabled
    await show() // cursor at the newest state
    await open()
    expect([off('Undo'), off('Redo')]).toEqual([false, true])
    cleanup()
    await show({ t: tl({ cursor: 1 }) })
    await open()
    expect([off('Undo'), off('Redo')]).toEqual([true, false])
  })
  it('Undo reads first and compares against that fresh cursor', async () => {
    await show({ t: tl({ cursor: 7 }) })
    await open()
    // the cursor moved to 5 since the list was shown; the plugin then does not move
    api.pluginState.mockResolvedValue(tl({ cursor: 5 }))
    const n = api.pluginState.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    expect(api.pluginState.mock.calls.length).toBe(n + 1)
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'timeline', 'undo')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('alert').textContent).toBe('The timeline did not move. Claude may be working; try again when it finishes.')
  })
  it('a fresh read that shows nothing to undo sends nothing', async () => {
    await show({ t: tl({ cursor: 5 }) })
    await open()
    api.pluginState.mockResolvedValue(tl({ cursor: 1 }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    expect(api.pluginCommand).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('a failed fresh read shows an error and sends nothing', async () => {
    await show({ t: tl({ cursor: 5 }) })
    await open()
    api.pluginState.mockRejectedValue(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    await flush()
    expect(api.pluginCommand).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Could not read the timeline.')
    fireEvent.click(within(rows()[2]).getByRole('button', { name: /turn 2/ }))
    fireEvent.click(within(rows()[2]).getByRole('button', { name: 'Go to this state' }))
    await flush()
    expect(api.pluginCommand).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Could not read the timeline.')
  })
  it('while working every action is disabled with a note', async () => {
    await show({ session: sess({ state: 'working' }) })
    await open()
    expect(screen.getByText('Wait until Claude finishes')).toBeTruthy()
    for (const n of ['Undo', 'Redo']) expect((screen.getByRole('button', { name: n }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(rows()[1]).getByRole('button', { name: /turn 5/ }))
    expect((within(rows()[1]).getByRole('button', { name: 'Go to this state' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('re-reads at 1 s and 3 s after a command; unchanged cursor warns', async () => {
    await show()
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    api.pluginState.mockClear() // the read right before sending
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.pluginState).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.pluginState).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert').textContent).toBe('The timeline did not move. Claude may be working; try again when it finishes.')
  })
  it('no warning when the cursor moved', async () => {
    await show()
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    api.pluginState.mockResolvedValue(tl({ cursor: 5 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(rows()[1]).getByText('Current')).toBeTruthy()
  })
  it('refreshes on every new turn end, open or closed; re-reads on open', async () => {
    const r = await show()
    api.pluginState.mockClear()
    r.rerender(<TimelineSection session={sess()} events={[turnEnd(1)]} />)
    await flush()
    expect(api.pluginState).toHaveBeenCalledTimes(1)
    r.rerender(<TimelineSection session={sess()} events={[turnEnd(1)]} />)
    await flush()
    expect(api.pluginState).toHaveBeenCalledTimes(1)
    await open()
    expect(api.pluginState).toHaveBeenCalledTimes(2)
    r.rerender(<TimelineSection session={sess()} events={[turnEnd(1), turnEnd(2)]} />)
    await flush()
    expect(api.pluginState).toHaveBeenCalledTimes(3)
  })
  it('appears after a turn end when there was no state at mount', async () => {
    const r = await show({ t: null })
    expect(r.container.firstChild).toBeNull()
    api.pluginState.mockResolvedValue(tl())
    r.rerender(<TimelineSection session={sess()} events={[turnEnd(4)]} />)
    await flush()
    expect(screen.getByRole('button', { name: 'Timeline (4)' })).toBeTruthy()
  })
})
