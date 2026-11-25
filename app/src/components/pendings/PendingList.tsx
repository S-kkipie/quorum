import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Pending } from '../../proto.gen'
import { addPending, listPendings, PENDING_DETAIL_MAX, PENDING_TEXT_MAX } from '../../lib/pendingsApi'
import { enterSends } from '../../lib/enterSends'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import Section from '../briefing/Section'
import PendingRow from './PendingRow'

/** The element id the briefing's "Show all" scrolls to. */
export const PENDING_LIST_ID = 'pending-items'

/** The project's pending items, refetched whenever `rev` changes (project_briefing_changed); the last answer stays shown meanwhile. */
function usePendings(projectId: string, all: boolean, rev: number) {
  const [list, setList] = useState<Pending[] | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    listPendings(projectId, all)
      .then((x) => { if (n === seq.current) { setList(Array.isArray(x) ? x : []); setError('') } })
      .catch((e) => { if (n === seq.current) setError(e instanceof Error ? e.message : 'error') })
  }, [projectId, all, rev])
  useEffect(() => () => { seq.current++ }, [])
  return { list, setList, error, setError }
}

/** The first line is the item, the rest (after Shift+Enter) its detail. */
export function splitPending(raw: string): { text: string; detail: string } {
  const s = raw.trim()
  const i = s.indexOf('\n')
  return i < 0 ? { text: s, detail: '' } : { text: s.slice(0, i).trim(), detail: s.slice(i + 1).trim() }
}

/** The Pending section of the project page: add field, Open | All toggle and the scrolling list. */
export default function PendingList({ projectId, rev = 0, prevSeenAt = 0 }: { projectId: string; rev?: number; prevSeenAt?: number }) {
  const [all, setAll] = useState(false)
  const { list, setList, error, setError } = usePendings(projectId, all, rev)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const { text, detail } = splitPending(draft)
  const tooLong = [...text].length > PENDING_TEXT_MAX || [...detail].length > PENDING_DETAIL_MAX

  async function add() {
    if (busy || !text || tooLong) return
    setBusy(true)
    setError('')
    try {
      const p = await addPending(projectId, detail ? { text, detail } : { text })
      setList((l) => (l ?? []).some((x) => x.id === p.id) ? (l ?? []).map((x) => (x.id === p.id ? p : x)) : [...(l ?? []), p])
      setDraft('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    // Enter adds on a computer; Shift+Enter is a new line (the detail). Ctrl/Cmd+Enter adds everywhere.
    if ((enterSends() && !e.shiftKey) || e.ctrlKey || e.metaKey) { e.preventDefault(); void add() }
  }
  const replace = (p: Pending) => setList((l) => (l ?? []).flatMap((x) => (x.id !== p.id ? [x] : all || p.status === 'open' ? [p] : [])))
  const remove = (id: string) => setList((l) => (l ?? []).filter((x) => x.id !== id))

  return (
    <div id={PENDING_LIST_ID} className="min-w-0 px-3 pt-3">
      <Section title="Pending items" aside={
        <span role="group" aria-label="Show" className="flex gap-1">
          {[false, true].map((v) => (
            <button key={String(v)} type="button" aria-pressed={all === v} onClick={() => setAll(v)}
              className={`min-h-11 min-w-11 rounded-lg px-2 text-xs ${all === v ? 'bg-chip text-ink' : 'text-muted-foreground hover:bg-chip'}`}>{v ? 'All' : 'Open'}</button>
          ))}
        </span>
      }>
        <form className="flex min-w-0 items-start gap-2" onSubmit={(e) => { e.preventDefault(); void add() }}>
          <Textarea aria-label="New pending item" value={draft} rows={1} onChange={(e) => { setDraft(e.target.value); setError('') }} onKeyDown={onKey}
            placeholder="Add a pending item" aria-invalid={tooLong || undefined} className="max-h-40 min-h-11 min-w-0 flex-1 text-sm md:text-sm" />
          <Button type="submit" variant="secondary" disabled={busy || !text || tooLong} className="min-h-11 shrink-0 px-4">Add</Button>
        </form>
        {tooLong && <p role="alert" className="text-xs text-danger">An item can be at most {PENDING_TEXT_MAX} characters and its detail {PENDING_DETAIL_MAX}.</p>}
        {error && <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">{error}</p>}
        {list && !list.length && !error && <p className="text-xs text-muted-foreground">{all ? 'Nothing here yet.' : 'Nothing pending.'}</p>}
        {!!list?.length && (
          <ScrollArea viewportClassName="max-h-[60dvh]">
            <ul className="divide-y divide-line">
              {list.map((p) => <PendingRow key={p.id} p={p} prevSeenAt={prevSeenAt} onChange={replace} onRemoved={remove} onError={setError} />)}
            </ul>
          </ScrollArea>
        )}
      </Section>
    </div>
  )
}
