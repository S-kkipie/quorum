import type { AccountUsage, Ask, Attention, Checkout, Conversation, Envelope, Event, Project, Proposal, SessionCommands, SessionInfo, SessionTicket, Ticket, Workspace } from '../proto.gen'
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
  /** Conversations on disk per checkout, keyed machine + NUL + root. */
  conversations: Record<string, Conversation[]>
  /** Subscription usage per account key (accountKey, or machine/alias). */
  usage: Record<string, AccountUsage>
  /** Slash commands per session, as its mod reported them (absent: never reported, an older mod). */
  commands: Record<string, SessionCommands>
  /** Bumped by every live session_commands envelope: a GET that started before one must not overwrite it. */
  commandsRev: Record<string, number>
  /** Last attention the hub announced per session (needs_you or done), kept for native notifications. */
  lastAttention: Record<string, LastAttention>
}

export interface LastAttention { kind: 'needs_you' | 'done'; at: number }

/** Ask with the session it belongs to. */
export type AskEntry = Ask & { session: string }

export const initialState = (): AppState => ({
  machines: {}, sessions: {}, order: [], events: {}, live: {}, liveAgent: {}, asks: {}, replaced: {}, replacedBy: {},
  workspaces: {}, projects: {}, tickets: {}, links: {}, proposals: {}, checkouts: {}, worked: {}, conversations: {}, usage: {}, commands: {}, commandsRev: {}, lastAttention: {},
})

/** An event read from the machine's transcript (history page): no hub seq, identified by its key. */
export const isHistory = (e: Event): boolean => !e.seq

/** A live event and the same event read back from the transcript: at most this far apart (clocks differ). */
const SEAM_NEAR_MS = 5000
/** How many of the oldest hub events history is compared with at the seam. */
const SEAM_HUB = 200
const compactAt = (e: Event): number => (typeof e.data?.at === 'number' && e.data.at > 0 ? e.data.at : e.ts)
const clipSig = (v: unknown): string => (typeof v === 'string' ? [...v.trim()].slice(0, 200).join('') : '')

/**
 * What identifies an event's content on both sides of the seam: kind, text, tool name and summary,
 * task id ('' when it has none of them: never a duplicate). As the hub's eventSig.
 */
function eventSig(e: Event): string {
  const d = e.data ?? {}
  const text = clipSig(d.text)
  const name = typeof d.name === 'string' ? d.name : ''
  const summary = clipSig(d.summary)
  const task = typeof d.taskId === 'string' ? d.taskId : ''
  if (!text && !name && !summary && !task) return ''
  return `${e.kind}\0${text}\0${name}\0${summary}\0${task}`
}

/** Index of the first hub event (the list is history first, then the hub's events). */
function firstHub(list: readonly Event[]): number {
  let i = 0
  while (i < list.length && isHistory(list[i])) i++
  return i
}

/**
 * History (sorted by ts) without what the hub already holds: events at or after the oldest hub
 * event's ts, a compact within 5 s of a hub compact, and an event within 5 s of one of the oldest
 * hub events with the same kind and content. `hub` is the hub part of a list, from index `from`.
 */
