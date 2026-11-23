import type { SessionInfo } from '../proto.gen'
import type { AppState } from '../lib/store'
import { sessionTitle } from '../lib/title'
import { SESSION_STATE as STATE } from '../lib/projects'

function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - (ts > 1e12 ? ts / 1000 : ts)))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function Row({ s, onOpen, active, project }: { s: SessionInfo; onOpen?: (id: string) => void; active?: boolean; project?: string }) {
  const st = STATE[s.state] ?? STATE.idle
  const closed = s.state === 'closed'
  const { title, short } = sessionTitle(s)
  return (
    <li>
      <button onClick={() => onOpen?.(s.id)} className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-900 ${active ? 'bg-zinc-900' : ''} ${closed ? 'opacity-50' : ''}`}>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.dot}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-zinc-500">
            {project && <span className="text-zinc-400">{project} · </span>}{short} · {s.cwd}
          </span>
        </span>
        <span className="shrink-0 text-right text-xs">
          <span className={`block ${st.text}`}>{st.label}</span>
          <span className="block text-zinc-600">{s.contextPct > 0 ? `${s.contextPct}% · ` : ''}{ago(s.updatedAt)}</span>
        </span>
      </button>
    </li>
  )
}

export default function Sessions({ state, onOpen, selected }: { state: AppState; onOpen?: (id: string) => void; selected?: string | null }) {
  const all = state.order.map((id) => state.sessions[id]).filter(Boolean)
  const work = all.filter((s) => s.role !== 'service')
  const services = all.filter((s) => s.role === 'service')
  const machines = Object.keys({ ...state.machines, ...Object.fromEntries(work.map((s) => [s.machine, 1])) }).sort()

  return (
    <div className="mx-auto max-w-3xl pb-8 lg:max-w-none">

      {machines.length === 0 && <p className="p-6 text-center text-sm text-zinc-500">No machines yet. Connect a daemon to the hub.</p>}

      {machines.map((m) => {
        const info = state.machines[m]
        const offline = info ? !info.online : true
        const list = work.filter((s) => s.machine === m)
        return (
          <section key={m} className={`mt-4 ${offline ? 'opacity-60' : ''}`}>
            <h2 className="flex items-center gap-2 px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
              <span className={`h-2 w-2 rounded-full ${offline ? 'bg-zinc-600' : 'bg-emerald-500'}`} />
              {m}
              {info?.env && <span className="font-normal normal-case text-zinc-600">{info.env}</span>}
              {offline && <span className="font-normal normal-case text-zinc-500">offline</span>}
            </h2>
            {list.length ? (
              <ul className="divide-y divide-zinc-900 border-y border-zinc-900">{list.map((s) => <Row key={s.id} s={s} onOpen={onOpen} active={s.id === selected} project={state.projects[s.projectId]?.name} />)}</ul>
            ) : (
              <p className="px-3 text-xs text-zinc-600">No sessions.</p>
            )}
          </section>
        )
      })}

      {services.length > 0 && (
        <section className="mt-6">
          <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Services</h2>
          <ul className="divide-y divide-zinc-900 border-y border-zinc-900">{services.map((s) => <Row key={s.id} s={s} onOpen={onOpen} active={s.id === selected} />)}</ul>
        </section>
      )}
    </div>
  )
}
