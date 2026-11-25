import { useMemo, useState } from 'react'
import type { MeetingSegment } from '../../proto.gen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pencil } from 'lucide-react'
import { clock, speakers, splitMatches, type Speaker } from './util'

const wrap = '[overflow-wrap:anywhere]'

/** A speaker chip that turns into a name field; Enter or Save stores the name ("" goes back to the label). */
function SpeakerName({ s, onRename }: { s: Speaker; onRename: (label: string, name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const renamed = s.name !== s.label
  async function save() {
    setBusy(true)
    setError('')
    try { await onRename(s.label, name.trim()); setEditing(false) } catch (e) { setError(e instanceof Error ? e.message : 'error') } finally { setBusy(false) }
  }
  if (!editing) {
    return (
      <li>
        <button type="button" aria-label={`Rename ${s.name}`} onClick={() => { setName(renamed ? s.name : ''); setEditing(true) }}
          className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2 text-sm hover:bg-chip">
          <span className="min-w-0 truncate">{s.name}</span>
          {renamed && <span className="shrink-0 text-xs text-muted-foreground">({s.label})</span>}
          <Pencil aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </li>
    )
  }
  return (
    <li className="w-full">
      <form className="flex min-w-0 items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <Input autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={s.label}
          aria-label={`Name of ${s.label}`} className="min-h-11 min-w-0 flex-1" onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }} />
        <Button type="submit" size="sm" disabled={busy} className="min-h-11 shrink-0">Save</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} className="min-h-11 shrink-0">Cancel</Button>
      </form>
      {error && <p role="alert" className={`text-xs text-danger ${wrap}`}>{error}</p>}
    </li>
  )
}

/**
 * The meeting transcript: the speakers (renamed inline), a search that highlights its matches (and shows only the
 * segments that have one), and times that seek the audio.
 */
export default function Transcript({ segments, onSeek, onRename, onResummarise }: {
  segments: MeetingSegment[]
  onSeek: (ms: number) => void
  onRename: (label: string, name: string) => Promise<void>
  /** Shown as "Re-summarise with names" after a rename. */
  onResummarise?: () => void
}) {
  const [q, setQ] = useState('')
  const people = useMemo(() => speakers(segments), [segments])
  const needle = q.trim()
  const shown = useMemo(() => (needle ? segments.filter((s) => s.text.toLowerCase().includes(needle.toLowerCase())) : segments), [segments, needle])
  return (
    <div className="min-w-0 space-y-3">
      {people.length > 0 && (
        <div className="space-y-2">
          <ul aria-label="Speakers" className="flex min-w-0 flex-wrap gap-2">
            {people.map((s) => <SpeakerName key={s.label} s={s} onRename={onRename} />)}
          </ul>
          {onResummarise && <Button variant="secondary" onClick={onResummarise} className="min-h-11 w-full">Re-summarise with names</Button>}
        </div>
      )}
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the transcript" aria-label="Search the transcript" className="min-h-11" />
      {needle && <p className="text-xs text-muted-foreground" aria-live="polite">{shown.length} {shown.length === 1 ? 'segment matches' : 'segments match'}</p>}
      <ol className="space-y-2">
        {shown.map((s, i) => (
          <li key={s.startMs + ':' + i} className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
              <button type="button" onClick={() => onSeek(s.startMs)} aria-label={`Play from ${clock(s.startMs)}`}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center tabular-nums text-accent hover:underline">{clock(s.startMs)}</button>
              {s.speaker && <span className="min-w-0 truncate font-medium text-ink">{s.speaker}</span>}
            </div>
            <p className={`-mt-2 text-sm text-ink ${wrap}`}>
              {splitMatches(s.text, needle).map((part, j) => (j % 2 ? <mark key={j} className="rounded-sm bg-accent-soft text-ink">{part}</mark> : part))}
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}