function atSeam(hist: Event[], hub: readonly Event[], from = 0): Event[] {
  if (!hist.length || from >= hub.length) return hist
  const seam = hub[from].ts
  let out = hist[hist.length - 1].ts >= seam ? hist.filter((e) => e.ts < seam) : hist
  if (!out.length) return out
  if (out.some((e) => e.kind === 'compact')) {
    const hubCompacts: number[] = []
    for (let i = from; i < hub.length; i++) if (hub[i].kind === 'compact') hubCompacts.push(compactAt(hub[i]))
    if (hubCompacts.length) {
      const kept = out.filter((e) => e.kind !== 'compact' || !hubCompacts.some((t) => Math.abs(t - compactAt(e)) <= SEAM_NEAR_MS))
      if (kept.length !== out.length) out = kept
    }
  }
  const near = new Map<string, number[]>()
  let lo = Infinity
  for (let i = from; i < hub.length && i < from + SEAM_HUB; i++) {
    const h = hub[i]
    if (h.kind === 'compact') continue
    const sig = eventSig(h)
    if (!sig) continue
    const l = near.get(sig)
    if (l) l.push(h.ts); else near.set(sig, [h.ts])
    if (h.ts < lo) lo = h.ts
  }
  if (!near.size) return out
  // only the newest history events can be that close to the hub's oldest ones
  let i = out.length
  while (i > 0 && out[i - 1].ts >= lo - SEAM_NEAR_MS) i--
  if (i === out.length) return out
  const tail = out.slice(i).filter((e) => {
    if (e.kind === 'compact') return true
    const ts = near.get(eventSig(e))
    return !ts || !ts.some((t) => Math.abs(t - e.ts) <= SEAM_NEAR_MS)
  })
  return tail.length === out.length - i ? out : [...out.slice(0, i), ...tail]
}

/** Merges two ts-sorted runs; on equal ts the events of `a` go first. */
function mergeByTs(a: Event[], b: Event[]): Event[] {
  if (!b.length) return a
  if (!a.length) return b
  if (a[a.length - 1].ts <= b[0].ts) return [...a, ...b] // an older page: no merge needed
  const out: Event[] = new Array(a.length + b.length)
  let i = 0, j = 0, k = 0
  while (i < a.length && j < b.length) out[k++] = b[j].ts < a[i].ts ? b[j++] : a[i++]
  while (i < a.length) out[k++] = a[i++]
  while (j < b.length) out[k++] = b[j++]
  return out
}

/**
 * Merges events into a session's list, discarding duplicates. The list is machine history first
 * (events read from the transcript, deduped by key, oldest first by ts; a page keeps its own order
 * for equal ts; none at or after the oldest hub event's ts, which the hub already holds), then the
 * hub's events sorted by seq (backfill negative, live positive). A history event within 5 s of a
 * hub event with the same kind and content (a compact: of a hub compact) is the same event and is
 * dropped. Prepending a page of history only sorts the page; the rest is merged in linear time.
 */
export function mergeEvents(list: Event[] | undefined, incoming: Event[]): Event[] {
  const last = list?.[list.length - 1]
  if (list && incoming.length === 1 && last && last.seq && !isHistory(incoming[0]) && incoming[0].seq > last.seq) return [...list, incoming[0]]
  const cur = list ?? []
  const split = firstHub(cur)
  const newHist: Event[] = []
  const newHub: Event[] = []
  for (const e of incoming) if (isHistory(e)) newHist.push(e); else newHub.push(e)
  let hubList: Event[]
  if (newHub.length) {
    const bySeq = new Map<number, Event>()
    for (let i = split; i < cur.length; i++) bySeq.set(cur[i].seq, cur[i])
    for (const e of newHub) bySeq.set(e.seq, e)
    hubList = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  } else hubList = split ? cur.slice(split) : cur
  let hist = split ? cur.slice(0, split) : []
  if (newHist.length) {
    const keys = new Set<string>()
    for (const e of hist) if (e.key) keys.add(e.key)
    const add = newHist.filter((e) => !e.key || (!keys.has(e.key) && (keys.add(e.key), true)))
    // stable: equal ts keep the incoming page before what was already there (pages go older)
    if (add.length) hist = mergeByTs(add.sort((a, b) => a.ts - b.ts), hist)
  }
  hist = atSeam(hist, hubList)
  return hist.length ? [...hist, ...hubList] : hubList
}

/**
 * The events of a machine history page that merging it into list would actually add: not already
 * there by key (`keys`: the history keys in memory), and not what the hub already holds (the same
 * seam as mergeEvents). Pages that bring nothing but those are not "new".
 */
