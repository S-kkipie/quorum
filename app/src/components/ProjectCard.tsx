import type { Project, SessionInfo } from '../proto.gen'
import { SESSION_STATE } from '../lib/projects'
import { sessionTitle } from '../lib/title'

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <span className="flex items-center gap-2">
      <span role="progressbar" aria-label={`avance: ${done} de ${total} hechos`} aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}
        className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
        <span className="block h-full rounded bg-emerald-500" style={{ width: `${pct}%` }} />
      </span>
      <span className="shrink-0 text-xs tabular-nums text-zinc-400">{done}/{total}</span>
    </span>
  )
}

export default function ProjectCard({ project, sessions, pending, active, onOpen, onOpenSession }: {
  project: Project
  sessions: SessionInfo[]
  pending: number
  active?: boolean
  onOpen?: (id: string) => void
  onOpenSession?: (id: string) => void
}) {
  const p = project
  return (
    <article className={`rounded-lg border bg-zinc-900/40 ${active ? 'border-blue-600' : 'border-zinc-800'}`}>
      <button onClick={() => onOpen?.(p.id)} className="block w-full p-3 text-left hover:bg-zinc-900/80">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-semibold">{p.name}</span>
          {pending > 0 && (
            <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300">
              {pending} {pending === 1 ? 'propuesta' : 'propuestas'}
            </span>
          )}
        </span>
        <span className="mt-2 block"><Progress done={p.progress?.done ?? 0} total={p.progress?.total ?? 0} /></span>
        {p.summary ? (
          <span className="mt-2 block text-xs leading-snug text-zinc-300">{p.summary}</span>
        ) : (
          <span className="mt-2 block text-xs text-zinc-600">{p.connector?.kind === 'none' ? 'Sin ticketera.' : 'Sin resumen todavía.'}</span>
        )}
        {p.syncError && (
          <span role="alert" title={p.syncError} className="mt-2 line-clamp-3 rounded bg-red-500/10 px-2 py-1 text-xs break-words text-red-300">
            Error de sincronización: {p.syncError}
          </span>
        )}
      </button>
      {sessions.length > 0 && (
        <ul className="border-t border-zinc-800/80 py-1">
          {sessions.map((s) => {
            const st = SESSION_STATE[s.state] ?? SESSION_STATE.idle
            return (
              <li key={s.id}>
                <button onClick={() => onOpenSession?.(s.id)} className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-zinc-900">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                  <span className="min-w-0 flex-1 truncate">{sessionTitle(s).title}</span>
                  <span className={`shrink-0 ${st.text}`}>{st.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}
