import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../lib/timeline'
import { fixtureConversations, fixtureState, TOOL_OUTPUT_MAX } from './fixtures'

const convKey = (m: string, r: string) => m + '\u0000' + r

describe('worst', () => {
  const s = fixtureState('worst')
  const sessions = Object.values(s.sessions)
  it('has long names, every state, an offline machine', () => {
    expect(Object.keys(s.workspaces).length).toBeGreaterThanOrEqual(3)
    expect(Object.values(s.projects).some((p) => p.name.length === 120)).toBe(true)
    expect(sessions.some((x) => (x.recap || x.name).length === 200)).toBe(true)
    expect(sessions.some((x) => (x.recap || x.name).length === 1)).toBe(true)
    for (const st of ['working', 'needs_you', 'waiting', 'idle', 'closed']) expect(sessions.some((x) => x.state === st)).toBe(true)
    expect(Object.values(s.machines).some((m) => !m.online)).toBe(true)
  })
  it('has a long path, a 200-line code block, a max-size tool output', () => {
    const evs = Object.values(s.events).flat()
    const asst = evs.filter((e) => e.kind === 'assistant').map((e) => e.data.text as string)
    expect(asst.some((t) => /\S{300,}/.test(t))).toBe(true)
    expect(asst.some((t) => { const m = t.match(/```[\s\S]*?```/); return !!m && m[0].split('\n').length >= 200 })).toBe(true)
    expect(TOOL_OUTPUT_MAX).toBe(8000)
    expect(evs.some((e) => e.kind === 'tool_end' && e.data.output.length === TOOL_OUTPUT_MAX)).toBe(true)
  })
  it('renders every tool kind and an artifact in the timeline', () => {
    const sid = Object.keys(s.events)[0]
    const items = buildTimeline(s.events[sid], s.sessions[sid].root)
    const kinds = new Set(items.map((i) => (i.t === 'tool' ? i.kind : i.t)))
    for (const k of ['user', 'assistant', 'reads', 'edit', 'bash', 'web_search', 'skill', 'agent', 'artifact']) expect(kinds.has(k as any)).toBe(true)
  })
  it('lists 40 conversations per checkout', async () => {
    const co = Object.values(s.checkouts).flat()
    expect(co.length).toBeGreaterThan(0)
    const f = fixtureConversations('worst')
    for (const c of co) expect(await f(c.machine, c.root)).toHaveLength(40)
    expect(Object.keys(s.conversations)).toContain(convKey(co[0].machine, co[0].root))
  })
})

describe('empty', () => {
  const s = fixtureState('empty')
  it('has workspaces without projects and a project with nothing in it', () => {
    const used = new Set(Object.values(s.projects).map((p) => p.workspaceId))
    expect(Object.values(s.workspaces).some((w) => !used.has(w.id))).toBe(true)
    const p = Object.values(s.projects)[0]
    expect(p).toBeTruthy()
    expect(Object.values(s.sessions).filter((x) => x.projectId === p.id)).toHaveLength(0)
    expect(Object.values(s.conversations).flat()).toHaveLength(0)
  })
  it('conversation source is empty', async () => {
    expect(await fixtureConversations('empty')('vps-1', '/x')).toEqual([])
  })
})

describe('one', () => {
  const s = fixtureState('one')
  it('has exactly one of each', () => {
    expect(Object.keys(s.workspaces)).toHaveLength(1)
    expect(Object.keys(s.projects)).toHaveLength(1)
    expect(Object.keys(s.sessions)).toHaveLength(1)
    expect(Object.keys(s.machines)).toHaveLength(1)
    expect(Object.keys(s.proposals)).toHaveLength(1)
    expect(Object.values(s.checkouts).flat()).toHaveLength(1)
    expect(Object.values(s.conversations).flat()).toHaveLength(1)
  })
})

describe('huge', () => {
  const s = fixtureState('huge')
  it('has 1000 closed conversations in one project and 200 live sessions on 5 machines', () => {
    const convs = Object.values(s.conversations).flat()
    expect(convs.filter((c) => !c.open)).toHaveLength(1000)
    const live = Object.values(s.sessions).filter((x) => x.state !== 'closed')
    expect(live).toHaveLength(200)
    expect(new Set(live.map((x) => x.machine)).size).toBe(5)
  })
})

describe('privacy', () => {
  it('contains no IP addresses', () => {
    for (const m of ['worst', 'empty', 'one', 'huge'] as const) expect(JSON.stringify(fixtureState(m))).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
  })
})
