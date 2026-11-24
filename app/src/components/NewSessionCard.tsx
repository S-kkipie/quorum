import { useEffect, useState } from 'react'
import { loadPrefs, launchIn, savePrefs } from '../lib/launch'
import { projectCheckouts } from '../lib/projects'
import type { AppState } from '../lib/store'
import LaunchDialog, { BypassToggle } from './LaunchDialog'
import { Button } from '@/components/ui/button'

const sep = '\u0000'

/** Top of the project: one tap launches a new session; machine chip, "Skip permissions" and Terminal. */
export default function NewSessionCard({ state, projectId, pending, onLaunched, onGuard, onTerminal, onSelect }: {
  state: AppState
  projectId: string
  /** A launch is in progress: another cannot be started (double tap = one session). */
  pending: boolean
  onLaunched: (p: { reqId: string; machine: string; label: string }) => void
  /** Launches with the app's single (synchronous) guard: one launch at a time. */
  onGuard: (fn: () => Promise<{ reqId: string; machine: string; label: string }>) => Promise<void>
  onTerminal: (machine: string, root: string) => Promise<unknown> | void
  /** Reports which checkout was chosen (to list its conversations). */
  onSelect?: (machine: string, root: string) => void
}) {
  const cos = projectCheckouts(state, projectId)
  const online = (m: string) => !!state.machines[m]?.online
  const prefs = loadPrefs(projectId)
  const dflt = cos.find((c) => c.machine === prefs.machine && online(c.machine)) ?? cos.find((c) => online(c.machine))
  const [pick, setPick] = useState('')
  const chosen = cos.find((c) => c.machine + sep + c.root === pick && online(c.machine)) ?? dflt
  const [bypass, setBypass] = useState(prefs.bypass)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [other, setOther] = useState(false)
  const [termBusy, setTermBusy] = useState(false)
  const machine = chosen?.machine ?? ''
  const root = chosen?.root ?? ''
  const caps = state.machines[machine]?.caps // no caps = everything false (old daemons)
  const isRoot = !!caps?.root

  useEffect(() => { if (machine) onSelect?.(machine, root) }, [machine, root]) // eslint-disable-line react-hooks/exhaustive-deps

  async function go() {
    if (busy || pending || !chosen) return
    setBusy(true)
    setError('')
    try {
      await onGuard(async () => {
        const p = await launchIn({ machine, dir: root, bypass, root: isRoot, projectId })
        savePrefs(projectId, { machine, bypass })
        return p
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  async function term() {
    if (termBusy) return
    setError('')
    setTermBusy(true)
    try { await onTerminal(machine, root) } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setTermBusy(false) }
  }

  if (cos.length === 0) {
    return (
      <div className="px-3 pt-3">
        <p className="text-sm text-zinc-500">This project has no folder on any machine yet</p>
        <Button variant="link" onClick={() => setOther(true)} className="mt-1 min-h-11 px-0 text-blue-400">Another folder…</Button>
        {other && <LaunchDialog state={state} projectId={projectId} onClose={() => setOther(false)} onLaunched={(p) => { setOther(false); onLaunched(p) }} />}
      </div>
    )
  }
  const multi = new Set(cos.map((c) => c.machine)).size < cos.length
  return (
    <div className="px-3 pt-3">
      <Button size="lg" disabled={busy || pending || !chosen} onClick={go} className="min-h-14 w-full rounded-lg px-4 text-base font-semibold">
        {busy || pending ? 'Launching…' : 'New session'}
      </Button>
      {!chosen && <p className="mt-2 text-xs text-amber-400">No machine of this project is online.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1 rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300">
          <span className={online(machine) ? 'text-emerald-400' : 'text-zinc-600'}>●</span>
          <select aria-label="Machine" value={chosen ? chosen.machine + sep + chosen.root : ''} onChange={(e) => setPick(e.target.value)} className="bg-transparent text-xs">
            {!chosen && <option value="">no machine</option>}
            {cos.map((c) => (
              <option key={c.machine + sep + c.root} value={c.machine + sep + c.root} disabled={!online(c.machine)}>
                {c.machine}{multi ? ` · ${c.root}` : ''}{online(c.machine) ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        </label>
        <BypassToggle checked={bypass} root={isRoot} onChange={(v) => { setBypass(v); savePrefs(projectId, { ...(machine ? { machine } : {}), bypass: v }) }} />
        {caps?.terminal ? (
          <Button variant="secondary" disabled={!chosen || termBusy} onClick={term} className="ml-auto min-h-11 px-4">Terminal</Button>
        ) : (
          chosen && <span className="text-xs text-zinc-500">Terminal not available on this machine (herdr missing)</span>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
