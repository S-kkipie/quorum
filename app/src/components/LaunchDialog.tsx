import { useState } from 'react'
import { launch } from '../lib/api'
import type { AppState } from '../lib/store'

export const MODES: [string, string][] = [
  ['default', 'Normal (pide permisos)'],
  ['acceptEdits', 'Aceptar ediciones'],
  ['plan', 'Plan'],
  ['bypassPermissions', 'Sin permisos (peligroso)'],
]

export default function LaunchDialog({ state, onClose, result }: { state: AppState; onClose: () => void; result?: { reqId: string; ok: boolean; error?: string } | null }) {
  const online = Object.values(state.machines).filter((m) => m.online).map((m) => m.name).sort()
  const [machine, setMachine] = useState(online[0] ?? '')
  const [dir, setDir] = useState('')
  const [cont, setCont] = useState(false)
  const [mode, setMode] = useState('default')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reqId, setReqId] = useState('')

  const dirs = [...new Set(Object.values(state.sessions).filter((s) => s.machine === machine && s.role !== 'service').map((s) => s.cwd))].sort()
  const fail = reqId && result && result.reqId === reqId && !result.ok ? result.error || 'no se pudo lanzar' : ''
  const sent = reqId && result && result.reqId === reqId && result.ok

  async function go() {
    setBusy(true)
    setError('')
    try {
      const r = await launch({ machine, dir: dir.trim(), continue: cont, permissionMode: mode })
      setReqId(r.reqId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }

  const field = 'mt-1 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-sm'
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-label="Lanzar sesión">
      <div className="w-full max-w-md rounded-t-lg border border-zinc-800 bg-zinc-950 p-4 sm:rounded-lg">
        <h2 className="text-base font-semibold">Lanzar sesión</h2>
        {online.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No hay máquinas en línea.</p>
        ) : (
          <>
            <label className="mt-3 block text-xs text-zinc-400">Máquina
              <select value={machine} onChange={(e) => setMachine(e.target.value)} className={field}>
                {online.map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs text-zinc-400">Carpeta
              <input list="launch-dirs" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/ruta/al/proyecto" className={field} />
              <datalist id="launch-dirs">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
            </label>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={cont} onChange={(e) => setCont(e.target.checked)} /> Continuar la última conversación
            </label>
            <label className="mt-3 block text-xs text-zinc-400">Modo de permisos
              <select value={mode} onChange={(e) => setMode(e.target.value)} className={field}>
                {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </>
        )}
        {(error || fail) && <p role="alert" className="mt-3 text-xs text-red-400">{error || fail}</p>}
        {reqId && !fail && !sent && <p className="mt-3 text-xs text-zinc-500">Lanzando…</p>}
        {sent && <p className="mt-3 text-xs text-emerald-400">Lanzada. Aparecerá en la lista en unos segundos.</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">{sent ? 'Cerrar' : 'Cancelar'}</button>
          {!sent && <button disabled={busy || !machine || !dir.trim()} onClick={go} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40">Lanzar</button>}
        </div>
      </div>
    </div>
  )
}
