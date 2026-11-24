import { useState } from 'react'
import { createWorkspace, deleteWorkspace, updateWorkspace } from '../lib/api'
import type { Workspace } from '../proto.gen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const COLORS: [string, string][] = [
  ['#3b82f6', 'blue'], ['#10b981', 'green'], ['#f59e0b', 'amber'], ['#ef4444', 'red'],
  ['#a855f7', 'violet'], ['#ec4899', 'pink'], ['#14b8a6', 'teal'], ['#71717a', 'gray'],
]
const field = 'mt-1 min-h-11 w-full rounded-lg border border-line bg-surface p-2 text-sm md:text-sm'

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
    <form onSubmit={(e) => { e.preventDefault(); save() }} className="rounded-xl border border-line bg-surface p-3" aria-label={w ? 'Edit workspace' : 'New workspace'}>
      <label className="block text-xs text-muted-foreground">Name
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Client X" className={field} />
      </label>
      <div className="mt-3 text-xs text-muted-foreground">Color
        <div className="mt-1 flex flex-wrap gap-2">
          {COLORS.map(([c, label]) => (
            <button key={c} type="button" aria-label={`Color ${label}`} aria-pressed={color === c} onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full ${color === c ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : ''}`} style={{ background: c }} />
          ))}
        </div>
      </div>
      <label className="mt-3 block text-xs text-muted-foreground">whoas profile (optional)
        <Input value={whoas} onChange={(e) => setWhoas(e.target.value)} placeholder="client-x" className={field} />
        <span className="mt-1 block text-xs text-muted-foreground">Its projects' connectors run with WHOAS_PROFILE.</span>
      </label>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      <div className="mt-3 flex items-center justify-end gap-2">
        {w && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={remove} className="mr-auto min-h-11 text-xs text-danger">Delete</Button>}
        {onCancel && <Button type="button" variant="secondary" className="min-h-11" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" className="min-h-11" disabled={busy || !name.trim()}>Save</Button>
      </div>
    </form>
  )
}
