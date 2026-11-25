// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import AgentCard, { agentPhase, elapsed } from './AgentCard'
import type { AgentItem } from '../../lib/timeline'

afterEach(() => { cleanup(); vi.useRealTimers() })
const T0 = 1_800_000_000_000
const agent = (o: Partial<AgentItem> = {}): AgentItem => ({ t: 'agent', seq: 1, id: 'a', key: o.id ?? 'a', type: 'Explore', description: 'find callers', status: 'running', steps: 0, ...o })

describe('AgentCard', () => {
  it('one subagent: status, type, steps, live clock, last tool and tokens', () => {
    vi.useFakeTimers({ now: T0 + 65_000 })
    render(<AgentCard agents={[agent({ startedAt: T0, steps: 4, lastTool: 'Read reducer.ts', tokens: 18_400 })]} onOpen={() => {}} />)
    expect(screen.getByLabelText('running')).toBeTruthy()
    expect(screen.getByText('Explore')).toBeTruthy()
    expect(screen.getByText('Working')).toBeTruthy()
    expect(screen.getByText('4 steps')).toBeTruthy()
    expect(screen.getByText('1m 05s')).toBeTruthy()
    expect(screen.getByText('Read reducer.ts')).toBeTruthy()
    expect(screen.getByText('18k tok')).toBeTruthy()
  })
  it('a finished one shows its whole run and no last tool', () => {
    render(<AgentCard agents={[agent({ status: 'completed', startedAt: T0, endedAt: T0 + 42_000, steps: 1, lastTool: 'ls' })]} onOpen={() => {}} />)
    expect(screen.getByLabelText('done')).toBeTruthy()
    expect(screen.getByText('42s')).toBeTruthy()
    expect(screen.getByText('1 step')).toBeTruthy()
    expect(screen.queryByText('ls')).toBeNull()
  })
  it('tapping the line opens the subagent', () => {
    const onOpen = vi.fn()
    render(<AgentCard agents={[agent({ id: 'ag7' })]} onOpen={onOpen} />)
    const line = screen.getByRole('button', { name: /find callers/ })
    expect(line.className).toContain('min-h-11')
    fireEvent.click(line)
    expect(onOpen).toHaveBeenCalledWith('ag7')
  })
  it('subagents launched together: one card, one line each, collapsible', () => {
    const onOpen = vi.fn()
    render(<AgentCard onOpen={onOpen} agents={[
      agent({ seq: 1, id: 'a', description: 'one' }),
      agent({ seq: 2, id: 'b', description: 'two', status: 'completed', tokens: 1000 }),
      agent({ seq: 3, id: 'c', description: 'three', status: 'error' }),
    ]} />)
    expect(screen.getAllByTestId('agent-group')).toHaveLength(1)
    expect(screen.getByText('3 subagents')).toBeTruthy()
    expect(screen.getByText('1 running · 1 done · 1 failed · 1k tok')).toBeTruthy()
    expect(screen.getAllByTestId('agent-line')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: /two/ }))
    expect(onOpen).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByRole('button', { name: /3 subagents/ }))
    expect(screen.queryAllByTestId('agent-line')).toHaveLength(0)
  })
  it('a big group shows five, then all', () => {
    render(<AgentCard onOpen={() => {}} agents={Array.from({ length: 8 }, (_, i) => agent({ seq: i + 1, id: `a${i}`, description: `task ${i}` }))} />)
    expect(screen.getAllByTestId('agent-line')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8' }))
    expect(screen.getAllByTestId('agent-line')).toHaveLength(8)
  })
  it('background subagents keep their state: running in background, Ended, then the task_end status', () => {
    const a = agent({ id: 'ag', bg: { taskId: 'ag' } })
    const { rerender } = render(<AgentCard agents={[a]} bgEnded={() => false} onOpen={() => {}} />)
    expect(screen.getByText('Running in background')).toBeTruthy()
    rerender(<AgentCard agents={[a]} bgEnded={() => true} onOpen={() => {}} />)
    expect(screen.getByText('Ended')).toBeTruthy()
    rerender(<AgentCard agents={[{ ...a, bg: { taskId: 'ag', status: 'failed' } }]} bgEnded={() => false} onOpen={() => {}} />)
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(agentPhase({ ...a, status: 'completed' }, () => false)).toBe('done')
    expect(agentPhase({ ...a, status: 'killed' })).toBe('stopped')
  })
  it('elapsed reads short', () => {
    expect(elapsed(0)).toBe('0s')
    expect(elapsed(59_999)).toBe('59s')
    expect(elapsed(3_723_000)).toBe('1h 02m')
  })
  it('a finished card with no recorded steps does not say 0 steps; a working one does', () => {
    const { rerender } = render(<AgentCard agents={[agent({ status: 'completed', steps: 0 })]} onOpen={() => {}} />)
    expect(screen.queryByText('0 steps')).toBeNull()
    rerender(<AgentCard agents={[agent({ steps: 0 })]} onOpen={() => {}} />)
    expect(screen.getByText('0 steps')).toBeTruthy()
  })
  it('an ask on a subagent: Needs your answer on its line, by key', () => {
    render(<AgentCard agents={[agent({ key: 'k1', id: 'other' })]} asking={new Set(['k1'])} onOpen={() => {}} />)
    expect(screen.getByText('Needs your answer')).toBeTruthy()
    expect(screen.getByLabelText('needs your answer')).toBeTruthy()
  })
  it('the group header controls its list', () => {
    render(<AgentCard onOpen={() => {}} agents={[agent({ seq: 1, id: 'a' }), agent({ seq: 2, id: 'b', key: 'b' })]} />)
    const head = screen.getByRole('button', { name: /2 subagents/ })
    const id = head.getAttribute('aria-controls')!
    expect(document.getElementById(id)?.contains(screen.getAllByTestId('agent-line')[0])).toBe(true)
  })
})
