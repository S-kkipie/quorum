import { useEffect, useState } from 'react'
import { approveProposal, rejectProposal } from '../lib/api'
import { STATUS_LABEL } from '../lib/projects'
import type { Proposal } from '../proto.gen'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

const BADGE: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300',
  sending: 'bg-blue-500/15 text-blue-300',
  approved: 'bg-emerald-500/15 text-emerald-300',
  rejected: 'bg-zinc-700/40 text-zinc-400',
  failed: 'bg-red-500/15 text-red-300',
}

/** Write proposal for the ticket source: the owner edits it (if it is a comment), approves or rejects. */
export default function ProposalCard({ proposal, onDone }: { proposal: Proposal; onDone?: (p: Proposal) => void }) {
  const p = proposal
  const [body, setBody] = useState(p.body)
  // The hub rewrites the draft on every new turn: it is adopted only if the owner is not editing it.
  const [edited, setEdited] = useState(false)
  useEffect(() => { if (!edited) setBody(p.body) }, [p.body, edited])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = p.status === 'pending'
  const isComment = p.kind === 'comment'

  async function act(fn: () => Promise<Proposal>) {
    setBusy(true)
    setError('')
    try {
      const r = await fn()
      if (r) onDone?.(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error')
    } finally {
      setBusy(false)
    }
  }
  const approve = () => act(() => approveProposal(p.id, isComment && body !== p.body ? body : undefined))
  const reject = () => act(() => rejectProposal(p.id))

  return (
    <Card className="gap-0 rounded border-zinc-800 bg-zinc-900/40 p-2 text-sm shadow-none">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-zinc-400">{isComment ? 'Proposed comment' : 'Proposed status change'}</span>
        <Badge className={`rounded px-1.5 ${BADGE[p.status] ?? BADGE.rejected}`}>{p.status}</Badge>
      </div>
      {isComment ? (
        pending ? (
          <Textarea aria-label="Comment text" value={body} onChange={(e) => { setBody(e.target.value); setEdited(e.target.value !== p.body) }} rows={Math.min(10, Math.max(3, body.split('\n').length))}
            className="mt-2 min-h-0 w-full rounded border border-zinc-800 bg-zinc-950 p-2 text-sm md:text-sm" />
        ) : (
          <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-zinc-400">{p.body}</p>
        )
      ) : (
        <p className="mt-2 text-sm">Move to <strong>{STATUS_LABEL[p.body] ?? p.body}</strong></p>
      )}
      {p.status === 'failed' && p.error && <p className="mt-1 text-xs text-red-400">{p.error}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-red-400">{error}</p>}
      {pending && (
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={reject} className="min-h-11 text-xs">Reject</Button>
          <Button size="sm" disabled={busy || (isComment && !body.trim())} onClick={approve} className="min-h-11 bg-emerald-600 text-xs text-white hover:bg-emerald-600/90">
            {busy ? 'Sending…' : 'Approve'}
          </Button>
        </div>
      )}
    </Card>
  )
}
