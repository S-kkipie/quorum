import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { PinnedNote } from '../../proto.gen'
import { addPinned, deletePinned } from '../../lib/api'
import { PIN_MAX } from '../../lib/briefing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import Section, { wrap } from './Section'

/** Short notes the owner pins to the project (stored by the hub, so every device sees them). */
export default function PinnedNotes({ projectId, notes, onChange, autoFocus = false }: {
  projectId: string
  notes: PinnedNote[]
  /** Applies a change to the current list (an updater, so a refetch in between is not lost). */
  onChange: (update: (notes: PinnedNote[]) => PinnedNote[]) => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const len = text.trim().length
  const over = len > PIN_MAX
  const shown = over ? `A note can be at most ${PIN_MAX} characters (this one has ${len}).` : error

  async function pin() {
    if (busy || !len || over) return
    setBusy(true)
    setError('')
    try {
      const n = await addPinned(projectId, text.trim())
      onChange((list) => [...list.filter((x) => x.id !== n.id), n])
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  async function remove(id: string) {
    setError('')
    try {
      await deletePinned(projectId, id)
      onChange((list) => list.filter((x) => x.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    }
  }

  return (
    <Section title="Pinned notes" aside="every device sees them">
      {notes.length > 0 && (
        <ul className="divide-y divide-line">
          {notes.map((n) => (
            <li key={n.id} className="flex min-h-11 items-center gap-2">
              <span className={`min-w-0 flex-1 whitespace-pre-wrap text-sm text-ink ${wrap}`}>{n.text}</span>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="Note menu" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-chip"><MoreHorizontal className="h-4 w-4" /></button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="min-h-11 text-danger" onSelect={() => { void remove(n.id) }}>Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      <form className="flex min-w-0 items-center gap-2" onSubmit={(e) => { e.preventDefault(); void pin() }}>
        <Input aria-label="New pinned note" value={text} autoFocus={autoFocus} onChange={(e) => { setText(e.target.value); setError('') }}
          placeholder="Pin a short note" aria-invalid={over || undefined} className="min-h-11 min-w-0 flex-1 text-sm md:text-sm" />
        <Button type="submit" variant="secondary" disabled={busy || !len || over} className="min-h-11 shrink-0 px-4">Pin</Button>
      </form>
      {shown && <p role="alert" className={`text-xs text-danger ${wrap}`}>{shown}</p>}
    </Section>
  )
}
