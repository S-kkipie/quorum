import { useState } from 'react'
import { createWorkspace, deleteWorkspace, updateWorkspace } from '../lib/api'
import type { Workspace } from '../proto.gen'

const COLORS: [string, string][] = [
  ['#3b82f6', 'blue'], ['#10b981', 'green'], ['#f59e0b', 'amber'], ['#ef4444', 'red'],
  ['#a855f7', 'violet'], ['#ec4899', 'pink'], ['#14b8a6', 'teal'], ['#71717a', 'gray'],
]
const field = 'mt-1 w-full rounded border border-zinc-800 bg-zinc-900 p-2 text-sm'

/** Create or edit a workspace: name, color and whoas profile. */
export default function WorkspaceForm({ workspace, onDone, onCancel }: { workspace?: Workspace; onDone?: () => void; onCancel?: () => void }) {
  const w = workspace
  const [name, setName] = useState(w?.name ?? '')
  const [color, setColor] = useState(w?.color || '#3b82f6')
  const [whoas, setWhoas] = useState(w?.whoasProfile ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await fn()
      onDone?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    const b = { name: name.trim(), color, whoasProfile: whoas.trim() }
    // the hub's create only takes the name: color and profile go in a PATCH afterwards
    return run(async () => {
      if (w) return updateWorkspace(w.id, b)
      const nw = await createWorkspace({ name: b.name })
      return updateWorkspace(nw.id, { color: b.color, whoasProfile: b.whoasProfile })
    })
  }
  const remove = () => {
    if (w && confirm(`Delete workspace "${w.name}"?`)) run(() => deleteWorkspace(w.id))
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save() }} className="rounded border border-zinc-800 bg-zinc-950 p-3" aria-label={w ? 'Edit workspace' : 'New workspace'}>
      <label className="block text-xs text-zinc-400">Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Client X" className={field} />
      </label>
      <div className="mt-3 text-xs text-zinc-400">Color
        <div className="mt-1 flex flex-wrap gap-2">
          {COLORS.map(([c, label]) => (
            <button key={c} type="button" aria-label={`Color ${label}`} aria-pressed={color === c} onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full ${color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-950' : ''}`} style={{ background: c }} />
          ))}
        </div>
      </div>
      <label className="mt-3 block text-xs text-zinc-400">whoas profile (optional)
        <input value={whoas} onChange={(e) => setWhoas(e.target.value)} placeholder="client-x" className={field} />
        <span className="mt-1 block text-[11px] text-zinc-600">Its projects' connectors run with WHOAS_PROFILE.</span>
      </label>
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        {w && <button type="button" disabled={busy} onClick={remove} className="mr-auto text-xs text-red-400">Delete</button>}
        {onCancel && <button type="button" onClick={onCancel} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Cancel</button>}
        <button type="submit" disabled={busy || !name.trim()} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40">Save</button>
      </div>
    </form>
  )
}
