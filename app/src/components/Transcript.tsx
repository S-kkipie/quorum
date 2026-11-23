import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Event } from '../proto.gen'

export type Row =
  | { t: 'user' | 'assistant' | 'info'; seq: number; text: string; agent?: string }
  | { t: 'tool'; seq: number; id: string; name: string; summary: string; agent?: string; done: boolean; ok?: boolean; ms?: number; output?: string }
  | { t: 'agent'; seq: number; id: string; type: string; description: string; status: string; answer?: string }
  | { t: 'turn_end'; seq: number; reason: string; tokens: number }

/** Convierte eventos (orden seq) en filas: tool_start+tool_end se emparejan por id. */
export function buildRows(events: Event[]): Row[] {
  const rows: Row[] = []
  const tools = new Map<string, Extract<Row, { t: 'tool' }>>()
  const agents = new Map<string, Extract<Row, { t: 'agent' }>>()
  for (const e of events) {
    const d = e.data ?? {}
    switch (e.kind) {
      case 'user': case 'assistant': case 'info':
        rows.push({ t: e.kind, seq: e.seq, text: d.text ?? '', agent: d.agent })
        break
      case 'tool_start': {
        // el historial rellenado (seq negativo) no trae tool_end: se muestra terminado
        const r: Extract<Row, { t: 'tool' }> = { t: 'tool', seq: e.seq, id: d.id, name: d.name ?? '', summary: d.summary ?? '', agent: d.agent, done: e.seq < 0 }
        tools.set(d.id, r)
        rows.push(r)
        break
      }
      case 'tool_end': {
        const r = tools.get(d.id)
        if (r) Object.assign(r, { done: true, ok: d.ok, ms: d.ms, output: d.output })
        else rows.push({ t: 'tool', seq: e.seq, id: d.id, name: 'herramienta', summary: '', done: true, ok: d.ok, ms: d.ms, output: d.output })
        break
      }
      case 'agent_start': {
        const r: Extract<Row, { t: 'agent' }> = { t: 'agent', seq: e.seq, id: d.id, type: d.type ?? '', description: d.description ?? '', status: 'running' }
        agents.set(d.id, r)
        rows.push(r)
        break
      }
      case 'agent_end': {
        const r = agents.get(d.id)
        if (r) Object.assign(r, { status: d.status ?? 'done', answer: d.answer })
        break
      }
      case 'turn_end':
        rows.push({ t: 'turn_end', seq: e.seq, reason: d.reason ?? '', tokens: d.outputTokens ?? 0 })
        break
    }
  }
  return rows
}

function ToolRow({ r }: { r: Extract<Row, { t: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const mark = !r.done ? '…' : r.ok === false ? '✗' : '✓'
  return (
    <div className={`my-1 rounded border border-zinc-800 text-xs ${r.agent ? 'ml-4' : ''}`}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-2 py-1 text-left">
        <span className={r.ok === false ? 'text-red-400' : 'text-zinc-500'}>{mark}</span>
        <span className="font-mono font-semibold">{r.name}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-500">{r.summary}</span>
        {r.ms !== undefined && <span className="text-zinc-600">{r.ms} ms</span>}
      </button>
      {open && <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-zinc-800 p-2 text-zinc-400">{r.output || (r.done ? '(sin salida)' : 'en curso…')}</pre>}
    </div>
  )
}

function AgentRow({ r, live }: { r: Extract<Row, { t: 'agent' }>; live?: string }) {
  const [open, setOpen] = useState(false)
  const running = r.status === 'running'
  return (
    <div className="my-1 rounded border border-violet-900/60 text-xs">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 px-2 py-1 text-left">
        <span className={running ? 'text-violet-400' : 'text-zinc-500'}>{running ? '◌' : '●'}</span>
        <span className="font-semibold">{r.type || 'subagente'}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-500">{r.description}</span>
        <span className="text-zinc-600">{running ? 'trabajando' : r.status}</span>
      </button>
      {open && <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-zinc-800 p-2 text-zinc-400">{r.answer || live || '…'}</pre>}
    </div>
  )
}

export default function Transcript({ events, live, liveAgent, hasMore, autoLoad = true, onLoadMore }: {
  autoLoad?: boolean
  events: Event[]
  live?: string
  liveAgent?: Record<string, string>
  hasMore?: boolean
  onLoadMore?: () => void
}) {
  const rows = buildRows(events)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prevH = useRef(0)
  const firstSeq = events[0]?.seq

  // Al llegar contenido nuevo abajo se pega al final; al cargar historia se conserva la posición.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (prevH.current && !stick.current && el.scrollTop < 40) el.scrollTop = el.scrollHeight - prevH.current
    else if (stick.current) el.scrollTop = el.scrollHeight
    prevH.current = el.scrollHeight
  }, [events.length, live, firstSeq])
  useEffect(() => { prevH.current = box.current?.scrollHeight ?? 0 })

  const onScroll = () => {
    const el = box.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 40 && hasMore && autoLoad) onLoadMore?.()
  }
  const last = events[events.length - 1]

  return (
    <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {hasMore && <button onClick={onLoadMore} className="mx-auto mb-2 block text-xs text-zinc-500 hover:text-zinc-300">Cargar anteriores</button>}
      {rows.map((r) => {
        switch (r.t) {
          case 'user': return <div key={r.seq} className="my-2 ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-lg bg-blue-900/40 px-3 py-1.5 text-sm">{r.text}</div>
          case 'assistant': return <div key={r.seq} className={`my-2 whitespace-pre-wrap text-sm ${r.agent ? 'ml-4 text-zinc-400' : ''}`}>{r.text}</div>
          case 'info': return <div key={r.seq} className="my-1 text-center text-xs text-zinc-600">{r.text}</div>
          case 'tool': return <ToolRow key={r.seq} r={r} />
          case 'agent': return <AgentRow key={r.seq} r={r} live={liveAgent?.[r.id]} />
          case 'turn_end': return <div key={r.seq} className="my-1 text-center text-[10px] text-zinc-700">fin del turno{r.tokens ? ` · ${r.tokens} tokens` : ''}</div>
        }
      })}
      {live && <div className="my-2 whitespace-pre-wrap text-sm">{live}<span className="animate-pulse">▍</span></div>}
      {last?.kind === 'thinking' && !live && <div className="my-1 text-xs italic text-zinc-600">pensando…</div>}
    </div>
  )
}