export function freshHistory(list: readonly Event[], page: readonly Event[], keys: ReadonlySet<string>): Event[] {
  const add = page.filter((e) => !e.key || !keys.has(e.key)).sort((a, b) => a.ts - b.ts)
  return atSeam(add, list, firstHub(list))
}

/** Oldest hub seq in the list (history events have none), the `before` of the next hub page. */
export function oldestHubSeq(list: Event[]): number | undefined {
  for (const e of list) if (!isHistory(e)) return e.seq
  return undefined
}

/** Newest live seq (0 when there is none): the `after` of a delta sync. */
export function maxSeq(list: Event[]): number {
  const e = list[list.length - 1]
  return e && e.seq > 0 ? e.seq : 0
}

/** The newest hole in the live seqs (the hub numbers each session 1, 2, 3…): after < missing < next. */
export function newestGap(list: Event[]): { after: number; next: number } | null {
  for (let i = list.length - 1; i > 0; i--) {
    const a = list[i - 1]
    const b = list[i]
    if (a.seq <= 0) return null
    if (b.seq - a.seq > 1) return { after: a.seq, next: b.seq }
  }
  return null
}

/**
 * Drops events of a session from memory (they can be read again from the cache, hub or machine):
 * `below` keeps only events with seq >= below (history and older hub events go), `max` keeps the
 * newest max events, `keepOldest` the oldest ones (the reader is far up: the newest go).
 */
export function trimEvents(s: AppState, id: string, o: { max?: number; below?: number; keepOldest?: number }): AppState {
  const cur = s.events[id]
  if (!cur) return s
  let l = cur
  if (o.below !== undefined) { const b = o.below; l = l.filter((e) => !isHistory(e) && e.seq >= b) }
  if (o.max !== undefined && l.length > o.max) l = l.slice(l.length - o.max)
  if (o.keepOldest !== undefined && l.length > o.keepOldest) l = l.slice(0, o.keepOldest)
  return l.length === cur.length ? s : { ...s, events: { ...s.events, [id]: l } }
}

/** A session not open for this long keeps only its newest page in memory. */
export const IDLE_EVICT_MS = 2 * 60_000
export const KEEP_IDLE = 50

/** Sessions other than the open one, not viewed for IDLE_EVICT_MS (or never), holding more than a page. */
export function idleSessions(s: AppState, openId: string | null, lastViewed: Record<string, number>, now: number, idleMs = IDLE_EVICT_MS, keep = KEEP_IDLE): string[] {
  return Object.keys(s.events).filter((id) => id !== openId && s.events[id].length > keep && (lastViewed[id] ?? 0) <= now - idleMs)
}

