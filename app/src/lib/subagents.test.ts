import { describe, expect, it } from 'vitest'
import { buildTimeline, itemKey, type AgentGroupItem, type AgentItem } from './timeline'
import { askingAgents, GROUP_MS, partitionTimeline, shownKey, type Shown } from './subagents'
import type { Event } from '../proto.gen'

let n = 0
const T0 = 1_800_000_000_000
const ev = (kind: string, data: any, ts = T0 + n * 1000): Event => ({ seq: ++n, session: 's', ts, kind, data })
const call = (id: string, description: string, o: { agent?: string; type?: string; prompt?: string; ts?: number } = {}) =>
  ev('tool_start', { id, name: 'Agent', summary: '', agent: o.agent, input: { description, subagent_type: o.type ?? 'Explore', prompt: o.prompt ?? `Do: ${description}` } }, o.ts)
const done = (id: string, output = 'answer', agent?: string, extra: any = {}) => ev('tool_end', { id, ok: true, ms: 5, output, agent, ...extra })
const start = (agentId: string, tool: string | undefined, description: string, parent?: string) =>
  ev('agent_start', { id: agentId, type: 'Explore', description, ...(tool ? { tool } : {}), ...(parent ? { agent: parent } : {}) })
const tool = (id: string, name: string, input: any, agent?: string) => ev('tool_start', { id, name, summary: '', input, agent })
const tend = (id: string, agent?: string) => ev('tool_end', { id, ok: true, ms: 3, output: 'ok', agent })
const BASE = '/p'

const titles = (rows: Shown[]) => rows.map((r: any) => r.t === 'tool' || r.t === 'reads' ? r.title : r.t === 'agents' ? `group:${r.agents.length}` : r.t === 'agent' ? `agent:${r.description}` : `${r.t}:${r.text ?? ''}`)

