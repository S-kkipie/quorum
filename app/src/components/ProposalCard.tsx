import { useEffect, useState } from 'react'
import { approveProposal, rejectProposal } from '../lib/api'
import { STATUS_LABEL } from '../lib/projects'
import type { Proposal } from '../proto.gen'

const BADGE: Record<string, string> = {
  pendiente: 'bg-amber-500/15 text-amber-300',
  enviando: 'bg-blue-500/15 text-blue-300',
  aprobada: 'bg-emerald-500/15 text-emerald-300',
  rechazada: 'bg-zinc-700/40 text-zinc-400',
  fallida: 'bg-red-500/15 text-red-300',
}

/** Propuesta de escritura en la ticketera: el dueño la edita (si es comentario), aprueba o rechaza. */
export default function ProposalCard({ proposal, onDone }: { proposal: Proposal; onDone?: (p: Proposal) => void }) {
  const p = proposal
  const [body, setBody] = useState(p.body)
  // El hub reescribe el borrador en cada turno nuevo: se adopta solo si el dueño no lo está editando.
  const [edited, setEdited] = useState(false)
  useEffect(() => { if (!edited) setBody(p.body) }, [p.body, edited])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = p.status === 'pendiente'
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
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2 text-sm">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-zinc-400">{isComment ? 'Comentario propuesto' : 'Cambio de estado propuesto'}</span>
        <span className={`rounded px-1.5 py-0.5 ${BADGE[p.status] ?? BADGE.rechazada}`}>{p.status}</span>
      </div>
      {isComment ? (
        pending ? (
          <textarea aria-label="Texto del comentario" value={body} onChange={(e) => { setBody(e.target.value); setEdited(e.target.value !== p.body) }} rows={Math.min(10, Math.max(3, body.split('\n').length))}
            className="mt-2 w-full rounded border border-zinc-800 bg-zinc-950 p-2 text-sm" />
        ) : (
          <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-zinc-400">{p.body}</p>
        )
      ) : (
        <p className="mt-2 text-sm">Pasar a <strong>{STATUS_LABEL[p.body] ?? p.body}</strong></p>
      )}
      {p.status === 'fallida' && p.error && <p className="mt-1 text-xs text-red-400">{p.error}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-red-400">{error}</p>}
      {pending && (
        <div className="mt-2 flex justify-end gap-2">
          <button disabled={busy} onClick={reject} className="rounded bg-zinc-800 px-3 py-1 text-xs disabled:opacity-40">Rechazar</button>
          <button disabled={busy || (isComment && !body.trim())} onClick={approve} className="rounded bg-emerald-600 px-3 py-1 text-xs text-white disabled:opacity-40">
            {busy ? 'Enviando…' : 'Aprobar'}
          </button>
        </div>
      )}
    </div>
  )
}
