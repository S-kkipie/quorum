// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('../lib/api', () => ({ createView: vi.fn(), hubUrl: () => '' }))
import Transcript from './Transcript'
import { SHOWN_MAX } from './timeline/AgentScreen'
import type { Event } from '../proto.gen'

afterEach(cleanup)
let n = 0
const ev = (kind: string, data: any): Event => ({ seq: ++n, session: 's', ts: 1_800_000_000_000 + n * 1000, kind, data })
const call = (id: string, description: string, agent?: string) =>
  ev('tool_start', { id, name: 'Agent', summary: '', agent, input: { description, subagent_type: 'Explore', prompt: `TASK ${description}` } })
const bash = (id: string, command: string, agent?: string) => [ev('tool_start', { id, name: 'Bash', summary: '', agent, input: { command } }), ev('tool_end', { id, ok: true, ms: 1, output: `OUT ${command}`, agent })]

const events = (): Event[] => [
  ev('user', { text: 'audit everything' }),
  call('t1', 'audit reducer'), call('t2', 'audit store'), call('t3', 'audit hub'),
  ev('agent_start', { id: 'A', type: 'Explore', description: 'audit reducer', tool: 't1' }),
  ev('agent_start', { id: 'B', type: 'Explore', description: 'audit store', tool: 't2' }),
  ev('agent_start', { id: 'C', type: 'Explore', description: 'audit hub', tool: 't3' }),
  ...bash('a1', 'grep reducer', 'A'),
  ...bash('b1', 'grep store', 'B'),
  call('t4', 'dig deeper', 'A'),
  ev('agent_start', { id: 'N', type: 'Plan', description: 'dig deeper', tool: 't4', agent: 'A' }),
  ...bash('n1', 'make deep', 'N'),
  ev('assistant', { text: 'reducer answer', agent: 'A' }),
  ev('agent_end', { id: 'B', status: 'completed', answer: 'store answer' }),
  ev('tool_end', { id: 't2', ok: true, ms: 1, output: 'store answer' }),
  ev('assistant', { text: 'main is waiting' }),
]

describe('Transcript with subagents', () => {
  it('the main transcript shows one group card and none of the subagents\' work', () => {
    render(<Transcript events={events()} />)
    expect(screen.getAllByTestId('agent-group')).toHaveLength(1)
    expect(screen.getByText('3 subagents')).toBeTruthy()
    expect(screen.queryByText('grep reducer')).toBeNull()
    expect(screen.queryByText('grep store')).toBeNull()
    expect(screen.queryByText('reducer answer')).toBeNull()
    expect(screen.queryByText('dig deeper')).toBeNull()
    expect(screen.getByText('main is waiting')).toBeTruthy()
  })
  it('tapping a subagent opens its own screen with its task, its steps and its answer', () => {
    render(<Transcript events={events()} />)
    fireEvent.click(screen.getByRole('button', { name: /audit reducer/ }))
    const s = within(screen.getByTestId('agent-screen'))
    expect(s.getByRole('heading', { name: 'audit reducer' })).toBeTruthy()
    expect(s.getByRole('article', { name: 'Task' }).textContent).toContain('TASK audit reducer')
    expect(s.getByText('grep reducer')).toBeTruthy()
    expect(s.queryByText('grep store')).toBeNull()
    expect(s.getByText('reducer answer')).toBeTruthy()
    expect(s.getAllByText('Working').length).toBeGreaterThan(0)
    expect(s.getByText('2 steps')).toBeTruthy()
    // the same rows as the main transcript: a tool row expands to its output
    fireEvent.click(s.getByText('grep reducer'))
    expect(s.getByText('OUT grep reducer')).toBeTruthy()
  })
  it('a finished subagent without its own answer row shows the agent_end answer', () => {
    render(<Transcript events={events()} />)
    fireEvent.click(screen.getByRole('button', { name: /audit store/ }))
    const s = within(screen.getByTestId('agent-screen'))
    expect(s.getByText('store answer')).toBeTruthy()
    expect(s.getByText('Done')).toBeTruthy()
  })
  it('a nested subagent is a card inside its parent\'s screen; it opens on top and Back returns to the parent', () => {
    render(<Transcript events={events()} />)
    fireEvent.click(screen.getByRole('button', { name: /audit reducer/ }))
    let s = within(screen.getByTestId('agent-screen'))
    fireEvent.click(s.getByRole('button', { name: /dig deeper/ }))
    s = within(screen.getByTestId('agent-screen'))
    expect(s.getByRole('heading', { name: 'dig deeper' })).toBeTruthy()
    expect(s.getByText(/inside audit reducer/)).toBeTruthy()
    expect(s.getByText('make deep')).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Back to the parent subagent' }))
    s = within(screen.getByTestId('agent-screen'))
    expect(s.getByRole('heading', { name: 'audit reducer' })).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Back to the session' }))
    expect(screen.queryByTestId('agent-screen')).toBeNull()
    // the main transcript is still there, as it was
    expect(screen.getByText('main is waiting')).toBeTruthy()
  })
  it('streams a running subagent\'s text on its screen', () => {
    render(<Transcript events={events()} liveAgent={{ C: 'hub so far' }} />)
    fireEvent.click(screen.getByRole('button', { name: /audit hub/ }))
    expect(within(screen.getByTestId('agent-screen')).getByText('hub so far')).toBeTruthy()
  })
  it('phone layout: the screen is full width with a 44 px Back, and the accent turns violet', () => {
    render(<Transcript events={events()} />)
    fireEvent.click(screen.getByRole('button', { name: /audit hub/ }))
    const el = screen.getByTestId('agent-screen')
    expect(el.className).toContain('w-full')
    expect(el.className).not.toContain('max-w-sm')
    expect(el.style.getPropertyValue('--accent')).toBe('var(--state-background)')
    expect(within(el).getByRole('button', { name: 'Back to the session' }).className).toContain('size-11')
    expect(within(el).queryByRole('button', { name: /stop/i })).toBeNull()
  })
  it('a long subagent renders its last items, with Show earlier', () => {
    const many: Event[] = [call('t1', 'busy'), ev('agent_start', { id: 'A', type: 'x', description: 'busy', tool: 't1' })]
    for (let i = 0; i < SHOWN_MAX + 5; i++) many.push(ev('assistant', { text: `step ${i}`, agent: 'A' }))
    render(<Transcript events={many} />)
    fireEvent.click(screen.getByRole('button', { name: /busy/ }))
    const s = within(screen.getByTestId('agent-screen'))
    expect(s.queryByText('step 0')).toBeNull()
    expect(s.getByText(`step ${SHOWN_MAX + 4}`)).toBeTruthy()
    fireEvent.click(s.getByRole('button', { name: 'Show earlier (5)' }))
    expect(s.getByText('step 0')).toBeTruthy()
  })
})

describe('Transcript indicator', () => {
  it('a subagent thinking is not the session thinking', () => {
    render(<Transcript events={[ev('user', { text: 'x' }), ev('thinking', { text: '', agent: 'A' })]} />)
    expect(screen.queryByText('Thinking…')).toBeNull()
  })
})
