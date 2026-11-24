import { useState } from 'react'
import { launch } from '../lib/api'
import { loadPrefs, savePrefs } from '../lib/launch'
import type { AppState } from '../lib/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export const ROOT_REASON = 'Skip permissions does not work as root'

/** "Skip permissions" checkbox; disabled (and off) if the machine runs as root. */
export function BypassToggle({ checked, root, onChange }: { checked: boolean; root: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="mt-3 flex items-center gap-2 text-sm" title={root ? ROOT_REASON : undefined}>
      <input type="checkbox" checked={checked && !root} disabled={root} onChange={(e) => onChange(e.target.checked)} /> Skip permissions
      {root && <span className="text-xs text-muted-foreground">{ROOT_REASON}</span>}
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

  const field = 'mt-1 min-h-11 w-full rounded-lg border border-line bg-surface p-2 text-sm'
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}
        // an accidental tap outside or Esc must not drop a typed folder; Cancel still closes
        onInteractOutside={(e) => { if (dir.trim()) e.preventDefault() }}
        onEscapeKeyDown={(e) => { if (dir.trim()) e.preventDefault() }}
        className="top-auto bottom-0 left-0 max-w-none translate-x-0 translate-y-0 gap-0 rounded-b-none rounded-t-xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:top-[50%] sm:bottom-auto sm:left-[50%] sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:pb-4 max-sm:motion-safe:starting:translate-y-full max-sm:motion-safe:starting:scale-100 max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=closed]:zoom-out-100">
        <DialogTitle className="text-base font-semibold">New session</DialogTitle>
        {online.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No machines online.</p>
        ) : (
          <>
            <label className="mt-3 block text-xs text-muted-foreground">Machine
              <select value={machine} onChange={(e) => setMachine(e.target.value)} className={field}>
                {online.map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs text-muted-foreground">Folder
              <Input list="launch-dirs" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/path/to/project" className={field} />
              <datalist id="launch-dirs">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
            </label>
            <BypassToggle checked={bypass} root={root} onChange={setBypass} />
          </>
        )}
        {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
        <DialogFooter className="mt-4 flex-row justify-end gap-2 sm:flex-row">
          <Button variant="secondary" className="min-h-11" onClick={onClose}>Cancel</Button>
          <Button className="min-h-11" disabled={busy || !machine || !dir.trim()} onClick={go}>Start</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
