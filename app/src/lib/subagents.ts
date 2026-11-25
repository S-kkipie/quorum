import { itemKey, type AgentGroupItem, type AgentItem, type Item } from './timeline'

// The session view's split of a timeline: the main conversation, and each subagent's own items.
// Kept out of timeline.ts so it only ships with the session screen.

/** A transcript row: a timeline item, or subagents launched together. */
export type Shown = Item | AgentGroupItem

/** Agent calls at most this far apart (ms) that follow each other form one group card. */
export const GROUP_MS = 10_000

/** The row key of a shown item: a group keeps its first agent's key, so a card that becomes a group keeps its row. */
export const shownKey = (r: Shown): string => (r.t === 'agents' ? itemKey(r.agents[0]) : itemKey(r))

/** What partitionTimeline answers. */
export type SessionTimeline = {
  /** the main conversation: no item of a subagent, consecutive Agent calls grouped */
  main: Shown[]
  /** each subagent's own items (its prompt is on its AgentItem), in order, its own subagents grouped */
  byAgent: Map<string, Shown[]>
  /** every subagent by id */
  agents: Map<string, AgentItem>
  /** the key of a subagent's item → the key of the main row (its top-level card) that holds it */
  owner: Map<string, string>
}

const agentOf = (it: Item): string | undefined => ('agent' in it ? it.agent : undefined) || undefined

/** Consecutive AgentItems no more than GROUP_MS apart become one group. */
function group(items: Item[]): Shown[] {
  const out: Shown[] = []
  let run: AgentItem[] = []
  const flush = () => {
    if (run.length === 1) out.push(run[0])
    else if (run.length > 1) out.push({ t: 'agents', seq: run[0].seq, agents: run })
    run = []
  }
  for (const it of items) {
    if (it.t === 'agent') {
      const prev = run[run.length - 1]
      const near = !prev || !prev.startedAt || !it.startedAt || Math.abs(it.startedAt - prev.startedAt) <= GROUP_MS
      if (!near) flush()
      run.push(it)
      continue
    }
    flush()
    out.push(it)
  }
  flush()
  return out
}

/**
 * Splits a timeline into the main conversation and each subagent's own items (by their `agent`):
 * the main transcript shows a subagent only as its card. A subagent's items without a card (its
 * agent_start was not seen) get one where they start. Sets each AgentItem's steps and last tool.
 */
export function partitionTimeline(items: Item[]): SessionTimeline {
  const agents = new Map<string, AgentItem>()
  for (const it of items) if (it.t === 'agent') agents.set(it.id, it)
  const lists = new Map<string, Item[]>()
  const made = new Set<AgentItem>()
  const main: Item[] = []
  for (const it of items) {
    const a = agentOf(it)
    if (a && !agents.has(a)) {
      // its card: where its first item is, running while one of its tools runs (fixed below)
      const card: AgentItem = { t: 'agent', seq: it.seq, id: a, type: '', description: 'Subagent', status: 'completed' }
      agents.set(a, card)
      made.add(card)
      main.push(card)
    }
    if (a) {
      const l = lists.get(a) ?? []
      l.push(it)
      lists.set(a, l)
    } else main.push(it)
  }
  for (const [id, a] of agents) {
    const l = lists.get(id) ?? []
    let steps = 0
    let last: string | undefined
    let running = false
    for (const it of l) {
      if (it.t === 'tool') { steps++; last = it.title; running ||= it.state === 'running' }
      else if (it.t === 'reads') { steps += it.tools.length; last = it.title; running ||= it.state === 'running' }
      else if (it.t === 'agent') { steps++; last = it.description ? `Subagent: ${it.description}` : 'Subagent' }
    }
    a.steps = steps
    if (last) a.lastTool = last
    if (made.has(a) && running) a.status = 'running'
  }
  const byAgent = new Map<string, Shown[]>()
  for (const [id, l] of lists) byAgent.set(id, group(l))
  const shownMain = group(main)
  // the main row that holds each subagent, then every item of each subagent, nested ones included
  const cardOf = new Map<string, string>()
  for (const r of shownMain) {
    if (r.t === 'agent') cardOf.set(r.id, shownKey(r))
    else if (r.t === 'agents') for (const a of r.agents) cardOf.set(a.id, shownKey(r))
  }
  const top = (id: string): string | undefined => {
    const seen = new Set<string>()
    let cur: string | undefined = id
    while (cur && !seen.has(cur)) {
      if (cardOf.has(cur)) return cardOf.get(cur)
      seen.add(cur)
      cur = agents.get(cur)?.agent
    }
    return undefined
  }
  const owner = new Map<string, string>()
  for (const [id, l] of lists) {
    const k = top(id)
    if (k) for (const it of l) owner.set(itemKey(it), k)
  }
  return { main: shownMain, byAgent, agents, owner }
}