/** Keeps only the newest page of each given session. */
export function evictEvents(s: AppState, ids: string[], keep = KEEP_IDLE): AppState {
  let out = s
  for (const id of ids) out = trimEvents(out, id, { max: keep })
  return out
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

/** Merges usage reports, keeping the newest `at` per key; `replace` also drops keys absent from the list. */
export function setUsage(s: AppState, list: AccountUsage[], replace = false): AppState {
  const usage = replace ? {} as Record<string, AccountUsage> : { ...s.usage }
  for (const u of list) {
    const cur = usage[u.key] ?? s.usage[u.key]
    if (!cur || u.at >= cur.at) usage[u.key] = u
    else usage[u.key] = cur
  }
  return { ...s, usage }
}

/** Stores a session's command list from a live envelope; an unchanged hash keeps the state. */
export function setCommands(s: AppState, sc: SessionCommands | null | undefined): AppState {
  if (!sc?.session || !Array.isArray(sc.commands)) return s
  const rev = { ...s.commandsRev, [sc.session]: (s.commandsRev[sc.session] ?? 0) + 1 }
  const cur = s.commands[sc.session]
  if (cur && cur.hash === sc.hash) return { ...s, commandsRev: rev }
  return { ...s, commands: { ...s.commands, [sc.session]: sc }, commandsRev: rev }
}

/**
 * Stores the list a GET /commands returned. `rev` is `state.commandsRev[session]` read before the
 * request started: when a live envelope arrived meanwhile (the revision moved) the response is older
 * and dropped.
 */
export function loadCommands(s: AppState, sc: SessionCommands | null | undefined, rev: number | undefined): AppState {
  if (!sc?.session || !Array.isArray(sc.commands)) return s
  if ((s.commandsRev[sc.session] ?? 0) !== (rev ?? 0)) return s
  const cur = s.commands[sc.session]
  if (cur && cur.hash === sc.hash) return s
  return { ...s, commands: { ...s.commands, [sc.session]: sc } }
}

export function reduce(s: AppState, env: Envelope): AppState {
  switch (env.type) {
    case 'usage_gone': {
      const key = (env.payload as { key?: string } | null)?.key
      return key && key in s.usage ? { ...s, usage: omit(s.usage, key) } : s
    }
    case 'usage_upsert': {
      const u = env.payload as AccountUsage
      return u?.key ? setUsage(s, [u]) : s
    }
    case 'session_commands':
      return setCommands(s, env.payload as SessionCommands)
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
      return { ...s, sessions: { ...s.sessions, [cur.id]: { ...cur, state: 'closed', unread: false } }, live: omit(s.live, cur.id) }
    }
    case 'attention': {
      const a = env.payload as Attention | null
      if (!a?.session || (a.kind !== 'needs_you' && a.kind !== 'done')) return s
      return { ...s, lastAttention: { ...s.lastAttention, [a.session]: { kind: a.kind, at: a.at } } }
    }
    case 'session_removed': {
      // closed without ever receiving a prompt: the hub deleted it
      const id = env.session
      if (!id) return s
      return {
        ...s,
        sessions: omit(s.sessions, id),
        order: s.order.filter((x) => x !== id),
        events: omit(s.events, id),
        live: omit(s.live, id),
        liveAgent: omit(s.liveAgent, id),
        asks: Object.fromEntries(Object.entries(s.asks).filter(([, a]) => a.session !== id)),
        worked: omit(s.worked, id),
        lastAttention: omit(s.lastAttention, id),
        commands: omit(s.commands, id),
        commandsRev: omit(s.commandsRev, id),
        replaced: omit(s.replaced, id),
        replacedBy: omit(s.replacedBy, id),
      }
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

/**
 * Clears "unread" locally: once the app marked the session seen (the hub's upsert confirms it), and
 * for the view of the session the owner is looking at (open and visible), so a turn that ends in
 * front of them never flickers "unread" until the seen mark lands.
 */
export function markSeen(s: AppState, id: string): AppState {
  const x = s.sessions[id]
  return x?.unread ? { ...s, sessions: { ...s.sessions, [id]: { ...x, unread: false } } } : s
}

/** Merges historical events (backfill/pagination) into the state. */
export function addEvents(s: AppState, session: string, evs: Event[]): AppState {
  const merged = dropBackfillDuplicates(mergeEvents(s.events[session], evs))
  // asks: the live snapshot is not the only source; an unresolved ask in history is a pending card
  const resolved = new Set<string>()
  for (const e of merged) if (e.kind === 'ask_resolved' && e.data?.askId) resolved.add(e.data.askId)
  let asks = s.asks
  for (const e of evs) {
    const id: string | undefined = e.data?.askId
    if (!id) continue
    if (e.kind === 'ask_resolved') {
      if (id in asks) asks = omit(asks, id)
    } else if (e.kind === 'ask' && !resolved.has(id) && !(id in asks)) {
      asks = { ...asks, [id]: { ...(e.data as Ask), session } }
    }
  }
  return { ...s, events: { ...s.events, [session]: merged }, asks }
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

/** Caches the conversation list of a checkout (keyed machine + NUL + root). */
export function setConversations(s: AppState, machine: string, root: string, list: Conversation[]): AppState {
  return { ...s, conversations: { ...s.conversations, [machine + '\u0000' + root]: list } }
}
