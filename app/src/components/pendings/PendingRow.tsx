import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { Pending } from '../../proto.gen'
import { deletePending, patchPending, PENDING_DETAIL_MAX, PENDING_TEXT_MAX, type PendingPatch } from '../../lib/pendingsApi'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

const wrap = '[overflow-wrap:anywhere]'

/** An agent item the owner has not seen yet (added after the previous visit). */
export const isNewPending = (p: Pending, prevSeenAt: number) => p.source === 'agent' && p.createdAt > prevSeenAt

/**
 * One pending item: a checkbox, the text, a "new" dot, the source and a menu (Edit, Drop, Delete). Ticking asks
 * for an optional note before the item closes. The row talks to the hub itself and reports the new item.
 */
export default function PendingRow({ p, prevSeenAt = 0, clamp = false, onChange, onRemoved, onError }: {
  p: Pending
  prevSeenAt?: number
  /** Clip a long text to three lines (the briefing card). */
  clamp?: boolean
  onChange: (p: Pending) => void
  onRemoved: (id: string) => void
  onError?: (message: string) => void
}) {
  const [closing, setClosing] = useState(false)
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(p.text)
  const [detail, setDetail] = useState(p.detail)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const isOpen = p.status === 'open'
  const extra = [p.detail, p.note && 'Note: ' + p.note].filter(Boolean).join('\n\n')

  async function run(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try { await fn() } catch (e) { onError?.(e instanceof Error ? e.message : 'error') } finally { setBusy(false) }
  }
  const patch = (b: PendingPatch) => run(async () => { onChange(await patchPending(p.id, b)); setClosing(false); setNote(''); setEditing(false) })
  const finish = (withNote: boolean) => patch(withNote && note.trim() ? { status: 'done', note: note.trim() } : { status: 'done' })
  const saveEdit = () => { if (text.trim()) void patch({ text: text.trim(), detail: detail.trim() }) }

  if (editing) {
    return (
      <li className="flex min-w-0 flex-col gap-2 py-2">
        <Input aria-label="Text" value={text} maxLength={PENDING_TEXT_MAX} onChange={(e) => setText(e.target.value)} className="min-h-11 text-sm md:text-sm" />
        <Textarea aria-label="Detail" value={detail} maxLength={PENDING_DETAIL_MAX} onChange={(e) => setDetail(e.target.value)} placeholder="Detail (optional)" className="min-h-11 text-sm md:text-sm" />
        <div className="flex gap-2">
          <Button type="button" disabled={busy || !text.trim()} onClick={saveEdit} className="min-h-11 px-4">Save</Button>
          <Button type="button" variant="ghost" onClick={() => { setEditing(false); setText(p.text); setDetail(p.detail) }} className="min-h-11 px-4">Cancel</Button>
        </div>
      </li>
    )
  }

  return (
    <li className="min-w-0 py-1">
      <div className="flex min-w-0 items-start gap-1">
        <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
          <input type="checkbox" aria-label={p.text} checked={closing || p.status === 'done'} disabled={busy || p.status === 'dropped'}
            onChange={(e) => {
              if (p.status === 'done') void patch({ status: 'open' })
              else setClosing(e.target.checked)
            }}
            className="h-5 w-5 cursor-pointer accent-accent" />
        </label>
        <div className="min-w-0 flex-1 py-2.5">
          <button type="button" aria-expanded={extra ? open : undefined} onClick={() => extra && setOpen((o) => !o)}
            className={`block w-full min-w-0 text-left text-sm ${wrap} ${clamp && !open ? 'line-clamp-3' : ''} ${isOpen ? 'text-ink' : 'text-muted-foreground'} ${p.status === 'done' ? 'line-through' : ''} ${extra ? '' : 'cursor-default'}`}>
            {isNewPending(p, prevSeenAt) && <span role="img" aria-label="New" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-accent align-middle" />}
            {p.text}
          </button>
          {(p.source === 'agent' || p.source === 'meeting' || !isOpen) && (
            <span className="block text-xs text-muted-foreground">{[p.source === 'agent' || p.source === 'meeting' ? p.source : '', !isOpen ? p.status : ''].filter(Boolean).join(' · ')}</span>
          )}
          {open && extra && <p className={`mt-1 whitespace-pre-wrap text-xs text-muted-foreground ${wrap}`}>{extra}</p>}
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Item menu" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-chip"><MoreHorizontal className="h-4 w-4" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="min-h-11" onSelect={() => { setText(p.text); setDetail(p.detail); setEditing(true) }}>Edit</DropdownMenuItem>
            {isOpen ? <DropdownMenuItem className="min-h-11" onSelect={() => { void patch({ status: 'dropped' }) }}>Drop</DropdownMenuItem>
              : <DropdownMenuItem className="min-h-11" onSelect={() => { void patch({ status: 'open' }) }}>Reopen</DropdownMenuItem>}
            <DropdownMenuItem className="min-h-11 text-danger" onSelect={() => { void run(async () => { await deletePending(p.id); onRemoved(p.id) }) }}>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {closing && (
        <div className="ml-11 flex min-w-0 flex-col gap-2 pb-2">
          <Input aria-label="Note" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void finish(true) } else if (e.key === 'Escape') setClosing(false) }}
            className="min-h-11 text-sm md:text-sm" />
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy} onClick={() => { void finish(true) }} className="min-h-11 px-4">Done</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { void finish(false) }} className="min-h-11 px-4">Skip note</Button>
          </div>
        </div>
      )}
    </li>
  )
}
