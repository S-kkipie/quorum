import { useState } from 'react'
import { launch } from '../lib/api'
import { loadPrefs, savePrefs } from '../lib/launch'
import type { AppState } from '../lib/store'

export const ROOT_REASON = 'Skip permissions does not work as root'

/** "Skip permissions" checkbox; disabled (and off) if the machine runs as root. */
export function BypassToggle({ checked, root, onChange }: { checked: boolean; root: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mt-3 flex items-center gap-2 text-sm" title={root ? ROOT_REASON : undefined}>
      <input type="checkbox" checked={checked && !root} disabled={root} onChange={(e) => onChange(e.target.checked)} /> Skip permissions
      {root && <span className="text-[11px] text-zinc-500">{ROOT_REASON}</span>}
    </label>
  )
}

export default function LaunchDialog({ state, onClose, onLaunched, projectId = '' }: {
  state: AppState
  onClose: () => void
  /** /api/launch was called: the app switches to "Starting…". */
  onLaunched: (p: { reqId: string; machine: string; label: string }) => void
  projectId?: string
}) {
  const online = Object.values(state.machines).filter((m) => m.online).map((m) => m.name).sort()
  const prefs = loadPrefs(projectId || '_')
  const [machine, setMachine] = useState(prefs.machine && online.includes(prefs.machine) ? prefs.machine : online[0] ?? '')
  const [dir, setDir] = useState('')
  const [bypass, setBypass] = useState(prefs.bypass)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const dirs = [...new Set(Object.values(state.sessions).filter((s) => s.machine === machine && s.role !== 'service').map((s) => s.cwd))].sort()
  const root = !!state.machines[machine]?.caps?.root

  async function go() {
    setBusy(true)
    setError('')
    try {
      const useBypass = bypass && !root
      const r = await launch({ machine, dir: dir.trim(), permissionMode: useBypass ? 'bypass' : 'default', projectId: projectId || undefined })
      savePrefs(projectId || '_', { machine, bypass })
      onLaunched({ reqId: r.reqId, machine, label: dir.trim() })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
      setBusy(false)
    }
  }

  const field = 'mt-1 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-sm'
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-label="New session">
      <div className="w-full max-w-md rounded-t-lg border border-zinc-800 bg-zinc-950 p-4 sm:rounded-lg">
        <h2 className="text-base font-semibold">New session</h2>
        {online.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">No machines online.</p>
        ) : (
          <>
            <label className="mt-3 block text-xs text-zinc-400">Machine
              <select value={machine} onChange={(e) => setMachine(e.target.value)} className={field}>
                {online.map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs text-zinc-400">Folder
              <input list="launch-dirs" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/path/to/project" className={field} />
              <datalist id="launch-dirs">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
            </label>
            <BypassToggle checked={bypass} root={root} onChange={setBypass} />
          </>
        )}
        {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Cancel</button>
          <button disabled={busy || !machine || !dir.trim()} onClick={go} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40">Start</button>
        </div>
      </div>
    </div>
  )
}
