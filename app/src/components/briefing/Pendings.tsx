import type { Pending } from '../../proto.gen'
import PendingRow from '../pendings/PendingRow'
import { PENDING_LIST_ID } from '../pendings/PendingList'
import { useState } from 'react'
import Section from './Section'

/** Open items shown in the briefing before "Show all". */
export const PENDING_SHOWN = 8

/** The project's open pending items, oldest first; the rest is in the list further down the page. */
export default function Pendings({ items, prevSeenAt, onChange }: {
  items: Pending[]
  prevSeenAt: number
  /** Applies a change to the current list (an updater, so a refetch in between is not lost). */
  onChange: (update: (items: Pending[]) => Pending[]) => void
}) {
  const [error, setError] = useState('')
  const shown = items.slice(0, PENDING_SHOWN)
  return (
    <Section title="Pending" aside={items.length > PENDING_SHOWN ? String(items.length) : undefined}>
      <ul className="divide-y divide-line">
        {shown.map((p) => (
          <PendingRow key={p.id} p={p} prevSeenAt={prevSeenAt} clamp onError={setError}
            onChange={(n) => onChange((l) => (n.status === 'open' ? l.map((x) => (x.id === n.id ? n : x)) : l.filter((x) => x.id !== n.id)))}
            onRemoved={(id) => onChange((l) => l.filter((x) => x.id !== id))} />
        ))}
      </ul>
      {error && <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">{error}</p>}
      {items.length > PENDING_SHOWN && (
        <button type="button" onClick={() => document.getElementById(PENDING_LIST_ID)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })}
          className="min-h-11 text-left text-sm text-accent hover:underline">Show all ({items.length})</button>
      )}
    </Section>
  )
}
