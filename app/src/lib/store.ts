import type { Ask, Checkout, Envelope, Event, Project, Proposal, SessionInfo, SessionTicket, Ticket, Workspace } from '../proto.gen'
import type { Machine, TicketView } from './api'

export interface AppState {
  machines: Record<string, Machine>
  sessions: Record<string, SessionInfo>
  /** Orden estable de sesiones: las nuevas al final; nunca se reordena por estado. */
  order: string[]
  /** Eventos por sesión, ordenados por seq ascendente y sin duplicados. */
  events: Record<string, Event[]>
  /** Texto en streaming del hilo principal por sesión. */
  live: Record<string, string>
  /** Texto en streaming de subagentes: liveAgent[sesión][agente]. Se limpia con agent_end. */
  liveAgent: Record<string, Record<string, string>>
  asks: Record<string, AskEntry>
  /** Ids reemplazados vía previousId; seed() nunca los resucita. */
  replaced: Record<string, true>
  /** prev -> id nuevo, para que la vista abierta siga a la sesión reemplazada. */
  replacedBy: Record<string, string>
  workspaces: Record<string, Workspace>
  projects: Record<string, Project>
  /** Tickets por proyecto, en el orden del hub (actualizados primero). */
  tickets: Record<string, Ticket[]>
  /** Vínculos sesión↔ticket: links[ticket][sesión] = confirmado (false = sugerencia). */
  links: Record<string, Record<string, boolean>>
  proposals: Record<string, Proposal>
  /** Checkouts guardados en el hub por proyecto (GET /api/projects/{id}/checkouts). */
  checkouts: Record<string, Checkout[]>
  /** Sesiones que se vieron trabajando desde que abrió la app (para "listo, esperando tu review"). */
  worked: Record<string, true>
}

/** Ask con la sesión a la que pertenece. */
export type AskEntry = Ask & { session: string }

export const initialState = (): AppState => ({
  machines: {}, sessions: {}, order: [], events: {}, live: {}, liveAgent: {}, asks: {}, replaced: {}, replacedBy: {},
  workspaces: {}, projects: {}, tickets: {}, links: {}, proposals: {}, checkouts: {}, worked: {},
})

/** Inserta ev en la lista ordenada por seq, descartando duplicados. */
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
      // el mensaje final de un subagente no corta el streaming del hilo principal
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
      // Un previousId cuyo id sigue vivo junto al id nuevo es un renombre viejo
      // (p. ej. `claude --resume A` tras /clear A→B): ambas sesiones viven por separado.
      const alive = (id: string) => !!sessions[id] && sessions[id].state !== 'closed'
      if (prev && alive(prev) && alive(info.id)) prev = ''
      // Este id está vivo: deja de figurar como reemplazado (y se rompe un ciclo A→B→A).
      if (replaced[info.id]) replaced = omit(replaced, info.id)
      if (replacedBy[info.id] !== undefined) replacedBy = omit(replacedBy, info.id)
      if (prev && prev !== info.id) {
        // Se registra aunque prev no esté en el estado (la app estaba desconectada
        // durante el /clear): la vista abierta en prev sigue al id nuevo.
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
      // historial rellenado de una sesión, en un solo envelope
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
      // se van también los vínculos y propuestas de sus tickets
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
      return s // hello, launch_result y desconocidos se ignoran
  }
}

const evKey = (e: Event) => {
  const d = e.data ?? {}
  return e.kind + '\u0000' + String(d.text ?? d.answer ?? d.id ?? '')
}

/**
 * Quita del historial rellenado desde el transcript (seq negativos) lo que ya llegó
 * en vivo (seq positivos) mientras se pedía el backfill: todo lo posterior al primer
 * evento en vivo, y lo igual (tipo y texto) hasta 2 s antes.
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

/** Fusiona eventos históricos (backfill/paginación) en el estado. */
export function addEvents(s: AppState, session: string, evs: Event[]): AppState {
  return { ...s, events: { ...s.events, [session]: dropBackfillDuplicates(mergeEvents(s.events[session], evs)) } }
}

/**
 * Siembra el estado con la carga REST inicial: solo inserta máquinas y sesiones
 * que aún no existen (nunca pisa datos más frescos del WS ni resucita ids
 * reemplazados por previousId).
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
 * Reemplaza máquinas y sesiones por la lista REST (tras reconectar el feed en vivo:
 * lo que cambió mientras la app estaba desconectada, incluidos los /clear vía
 * previousId). A diferencia de seed sí pisa y quita lo que ya no existe; los eventos se conservan.
 */
export function replaceSessions(s: AppState, machines: Machine[], sessions: SessionInfo[]): AppState {
  const ids = new Set(sessions.map((x) => x.id))
  // un previousId que también está en la lista es un renombre viejo: no se aplica
  sessions = sessions.map((x) => (x.previousId && ids.has(x.previousId) ? { ...x, previousId: '' } : x))
  const prevs = new Set(sessions.map((x) => x.previousId).filter(Boolean))
  // los prev se quedan en order para que el renombre conserve su posición
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
  // Una sesión trabaja un solo ticket confirmado a la vez: el hub rebaja los demás.
  if (l.confirmed) {
    for (const [tid, m] of Object.entries(links)) {
      if (tid !== l.ticketId && m[l.sessionId]) links = { ...links, [tid]: { ...m, [l.sessionId]: false } }
    }
  }
  return { ...s, links }
}

/**
 * Carga REST de trabajos, proyectos y propuestas. Con replace (al reconectar) la lista
 * REST manda; si no, solo agrega lo que el feed en vivo aún no trajo.
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

/** Tickets de un proyecto (REST) con sus vínculos de sesión. */
export function setTickets(s: AppState, projectId: string, views: TicketView[]): AppState {
  const links = { ...s.links }
  const tickets: Ticket[] = []
  for (const { sessions, proposals: _, ...t } of views) {
    tickets.push(t)
    links[t.id] = Object.fromEntries((sessions ?? []).map((x) => [x.sessionId, x.confirmed]))
  }
  return { ...s, tickets: { ...s.tickets, [projectId]: tickets }, links }
}

/** Detalle de un ticket (REST): el ticket, sus vínculos y sus propuestas. */
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

/** Checkouts guardados de un proyecto (REST). */
export function setCheckouts(s: AppState, projectId: string, cos: Checkout[]): AppState {
  return { ...s, checkouts: { ...s.checkouts, [projectId]: cos } }
}
