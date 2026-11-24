// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import QueueSection from './QueueSection'
import { pluginStateChanged } from '../lib/pluginBus'
import type { Event, SessionInfo } from '../proto.gen'

const api = vi.hoisted(() => ({ pluginState: vi.fn(), pluginCommand: vi.fn() }))
vi.mock('../lib/api', () => api)

const sess = (o: Partial<SessionInfo> = {}) => ({ id: 's1', state: 'idle', plugins: ['after'], ...o }) as SessionInfo
const queue = (o: object = {}) => ({ items: [{ id: 11, text: 'first task', createdAt: 1 }, { id: 12, text: 'second task', createdAt: 2 }], running: null, paused: false, done: [], ...o })
const turnEnd = (seq: number) => ({ seq, session: 's1', ts: 0, kind: 'turn_end', data: {} }) as Event

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
async function show(props: { session?: SessionInfo; events?: Event[]; q?: unknown } = {}) {
  api.pluginState.mockResolvedValue('q' in props ? props.q : queue())
  const r = render(<QueueSection session={props.session ?? sess()} events={props.events ?? []} />)
  await flush()
  return r
}
const expand = async () => { fireEvent.click(screen.getByRole('button', { name: /^Queue \(/ })); await flush() }
const menu = async (row: number, item: string) => {
  fireEvent.keyDown(screen.getAllByRole('button', { name: 'Item actions' })[row], { key: 'Enter' })
  await flush()
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
  await flush()
}

beforeEach(() => { vi.useFakeTimers(); api.pluginState.mockReset(); api.pluginCommand.mockReset(); api.pluginCommand.mockResolvedValue({}) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('QueueSection', () => {
  it('is hidden without the after plugin or without state', async () => {
    const a = await show({ session: sess({ plugins: [] }) })
    expect(a.container.firstChild).toBeNull()
    expect(api.pluginState).not.toHaveBeenCalled()
    cleanup()
    const b = await show({ q: null })
    expect(b.container.firstChild).toBeNull()
  })
  it('header counts pending items, collapsed by default', async () => {
    await show()
    expect(screen.getByRole('button', { name: 'Queue (2)' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('first task')).toBeNull()
  })
  it('expanded: running item with spinner, pending numbered from 1', async () => {
    await show({ q: queue({ running: { id: 10, text: 'doing now' } }) })
    await expand()
    expect(screen.getByText('doing now')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getAllByTestId('queue-number').map((e) => e.textContent)).toEqual(['1', '2'])
  })
  it('item menu sends edit, top and rm with the 1-based position', async () => {
    await show()
    await expand()
    await menu(1, 'Move to top')
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'top 2')
    await menu(0, 'Remove')
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'rm 1')
    await menu(1, 'Edit')
    fireEvent.change(screen.getByLabelText('Edit task'), { target: { value: 'edit the README' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'edit 2 edit the README')
  })
  it('item actions re-read first and send the task\'s current position', async () => {
    await show()
    await expand()
    // the queue moved since it was shown: task 12 is now first
    api.pluginState.mockResolvedValue(queue({ items: [{ id: 12, text: 'second task' }, { id: 13, text: 'new' }] }))
    const reads = api.pluginState.mock.calls.length
    await menu(1, 'Remove')
    expect(api.pluginState.mock.calls.length).toBe(reads + 1)
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'rm 1')
  })
  it('editing follows the task id; a task gone from the queue sends nothing and refreshes', async () => {
    await show()
    await expand()
    await menu(1, 'Edit')
    fireEvent.change(screen.getByLabelText('Edit task'), { target: { value: 'changed' } })
    api.pluginState.mockResolvedValue(queue({ items: [{ id: 12, text: 'second task' }, { id: 11, text: 'first task' }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'edit 1 changed')
    api.pluginCommand.mockClear()
    await menu(1, 'Edit')
    expect((screen.getByLabelText('Edit task') as HTMLTextAreaElement).value).toBe('first task')
    api.pluginState.mockResolvedValue(queue({ items: [{ id: 12, text: 'second task' }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await flush()
    expect(api.pluginCommand).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('This task is no longer in the queue. The list was refreshed.')
    expect(screen.getByRole('button', { name: 'Queue (1)' })).toBeTruthy()
    api.pluginState.mockResolvedValue(queue({ items: [] }))
    await menu(0, 'Move to top')
    expect(api.pluginCommand).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('This task is no longer in the queue. The list was refreshed.')
  })
  it('adds after and before literally with the -- marker', async () => {
    await show()
    await expand()
    const box = screen.getByLabelText('New task')
    fireEvent.change(box, { target: { value: 'edit the README' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add after' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', '-- edit the README')
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'undo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add before' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'before', '-- undo')
  })
  it('rejects multi-line text and a leading slash without sending', async () => {
    await show()
    await expand()
    for (const v of ['a\nb', '/clear']) {
      fireEvent.change(screen.getByLabelText('New task'), { target: { value: v } })
      fireEvent.click(screen.getByRole('button', { name: 'Add after' }))
      await flush()
      expect(screen.getByText('Use one line that does not start with /')).toBeTruthy()
    }
    expect(api.pluginCommand).not.toHaveBeenCalled()
  })
  it('Pause / Resume follows paused; Undo sends undo', async () => {
    await show()
    await expand()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'pause')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'undo')
    cleanup()
    await show({ q: queue({ paused: true }) })
    await expand()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'resume')
  })
  it('Clear asks to confirm first', async () => {
    await show()
    await expand()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('Clear the queue?')).toBeTruthy()
    expect(api.pluginCommand).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clear' }))
    await flush()
    expect(api.pluginCommand).toHaveBeenLastCalledWith('s1', 'after', 'clear')
  })
  it('re-reads the state at 1 s and 3 s after a command', async () => {
    await show()
    await expand()
    const before = api.pluginState.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await flush()
    expect(api.pluginState.mock.calls.length).toBe(before)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.pluginState.mock.calls.length).toBe(before + 1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.pluginState.mock.calls.length).toBe(before + 2)
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(api.pluginState.mock.calls.length).toBe(before + 2)
  })
  it('re-reads on a new turn_end even while collapsed, not for an old one', async () => {
    const r = await show({ events: [turnEnd(5)] })
    const n = api.pluginState.mock.calls.length
    r.rerender(<QueueSection session={sess()} events={[turnEnd(5)]} />)
    await flush()
    expect(api.pluginState.mock.calls.length).toBe(n)
    r.rerender(<QueueSection session={sess()} events={[turnEnd(5), turnEnd(9)]} />)
    await flush()
    expect(api.pluginState.mock.calls.length).toBe(n + 1)
  })
  it('appears after a turn end when there was no state at mount', async () => {
    const r = await show({ q: null })
    expect(r.container.firstChild).toBeNull()
    api.pluginState.mockResolvedValue(queue())
    r.rerender(<QueueSection session={sess()} events={[turnEnd(3)]} />)
    await flush()
    expect(screen.getByRole('button', { name: 'Queue (2)' })).toBeTruthy()
  })
  it('re-reads when opened', async () => {
    await show()
    const n = api.pluginState.mock.calls.length
    await expand()
    expect(api.pluginState.mock.calls.length).toBe(n + 1)
  })
  it('re-reads at 1 s and 3 s after the composer queues with /after (also when hidden)', async () => {
    const r = await show({ q: null })
    api.pluginState.mockResolvedValue(queue({ items: [{ id: 1, text: 'queued' }] }))
    const n = api.pluginState.mock.calls.length
    act(() => { pluginStateChanged('other', 'after'); pluginStateChanged('s1', 'time-machine') })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(api.pluginState.mock.calls.length).toBe(n)
    act(() => { pluginStateChanged('s1', 'after') })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.pluginState.mock.calls.length).toBe(n + 1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(api.pluginState.mock.calls.length).toBe(n + 2)
    expect(screen.getByRole('button', { name: 'Queue (1)' })).toBeTruthy()
    r.unmount()
    act(() => { pluginStateChanged('s1', 'after') })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(api.pluginState.mock.calls.length).toBe(n + 2)
  })
  it('notes that changes apply at the end of the turn while working', async () => {
    await show({ session: sess({ state: 'working' as any }) })
    await expand()
    expect(screen.getByText('Changes apply when Claude finishes this turn.')).toBeTruthy()
  })
  it('shows a command error', async () => {
    api.pluginCommand.mockRejectedValue(new Error('session is closed'))
    await show()
    await expand()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('session is closed')
  })
})
