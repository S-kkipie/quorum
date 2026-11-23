import type { Ask, Checkout, Envelope, Event, Project, Proposal, SessionInfo, SessionTicket, Ticket, Workspace } from '../proto.gen'
import type { Machine, TicketView } from './api'

export interface AppState {
  machines: Record<string, Machine>
  sessions: Record<string, SessionInfo>
  /** Stable session order: new ones at the end; never reordered by state. */
  order: string[]
  /** Events per session, sorted by ascending seq and without duplicates. */
  events: Record<string, Event[]>
  /** Streaming text of the main thread per session. */
  live: Record<string, string>
  /** Streaming text of subagents: liveAgent[session][agent]. Cleared on agent_end. */
  liveAgent: Record<string, Record<string, string>>
  asks: Record<string, AskEntry>
  /** Ids replaced via previousId; seed() never resurrects them. */
  replaced: Record<string, true>
  /** prev -> new id, so the open view follows the replaced session. */
  replacedBy: Record<string, string>
  workspaces: Record<string, Workspace>
  projects: Record<string, Project>
  /** Tickets per project, in hub order (most recently updated first). */
  tickets: Record<string, Ticket[]>
  /** Session-ticket links: links[ticket][session] = confirmed (false = suggestion). */
  links: Record<string, Record<string, boolean>>
  proposals: Record<string, Proposal>
  /** Checkouts saved in the hub per project (GET /api/projects/{id}/checkouts). */
  checkouts: Record<string, Checkout[]>
  /** Sessions seen working since the app opened (for "done, waiting for your review"). */
  worked: Record<string, true>
}

/** Ask with the session it belongs to. */
export type AskEntry = Ask & { session: string }

export const initialState = (): AppState => ({
  machines: {}, sessions: {}, order: [], events: {}, live: {}, liveAgent: {}, asks: {}, replaced: {}, replacedBy: {},
  workspaces: {}, projects: {}, tickets: {}, links: {}, proposals: {}, checkouts: {}, worked: {},
})

