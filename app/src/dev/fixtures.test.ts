import { describe, expect, it } from 'vitest'
import { buildTimeline } from '../lib/timeline'
import { fixtureBriefing, fixtureConversations, fixtureEvents, fixtureHistory, fixtureState, LONG_SESSION, TOOL_OUTPUT_MAX } from './fixtures'
import type { Event } from '../proto.gen'

const convKey = (m: string, r: string) => m + '\u0000' + r

describe('worst', () => {
  const s = fixtureState('worst')
  const sessions = Object.values(s.sessions)
  it('has long names, every state, an offline machine', () => {
    expect(Object.keys(s.workspaces).length).toBeGreaterThanOrEqual(3)
    expect(Object.values(s.projects).some((p) => p.name.length === 120)).toBe(true)
    expect(sessions.some((x) => (x.recap || x.name).length === 200)).toBe(true)
    expect(sessions.some((x) => (x.recap || x.name).length === 1)).toBe(true)
    for (const st of ['working', 'needs_you', 'background', 'idle', 'closed']) expect(sessions.some((x) => x.state === st)).toBe(true)
    expect(Object.values(s.machines).some((m) => !m.online)).toBe(true)
  })
  it('every session has a context percentage', () => {
    for (const x of sessions) expect(Number.isFinite(x.contextPct)).toBe(true)
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

describe('slash commands, model and effort', () => {
  it('worst: commands of every group, terminal-only rows, long names and descriptions', () => {
    const s = fixtureState('worst')
    const open = Object.values(s.sessions).filter((x) => x.state !== 'closed')
    const sc = s.commands[open[0].id]
    expect(sc?.hash).toBeTruthy()
    const groups = new Set(sc.commands.map((c) => c.group))
    for (const g of ['session', 'skill', 'plugin', 'mcp']) expect(groups.has(g)).toBe(true)
    expect(sc.commands.some((c) => c.terminalOnly)).toBe(true)
    expect(sc.commands.some((c) => c.name.length >= 60)).toBe(true)
    expect(sc.commands.some((c) => c.description.length >= 200)).toBe(true)
    expect(open[0].modelOptions.length).toBeGreaterThanOrEqual(3)
    expect(open[0].effortOptions.length).toBe(5)
    expect(open[0].effort).toBeTruthy()
  })
  it('worst: command cards in every status', () => {
    const s = fixtureState('worst')
    const evs = Object.values(s.events).flat().filter((e) => e.kind === 'command')
    for (const st of ['queued', 'done', 'failed']) expect(evs.some((e) => e.data.status === st)).toBe(true)
    expect(evs.some((e) => typeof e.data.text === 'string' && e.data.text.split('\n').length > 6)).toBe(true)
  })
  it('huge: 120+ commands; one: an older mod with no list and no options', () => {
    const h = fixtureState('huge')
    const first = h.order[0]
    expect(h.commands[first].commands.length).toBeGreaterThanOrEqual(120)
    const one = fixtureState('one')
    const x = Object.values(one.sessions)[0]
    expect(one.commands[x.id]).toBeUndefined()
    expect(x.modelOptions).toEqual([])
  })
})

describe('huge: a long session with history on its machine', () => {
  it('has 1,500 events across hub and machine pages, with 3 compacts', async () => {
    const s = fixtureState('huge')
    const inMemory = s.events[LONG_SESSION]
    expect(inMemory).toHaveLength(1000)
    const page = fixtureHistory('huge')
    const machine: Event[] = []
    let p = await page(LONG_SESSION, '')
    expect(p.events).toHaveLength(0)
    expect(p.done).toBe(false)
    while (!p.done) { p = await page(LONG_SESSION, p.cursor); machine.unshift(...p.events) }
    expect(machine).toHaveLength(500)
    expect(new Set(machine.map((e) => e.key)).size).toBe(500)
    const all = [...machine, ...inMemory]
    expect(all).toHaveLength(1500)
    expect(all.filter((e) => e.kind === 'compact')).toHaveLength(3)
    // ordered: machine history is older than the hub's oldest event
    expect(machine[machine.length - 1].ts).toBeLessThan(inMemory[0].ts)
    const hubPage = await fixtureEvents('huge')(LONG_SESSION, 951, 50)
    expect(hubPage.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 950 - i))
  })
})

describe('background fixtures (Plan 10)', () => {
  for (const mode of ['worst', 'one'] as const) {
    it(`${mode}: items, a running background row and task ends of every status`, () => {
      const s = fixtureState(mode)
      const x = Object.values(s.sessions).find((v) => v.background.items?.length)!
      expect(x.state).toBe('background')
      if (mode === 'worst') expect(new Set(x.background.items!.map((i) => i.kind))).toEqual(new Set(['command', 'monitor', 'subagent', 'loop', 'cron']))
      if (mode === 'worst') expect(x.background.items!.some((i) => i.label.length > 200)).toBe(true)
      const items = buildTimeline(s.events[x.id]!, '')
      const rows = items.filter((i: any) => i.t === 'tool' && i.bg) as any[]
      expect(rows.some((r) => r.bg.status === undefined)).toBe(true)
      const ends = items.filter((i: any) => i.t === 'task_end') as any[]
      for (const st of ['completed', 'failed', 'killed', 'stopped']) expect(ends.some((e) => e.status === st)).toBe(true)
      expect(ends.some((e) => (e.outputTail ?? '').split('\n').length > 6)).toBe(true)
    })
  }
})

describe('briefing fixtures', () => {
  it('every mode answers a briefing with every list; empty has nothing, worst has an overdue ticket', async () => {
    for (const m of ['worst', 'empty', 'one', 'huge'] as const) {
      const b = await fixtureBriefing(m)('p1')
      for (const k of ['newSince', 'myTickets', 'pinned', 'sessions'] as const) expect(Array.isArray(b[k])).toBe(true)
    }
    const e = await fixtureBriefing('empty')('p1')
    expect(e.whereLeftOff).toBeNull()
    expect(e.myTickets).toHaveLength(0)
    const w = await fixtureBriefing('worst')('p1')
    expect(w.myTickets.some((t) => t.plannedEnd! < Date.now() - 86_400_000)).toBe(true)
    expect(w.pinned.some((n) => n.text.length === 500)).toBe(true)
  })
})