describe('subagents in the timeline', () => {
  it('an Agent call and its agent_start/agent_end are one card with its task', () => {
    const items = buildTimeline([
      call('tu1', 'find callers', { prompt: 'Find every caller of reduce()' }),
      start('ag1', 'tu1', 'find callers'),
      ev('agent_end', { id: 'ag1', status: 'completed', answer: 'Three callers.' }),
      done('tu1', 'Three callers. {"totalTokens": 18400}'),
    ], BASE)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ t: 'agent', id: 'ag1', toolId: 'tu1', type: 'Explore', description: 'find callers', prompt: 'Find every caller of reduce()', status: 'completed', answer: 'Three callers.', tokens: 18400 })
    const a = items[0] as AgentItem
    expect(a.startedAt).toBeGreaterThan(0)
    expect(a.endedAt).toBeGreaterThan(a.startedAt!)
  })

  it('links an agent_start without a call id by its description', () => {
    const items = buildTimeline([call('tu1', 'one'), call('tu2', 'two'), start('ag2', undefined, 'two'), start('ag1', undefined, 'one')], BASE)
    expect(items.map((x: any) => [x.toolId, x.id])).toEqual([['tu1', 'ag1'], ['tu2', 'ag2']])
  })

  it('an Agent call from history (no agent_start) is a finished card with its result', () => {
    const items = buildTimeline([{ seq: 0, session: 's', ts: T0, kind: 'tool_start', data: { id: 'h1', name: 'Agent', summary: '', input: { description: 'old' } } }], BASE)
    expect(items[0]).toMatchObject({ t: 'agent', id: 'h1', status: 'completed' })
  })

  it('a failed Agent call fails its card', () => {
    const items = buildTimeline([call('tu1', 'x'), ev('tool_end', { id: 'tu1', ok: false, ms: 1, output: 'boom' })], BASE)
    expect(items[0]).toMatchObject({ t: 'agent', status: 'error', answer: 'boom' })
  })

  it('partition: the main transcript has no item of a subagent; each subagent gets exactly its items, in order', () => {
    const tl = partitionTimeline(buildTimeline([
      ev('user', { text: 'audit it' }),
      call('tu1', 'audit'),
      start('ag1', 'tu1', 'audit'),
      tool('s1', 'Bash', { command: 'ls' }, 'ag1'),
      ev('assistant', { text: 'main thinks', agent: undefined }),
      tend('s1', 'ag1'),
      tool('s2', 'Read', { file_path: '/p/a.ts' }, 'ag1'),
      tend('s2', 'ag1'),
      tool('s3', 'Grep', { pattern: 'TODO' }, 'ag1'),
      ev('assistant', { text: 'sub answer', agent: 'ag1' }),
      ev('agent_end', { id: 'ag1', status: 'completed', answer: 'sub answer' }),
      done('tu1'),
      ev('assistant', { text: 'all done' }),
    ], BASE))
    expect(titles(tl.main)).toEqual(['user:audit it', 'agent:audit', 'assistant:main thinks', 'assistant:all done'])
    expect(tl.main.some((r: any) => r.agent)).toBe(false)
    expect(titles(tl.byAgent.get('ag1')!)).toEqual(['ls', 'Read a.ts', 'Searched TODO', 'assistant:sub answer'])
    const card = tl.main[1] as AgentItem
    expect(card).toMatchObject({ steps: 3, lastTool: 'Searched TODO', status: 'completed' })
    // the inspector can jump to a subagent's item: its main row is the card
    expect(tl.owner.get(itemKey(tl.byAgent.get('ag1')![1] as any))).toBe(itemKey(card))
  })

  it('groups consecutive Agent calls launched together into one card', () => {
    const tl = partitionTimeline(buildTimeline([
      ev('user', { text: 'go' }),
      call('a', 'one'), call('b', 'two'), call('c', 'three'),
      start('A', 'a', 'one'), start('B', 'b', 'two'), start('C', 'c', 'three'),
      tool('x', 'Bash', { command: 'pwd' }, 'B'),
      ev('assistant', { text: 'then' }),
      call('d', 'alone'),
    ], BASE))
    expect(titles(tl.main)).toEqual(['user:go', 'group:3', 'assistant:then', 'agent:alone'])
    const g = tl.main[1] as AgentGroupItem
    expect(g.agents.map((a) => a.id)).toEqual(['A', 'B', 'C'])
    expect(g.agents[1].steps).toBe(1)
    // a group keeps the row key its first card had
    expect(shownKey(g)).toBe(itemKey(g.agents[0]))
  })

  it('Agent calls far apart in time are separate cards', () => {
    const tl = partitionTimeline(buildTimeline([call('a', 'one', { ts: T0 }), call('b', 'two', { ts: T0 + GROUP_MS + 1 })], BASE))
    expect(titles(tl.main)).toEqual(['agent:one', 'agent:two'])
  })

  it('a subagent spawned by a subagent is a card inside its parent, never in main', () => {
    const tl = partitionTimeline(buildTimeline([
      call('tu1', 'parent'),
      start('P', 'tu1', 'parent'),
      call('tu2', 'child', { agent: 'P' }),
      start('K', 'tu2', 'child', 'P'),
      tool('k1', 'Bash', { command: 'make' }, 'K'),
      tend('k1', 'K'),
      ev('agent_end', { id: 'K', status: 'completed', answer: 'built' }),
      done('tu2', 'built', 'P'),
    ], BASE))
    expect(titles(tl.main)).toEqual(['agent:parent'])
    expect(titles(tl.byAgent.get('P')!)).toEqual(['agent:child'])
    expect(titles(tl.byAgent.get('K')!)).toEqual(['make'])
    expect(tl.agents.get('K')).toMatchObject({ agent: 'P', status: 'completed', steps: 1 })
    expect(tl.agents.get('P')!.steps).toBe(1)
    expect(tl.owner.get(itemKey(tl.byAgent.get('K')![0] as any))).toBe(itemKey(tl.main[0] as any))
  })

  it('a nested agent_start from an older mod (no parent field) still joins its call inside the parent', () => {
    const tl = partitionTimeline(buildTimeline([call('tu1', 'parent'), start('P', undefined, 'parent'), call('tu2', 'child', { agent: 'P' }), start('K', undefined, 'child')], BASE))
    expect(titles(tl.main)).toEqual(['agent:parent'])
    expect(tl.agents.get('K')).toMatchObject({ toolId: 'tu2', agent: 'P' })
  })

  it('background subagents keep their launch and task_end state on the card; the task card stays in main', () => {
    const tl = partitionTimeline(buildTimeline([
      call('tu', 'Audit'),
      start('ag', 'tu', 'Audit'),
      done('tu', 'launched', undefined, { background: { taskId: 'ag' } }),
      tool('s1', 'Read', { file_path: '/p/x' }, 'ag'),
    ], BASE))
    expect(tl.main[0]).toMatchObject({ t: 'agent', id: 'ag', status: 'running', bg: { taskId: 'ag' } })
    const ended = partitionTimeline(buildTimeline([
      call('tu', 'Audit'),
      done('tu', 'launched', undefined, { background: { taskId: 'ag' } }),
      start('ag', undefined, 'Audit'),
      ev('task_end', { taskId: 'ag', kind: 'subagent', summary: 'Audit', status: 'completed' }),
    ], BASE))
    expect(titles(ended.main)).toEqual(['agent:Audit', 'task_end:'])
    expect(ended.main[0]).toMatchObject({ id: 'ag', toolId: 'tu', bg: { taskId: 'ag', status: 'completed' } })
  })

  it('items of a subagent whose start was not seen get a card where they begin', () => {
    const tl = partitionTimeline(buildTimeline([ev('user', { text: 'hi' }), tool('s1', 'Bash', { command: 'ls' }, 'ghost')], BASE))
    expect(titles(tl.main)).toEqual(['user:hi', 'agent:Subagent'])
    expect(tl.main[1]).toMatchObject({ id: 'ghost', status: 'running', steps: 1 })
    expect(titles(tl.byAgent.get('ghost')!)).toEqual(['ls'])
  })

  it('a card answers to its stable key, its agent id and its call id', () => {
    const tl = partitionTimeline(buildTimeline([call('tu1', 'x'), start('ag1', 'tu1', 'x'), done('tu1', 'launched', undefined, { background: { taskId: 'ag1' } })], BASE))
    const a = tl.agents.get('tu1')!
    expect(a.key).toBe('tu1')
    expect(tl.agents.get('ag1')).toBe(a)
    expect(tl.byAgent.get('tu1')).toBe(tl.byAgent.get('ag1'))
  })

  it('an agent_start naming a call that is not here is its own card (no guessing)', () => {
    const items = buildTimeline([call('tu1', 'same'), start('ag9', 'gone', 'same')], BASE)
    expect(items.map((x: any) => [x.key, x.id, x.status])).toEqual([['tu1', 'tu1', 'running'], ['ag9', 'ag9', 'running']])
  })

  it('an agent_start that no call started (tool \'\', a fork) is its own card', () => {
    const items = buildTimeline([call('tu1', 'same'), ev('agent_start', { id: 'f1', type: 'fork', description: 'same', tool: '' })], BASE)
    expect(items.map((x: any) => x.id)).toEqual(['tu1', 'f1'])
  })

  it('an older mod\'s agent_start links by description only when one call fits', () => {
    const items = buildTimeline([call('tu1', 'same'), call('tu2', 'same'), start('ag1', undefined, 'same')], BASE)
    expect(items.map((x: any) => x.id)).toEqual(['tu1', 'tu2', 'ag1'])
  })

  it('a nested agent_start never takes a main-level call', () => {
    const tl = partitionTimeline(buildTimeline([call('tu1', 'parent'), start('P', 'tu1', 'parent'), call('tu2', 'scan'), start('K', undefined, 'scan', 'P')], BASE))
    expect(tl.agents.get('tu2')!.id).toBe('tu2')
    expect(tl.agents.get('K')).toMatchObject({ key: 'K', agent: 'P' })
    expect(titles(tl.byAgent.get('P')!)).toEqual(['agent:scan'])
  })

  it('a linked call stays running at its tool_end until its agent_end, which sets the answer', () => {
    const evs = [call('tu1', 'x'), start('ag1', 'tu1', 'x'), done('tu1', 'partial result')]
    expect(buildTimeline(evs, BASE)[0]).toMatchObject({ status: 'running' })
    const ended = buildTimeline([...evs, ev('agent_end', { id: 'ag1', status: 'completed', answer: 'final' })], BASE)[0] as AgentItem
    expect(ended).toMatchObject({ status: 'completed', answer: 'final' })
    expect(ended.endedAt).toBeGreaterThan(0)
  })

  it('a launch message does not end the card', () => {
    const items = buildTimeline([call('tu1', 'x'), done('tu1', 'Async agent launched successfully. agentId: ag1')], BASE)
    expect(items[0]).toMatchObject({ status: 'running' })
    expect((items[0] as AgentItem).answer).toBeUndefined()
  })

  it('a file a subagent wrote is its artifact card, on its screen; the main group stays one card', () => {
    const tl = partitionTimeline(buildTimeline([
      call('a', 'one'), call('b', 'two'), start('A', 'a', 'one'), start('B', 'b', 'two'),
      tool('w', 'Write', { file_path: '/p/report.html', content: '<h1/>' }, 'A'), tend('w', 'A'),
    ], BASE))
    expect(titles(tl.main)).toEqual(['group:2'])
    expect(tl.byAgent.get('A')!.map((r) => r.t)).toEqual(['tool', 'artifact'])
    expect(tl.byAgent.get('A')![1]).toMatchObject({ t: 'artifact', name: 'report.html', agent: 'A' })
  })

  it('askingAgents: the asking subagent and the ones above it; \'\' is the main conversation; no field marks the working ones', () => {
    const tl = partitionTimeline(buildTimeline([
      call('tu1', 'parent'), start('P', 'tu1', 'parent'), call('tu2', 'kid', { agent: 'P' }), start('K', 'tu2', 'kid', 'P'),
      call('tu3', 'idle'), start('I', 'tu3', 'idle'), ev('agent_end', { id: 'I', status: 'completed' }),
    ], BASE))
    const live = (a: AgentItem) => a.status === 'running'
    expect([...askingAgents(tl, [{ agent: 'K' }], live)].sort()).toEqual(['tu1', 'tu2'])
    expect(askingAgents(tl, [{ agent: '' }], live).size).toBe(0)
    expect([...askingAgents(tl, [{}], live)].sort()).toEqual(['tu1', 'tu2'])
  })
})
