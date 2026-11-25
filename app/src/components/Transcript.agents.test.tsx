// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const decide = vi.fn(async (..._a: any[]) => {})
vi.mock('../lib/api', () => ({ createView: vi.fn(), hubUrl: () => '', decide: (...a: any[]) => decide(...a) }))
import Transcript from './Transcript'
import { SHOWN_MAX } from './timeline/AgentScreen'
import type { Ask, Event } from '../proto.gen'

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
    expect(within(el).getByTestId('agent-accent').style.getPropertyValue('--accent')).toBe('var(--state-background)')
    expect(within(el).getByRole('button', { name: 'Back to the session' }).className).toContain('size-11')
    expect(within(el).queryByRole('button', { name: /stop/i })).toBeNull()
  })
  it('a long subagent renders its last 100 items (virtualized), with Show earlier', () => {
    expect(SHOWN_MAX).toBe(100)
    const many: Event[] = [call('t1', 'busy'), ev('agent_start', { id: 'A', type: 'x', description: 'busy', tool: 't1' })]
    for (let i = 0; i < SHOWN_MAX + 5; i++) many.push(ev('assistant', { text: `step ${i}`, agent: 'A' }))
    render(<Transcript events={many} />)
    fireEvent.click(screen.getByRole('button', { name: /busy/ }))
    const el = screen.getByTestId('agent-screen')
    const s = within(el)
    const shown = () => [...el.querySelectorAll('[data-index]')].map((e) => e.textContent ?? '')
    // virtualized: only rows near the viewport are in the DOM, and none of the 5 oldest
    expect(shown().length).toBeGreaterThan(0)
    expect(shown().length).toBeLessThan(SHOWN_MAX)
    for (let i = 0; i < 5; i++) expect(s.queryByText(`step ${i}`)).toBeNull()
    fireEvent.click(s.getByRole('button', { name: 'Show earlier (5)' }))
    expect(s.queryByRole('button', { name: /Show earlier/ })).toBeNull()
  })
})

describe('Transcript indicator', () => {
  it('a subagent thinking is not the session thinking', () => {
    render(<Transcript events={[ev('user', { text: 'x' }), ev('thinking', { text: '', agent: 'A' })]} />)
    expect(screen.queryByText('Thinking…')).toBeNull()
  })
})

const ask = (o: Partial<Ask> = {}): Ask => ({ askId: 'q1', kind: 'permission', tool: 'Bash', summary: 'rm -rf build', detail: '{}', questions: null, ...o })

describe('asks while a subagent screen is open', () => {
  it('an ask that arrives is shown on the screen and can be answered there, in the session colours', async () => {
    const onAskDone = vi.fn()
    const { rerender } = render(<Transcript sessionId="s" events={events()} />)
    fireEvent.click(screen.getByRole('button', { name: /audit reducer/ }))
    rerender(<Transcript sessionId="s" events={events()} asks={[ask({ agent: 'A' })]} onAskDone={onAskDone} />)
    const el = screen.getByTestId('agent-screen')
    const asks = within(el).getByTestId('agent-asks')
    expect(within(asks).getByText('rm -rf build')).toBeTruthy()
    // the asks sit outside the violet part
    expect(within(el).getByTestId('agent-accent').contains(asks)).toBe(false)
    expect(within(el).getAllByText('Needs your answer').length).toBeGreaterThan(0)
    fireEvent.click(within(asks).getByRole('button', { name: /Allow/ }))
    await waitFor(() => expect(decide).toHaveBeenCalledWith('s', expect.objectContaining({ askId: 'q1', decision: 'allow' })))
  })
  it('the asks stay pinned on a nested screen too', () => {
    render(<Transcript sessionId="s" events={events()} asks={[ask({ agent: 'N' })]} />)
    fireEvent.click(screen.getByRole('button', { name: /audit reducer/ }))
    let s = within(screen.getByTestId('agent-screen'))
    // the parent shows that something inside it waits
    expect(s.getAllByText('Needs your answer').length).toBeGreaterThan(0)
    fireEvent.click(s.getByRole('button', { name: /dig deeper/ }))
    s = within(screen.getByTestId('agent-screen'))
    expect(within(s.getByTestId('agent-asks')).getByText('rm -rf build')).toBeTruthy()
  })
  it('the card says which subagent waits; a main-conversation ask marks none; an older mod\'s ask marks the working ones', () => {
    const { rerender } = render(<Transcript events={events()} asks={[ask({ agent: 'C' })]} />)
    expect(screen.getByText('1 need your answer · 1 running · 1 done')).toBeTruthy()
    rerender(<Transcript events={events()} asks={[ask({ agent: '' })]} />)
    expect(screen.queryByText(/need your answer/)).toBeNull()
    rerender(<Transcript events={events()} asks={[ask()]} />)
    expect(screen.getByText('2 need your answer · 1 done')).toBeTruthy()
  })
})

describe('stable subagent screens', () => {
  it('a card tapped before its agent_start keeps its screen open and fills in', () => {
    const first = [ev('user', { text: 'go' }), call('t9', 'early')]
    const { rerender } = render(<Transcript events={first} />)
    fireEvent.click(screen.getByRole('button', { name: /early/ }))
    expect(within(screen.getByTestId('agent-screen')).getByText('Nothing from this subagent yet.')).toBeTruthy()
    rerender(<Transcript events={[...first, ev('agent_start', { id: 'E', type: 'Explore', description: 'early', tool: 't9' }), ...bash('e1', 'make early', 'E')]} />)
    expect(within(screen.getByTestId('agent-screen')).getByText('make early')).toBeTruthy()
  })
  it('a screen whose subagent left the timeline closes', () => {
    const { rerender } = render(<Transcript events={events()} />)
    fireEvent.click(screen.getByRole('button', { name: /audit hub/ }))
    expect(screen.getByTestId('agent-screen')).toBeTruthy()
    rerender(<Transcript events={[ev('user', { text: 'new page' })]} />)
    expect(screen.queryByTestId('agent-screen')).toBeNull()
  })
  it('a nested subagent tagged only by its parent (no call id) is a card inside the parent', () => {
    const evs = [call('t1', 'parent'), ev('agent_start', { id: 'P', type: 'x', description: 'parent', tool: 't1' }),
      ev('agent_start', { id: 'K', type: 'Plan', description: 'only tagged', agent: 'P' }), ...bash('k1', 'make kid', 'K')]
    render(<Transcript events={evs} />)
    expect(screen.queryByText('only tagged')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /parent/ }))
    fireEvent.click(within(screen.getByTestId('agent-screen')).getByRole('button', { name: /only tagged/ }))
    expect(within(screen.getByTestId('agent-screen')).getByText('make kid')).toBeTruthy()
  })
  it('a subagent still working stays in view when a compact folds the conversation', () => {
    render(<Transcript events={[ev('user', { text: 'old' }), call('t1', 'long job'), ev('agent_start', { id: 'L', type: 'x', description: 'long job', tool: 't1' }),
      ev('compact', { at: 1, trigger: 'auto' }), ev('assistant', { text: 'after' })]} />)
    expect(screen.getByRole('button', { name: /Earlier conversation/ })).toBeTruthy()
    expect(screen.queryByText('old')).toBeNull()
    expect(screen.getByRole('button', { name: /long job/ })).toBeTruthy()
  })
})
