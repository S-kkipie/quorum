import type { AppState } from '../lib/store'
import SessionRowView from '../components/SessionRow'

export default function Sessions({ state, onOpen, selected }: { state: AppState; onOpen?: (id: string) => void; selected?: string | null }) {
  const all = state.order.map((id) => state.sessions[id]).filter((s) => s && s.state !== 'closed')
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
              <ul className="divide-y divide-zinc-900 border-y border-zinc-900">{list.map((s) => <SessionRowView key={s.id} row={{ kind: 'live', id: s.id, session: s }} detailed onOpen={onOpen} active={s.id === selected} project={state.projects[s.projectId]?.name} />)}</ul>
            ) : (
              <p className="px-3 text-xs text-zinc-600">No sessions.</p>
            )}
          </section>
        )
      })}

      {services.length > 0 && (
        <section className="mt-6">
          <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">Services</h2>
          <ul className="divide-y divide-zinc-900 border-y border-zinc-900">{services.map((s) => <SessionRowView key={s.id} row={{ kind: 'live', id: s.id, session: s }} detailed onOpen={onOpen} active={s.id === selected} />)}</ul>
        </section>
      )}
    </div>
  )
}