/** Inserts ev into the seq-sorted list, discarding duplicates. */
export function mergeEvents(list: Event[] | undefined, incoming: Event[]): Event[] {
  const last = list?.[list.length - 1]
  if (list && incoming.length === 1 && last && incoming[0].seq > last.seq) return [...list, incoming[0]]
  const bySeq = new Map<number, Event>()
  for (const e of list ?? []) bySeq.set(e.seq, e)
  for (const e of incoming) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function omit<T>(o: Record<string, T>, k: string): Record<string, T> {
  const { [k]: _, ...rest } = o
  return rest
}

function onEvent(s: AppState, ev: Event): AppState {
  const id = ev.session
  const d = ev.data ?? {}
  let merged = mergeEvents(s.events[id], [ev])
  if (merged[0]?.seq < 0 && ev.seq > 0) merged = dropBackfillDuplicates(merged)
  const base: AppState = { ...s, events: { ...s.events, [id]: merged } }
  switch (ev.kind) {
    case 'assistant_delta': {
      const text: string = d.text ?? ''
      if (d.agent) {
        const cur = s.liveAgent[id] ?? {}
        return { ...s, liveAgent: { ...s.liveAgent, [id]: { ...cur, [d.agent]: (cur[d.agent] ?? '') + text } } }
      }
      return { ...s, live: { ...s.live, [id]: (s.live[id] ?? '') + text } }
    }
    case 'assistant':
      // a subagent's final message does not cut the main thread's streaming
      return d.agent ? base : { ...base, live: omit(s.live, id) }
    case 'agent_end': {
      const cur = s.liveAgent[id]
      if (!cur || !(d.id in cur)) return base
      return { ...base, liveAgent: { ...s.liveAgent, [id]: omit(cur, d.id) } }
    }
    case 'ask':
      return d.askId ? { ...base, asks: { ...s.asks, [d.askId]: { ...(d as Ask), session: id } } } : base
    case 'ask_resolved':
      return { ...base, asks: omit(s.asks, d.askId) }
    default:
      return base
  }
}

export function reduce(s: AppState, env: Envelope): AppState {
  switch (env.type) {
    case 'machine_status': {
      const m = env.payload as Machine
      return m?.name ? { ...s, machines: { ...s.machines, [m.name]: m } } : s
    }
    case 'session_upsert': {
      const info = env.payload as SessionInfo
      if (!info?.id) return s
      let order = s.order
      let sessions = s.sessions
      let events = s.events
      let live = s.live
      let liveAgent = s.liveAgent
      let replaced = s.replaced
      let replacedBy = s.replacedBy
      let asks = s.asks
      let prev = info.previousId
      // A previousId whose id is still alive next to the new id is an old rename
      // (e.g. `claude --resume A` after /clear A→B): both sessions live separately.
      const alive = (id: string) => !!sessions[id] && sessions[id].state !== 'closed'
      if (prev && alive(prev) && alive(info.id)) prev = ''
      // This id is alive: it stops being listed as replaced (and an A→B→A cycle is broken).
      if (replaced[info.id]) replaced = omit(replaced, info.id)
      if (replacedBy[info.id] !== undefined) replacedBy = omit(replacedBy, info.id)
      if (prev && prev !== info.id) {
        // Recorded even if prev is not in the state (the app was disconnected
        // during the /clear): the view open on prev follows the new id.
        if (!replaced[prev]) replaced = { ...replaced, [prev]: true }
        if (replacedBy[prev] !== info.id) replacedBy = { ...replacedBy, [prev]: info.id }
        if (sessions[prev]) sessions = omit(sessions, prev)
        if (Object.values(asks).some((a) => a.session === prev)) {
          asks = Object.fromEntries(Object.entries(asks).map(([k, a]) => [k, a.session === prev ? { ...a, session: info.id } : a]))
        }
        if (!order.includes(prev)) {
          if (!order.includes(info.id)) order = [...order, info.id]
        } else if (order.includes(info.id)) order = order.filter((x) => x !== prev)
        else order = order.map((x) => (x === prev ? info.id : x))
        if (events[prev]) {
          events = { ...omit(events, prev), [info.id]: mergeEvents(events[info.id], events[prev].map((e) => ({ ...e, session: info.id }))) }
        }
        if (live[prev] !== undefined) live = { ...omit(live, prev), [info.id]: live[prev] }
        if (liveAgent[prev]) liveAgent = { ...omit(liveAgent, prev), [info.id]: liveAgent[prev] }
      } else if (!order.includes(info.id)) {
        order = [...order, info.id]
      }
      let worked = s.worked
      if (info.state === 'working' && !worked[info.id]) worked = { ...worked, [info.id]: true }
      if (prev && worked[prev] && !worked[info.id]) worked = { ...worked, [info.id]: true }
      return { ...s, sessions: { ...sessions, [info.id]: { ...info, previousId: prev } }, order, events, live, liveAgent, replaced, replacedBy, asks, worked }
    }
    case 'session_gone': {
      const cur = s.sessions[env.session]
      if (!cur) return s
      return { ...s, sessions: { ...s.sessions, [cur.id]: { ...cur, state: 'closed' } }, live: omit(s.live, cur.id) }
    }
    case 'event':
      return env.payload?.session ? onEvent(s, env.payload as Event) : s
    case 'events':
      // backfilled history of a session, in a single envelope
      return env.session && Array.isArray(env.payload) ? addEvents(s, env.session, env.payload as Event[]) : s
    case 'workspace_upsert': {
      const w = env.payload as Workspace
      return w?.id ? { ...s, workspaces: { ...s.workspaces, [w.id]: w } } : s
    }
    case 'workspace_gone':
      return env.payload?.id ? { ...s, workspaces: omit(s.workspaces, env.payload.id) } : s
    case 'project_upsert': {
      const p = env.payload as Project
      return p?.id ? { ...s, projects: { ...s.projects, [p.id]: p } } : s
    }
    case 'project_gone': {
      const id = env.payload?.id
      if (!id) return s
      // the links and proposals of its tickets go too
      const gone = new Set((s.tickets[id] ?? []).map((t) => t.id))
      const links = Object.fromEntries(Object.entries(s.links).filter(([tid]) => !gone.has(tid)))
      const proposals = Object.fromEntries(Object.entries(s.proposals).filter(([, p]) => !gone.has(p.ticketId)))
      return { ...s, projects: omit(s.projects, id), tickets: omit(s.tickets, id), checkouts: omit(s.checkouts, id), links, proposals }
    }
    case 'tickets': {
      const { projectId, tickets } = env.payload ?? {}
      return projectId && Array.isArray(tickets) ? { ...s, tickets: { ...s.tickets, [projectId]: tickets } } : s
    }
    case 'session_ticket':
      return env.payload?.sessionId && env.payload?.ticketId ? setLink(s, env.payload as SessionTicket) : s
    case 'proposal_upsert': {
      const p = env.payload as Proposal
      return p?.id ? { ...s, proposals: { ...s.proposals, [p.id]: p } } : s
    }
    default:
      return s // hello, launch_result and unknown types are ignored
  }
}

const evKey = (e: Event) => {
  const d = e.data ?? {}
  return e.kind + '\u0000' + String(d.text ?? d.answer ?? d.id ?? '')
}

/**
 * Removes from the history backfilled from the transcript (negative seq) what already
 * arrived live (positive seq) while the backfill was requested: everything after the first
 * live event, and anything identical (kind and text) up to 2 s before.
 */
export function dropBackfillDuplicates(list: Event[]): Event[] {
  let first = Infinity
  const liveKeys = new Set<string>()
  for (const e of list) {
    if (e.seq > 0) {
      if (e.ts < first) first = e.ts
      liveKeys.add(evKey(e))
    }
  }
  if (first === Infinity) return list
  const out = list.filter((e) => e.seq > 0 || (e.ts < first && !(e.ts >= first - 2000 && liveKeys.has(evKey(e)))))
  return out.length === list.length ? list : out
}

/** Merges historical events (backfill/pagination) into the state. */
export function addEvents(s: AppState, session: string, evs: Event[]): AppState {
  return { ...s, events: { ...s.events, [session]: dropBackfillDuplicates(mergeEvents(s.events[session], evs)) } }
}

/**
 * Seeds the state with the initial REST load: only inserts machines and sessions
 * that do not exist yet (never overwrites fresher WS data nor resurrects ids
 * replaced via previousId).
 */
export function seed(s: AppState, machines: Machine[], sessions: SessionInfo[]): AppState {
  const ms = { ...s.machines }
  for (const m of machines) if (!(m.name in ms)) ms[m.name] = m
  const ss = { ...s.sessions }
  let order = s.order
  for (const x of sessions) {
    if (x.id in ss || s.replaced[x.id]) continue
    ss[x.id] = x
    order = [...order, x.id]
  }
  return { ...s, machines: ms, sessions: ss, order }
}

/**
 * Replaces machines and sessions with the REST list (after reconnecting the live feed:
 * what changed while the app was disconnected, including /clear via
 * previousId). Unlike seed it does overwrite and removes what no longer exists; events are kept.
 */
export function replaceSessions(s: AppState, machines: Machine[], sessions: SessionInfo[]): AppState {
  const ids = new Set(sessions.map((x) => x.id))
  // a previousId that is also in the list is an old rename: not applied
  sessions = sessions.map((x) => (x.previousId && ids.has(x.previousId) ? { ...x, previousId: '' } : x))
  const prevs = new Set(sessions.map((x) => x.previousId).filter(Boolean))
  // prevs stay in order so the rename keeps its position
  let st: AppState = {
    ...s,
    machines: Object.fromEntries(machines.map((m) => [m.name, m])),
    sessions: {},
    order: s.order.filter((id) => ids.has(id) || prevs.has(id)),
  }
  for (const x of sessions) st = reduce(st, { type: 'session_upsert', machine: x.machine, session: x.id, payload: x })
  return { ...st, order: st.order.filter((id) => id in st.sessions) }
}

function setLink(s: AppState, l: SessionTicket): AppState {
  const cur = s.links[l.ticketId] ?? {}
  if (l.removed) {
    if (!(l.sessionId in cur)) return s
    return { ...s, links: { ...s.links, [l.ticketId]: omit(cur, l.sessionId) } }
  }
  let links = { ...s.links, [l.ticketId]: { ...cur, [l.sessionId]: !!l.confirmed } }
  // A session works on a single confirmed ticket at a time: the hub demotes the others.
  if (l.confirmed) {
    for (const [tid, m] of Object.entries(links)) {
      if (tid !== l.ticketId && m[l.sessionId]) links = { ...links, [tid]: { ...m, [l.sessionId]: false } }
    }
  }
  return { ...s, links }
}

/**
 * REST load of workspaces, projects and proposals. With replace (on reconnect) the REST
 * list wins; otherwise it only adds what the live feed has not brought yet.
 */
export function setProjectsData(s: AppState, d: { workspaces: Workspace[]; projects: Project[]; proposals?: Proposal[] }, replace = false): AppState {
  const byId = <T extends { id: string }>(xs: T[], cur: Record<string, T>) =>
    replace ? Object.fromEntries(xs.map((x) => [x.id, x])) : { ...Object.fromEntries(xs.map((x) => [x.id, x])), ...cur }
  const projects = byId(d.projects, s.projects)
  const tickets = replace ? Object.fromEntries(Object.entries(s.tickets).filter(([k]) => k in projects)) : s.tickets
  return {
    ...s,
    workspaces: byId(d.workspaces, s.workspaces),
    projects,
    tickets,
    proposals: d.proposals ? byId(d.proposals, s.proposals) : s.proposals,
  }
}

/** Tickets of a project (REST) with their session links. */
export function setTickets(s: AppState, projectId: string, views: TicketView[]): AppState {
  const links = { ...s.links }
  const tickets: Ticket[] = []
  for (const { sessions, proposals: _, ...t } of views) {
    tickets.push(t)
    links[t.id] = Object.fromEntries((sessions ?? []).map((x) => [x.sessionId, x.confirmed]))
  }
  return { ...s, tickets: { ...s.tickets, [projectId]: tickets }, links }
}

/** Ticket detail (REST): the ticket, its links and its proposals. */
export function setTicketDetail(s: AppState, v: TicketView): AppState {
  const { sessions, proposals, ...t } = v
  const list = s.tickets[t.projectId] ?? []
  const i = list.findIndex((x) => x.id === t.id)
  const tl = i < 0 ? [...list, t] : list.map((x, j) => (j === i ? t : x))
  const ps = { ...s.proposals }
  for (const p of proposals ?? []) ps[p.id] = p
  return {
    ...s,
    tickets: { ...s.tickets, [t.projectId]: tl },
    links: { ...s.links, [t.id]: Object.fromEntries((sessions ?? []).map((x) => [x.sessionId, x.confirmed])) },
    proposals: ps,
  }
}

/** Saved checkouts of a project (REST). */
export function setCheckouts(s: AppState, projectId: string, cos: Checkout[]): AppState {
  return { ...s, checkouts: { ...s.checkouts, [projectId]: cos } }
}
