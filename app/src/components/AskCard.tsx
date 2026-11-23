import { useState } from 'react'
import { decide } from '../lib/api'
import type { Ask } from '../proto.gen'

interface Q { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }

function parseQuestions(raw: unknown): Q[] {
  let v: unknown = raw
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return [] } }
  if (v && !Array.isArray(v) && Array.isArray((v as any).questions)) v = (v as any).questions
  return Array.isArray(v) ? (v as Q[]) : []
}

export default function AskCard({ session, ask, onDone }: { session: string; ask: Ask; onDone?: () => void }) {
  const questions = ask.kind === 'question' ? parseQuestions(ask.questions) : []
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [gone, setGone] = useState(false)

  async function send(body: Parameters<typeof decide>[1]) {
    setBusy(true)
    setError('')
    try {
      await decide(session, body)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error'
      if (/ya se respondió/i.test(msg)) {
        setGone(true)
        setTimeout(() => onDone?.(), 2000)
      } else setError(msg)
    } finally {
      setBusy(false)
    }
  }

  if (gone) return <div className="mx-3 my-2 rounded border border-zinc-800 p-2 text-xs text-zinc-500">ya se respondió</div>

  const toggle = (qi: number, label: string, multi: boolean) =>
    setPicked((p) => {
      const cur = p[qi] ?? []
      if (!multi) return { ...p, [qi]: [label] }
      return { ...p, [qi]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
    })

  const answers = () => {
    const out: Record<string, string> = {}
    questions.forEach((q, i) => {
      const parts = [...(picked[i] ?? [])]
      const o = (other[i] ?? '').trim()
      if (o) parts.push(o)
      if (parts.length) out[q.question] = parts.join(', ')
    })
    return out
  }
  const complete = questions.length > 0 && questions.every((_, i) => (picked[i]?.length ?? 0) > 0 || (other[i] ?? '').trim())

  return (
    <div className="mx-3 my-2 rounded border border-amber-700/60 bg-amber-950/20 p-3 text-sm">
      {ask.kind === 'question' ? (
        <>
          {questions.map((q, qi) => (
            <fieldset key={qi} className="mb-3">
              {q.header && <div className="text-xs uppercase text-amber-400">{q.header}</div>}
              <legend className="font-medium">{q.question}</legend>
              {(q.options ?? []).map((o) => (
                <label key={o.label} className="mt-1 flex items-start gap-2">
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`q${qi}`}
                    checked={(picked[qi] ?? []).includes(o.label)}
                    onChange={() => toggle(qi, o.label, !!q.multiSelect)}
                  />
                  <span>{o.label}{o.description && <span className="block text-xs text-zinc-500">{o.description}</span>}</span>
                </label>
              ))}
              <input
                value={other[qi] ?? ''}
                onChange={(e) => setOther({ ...other, [qi]: e.target.value })}
                placeholder="Otra…"
                aria-label={`Otra: ${q.question}`}
                className="mt-2 w-full rounded border border-zinc-800 bg-zinc-900 p-1 text-sm"
              />
            </fieldset>
          ))}
          <div className="flex gap-2">
            <button disabled={busy || !complete} onClick={() => send({ askId: ask.askId, decision: 'allow', answers: answers() })} className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-40">Enviar respuestas</button>
            <button disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'deny' })} className="rounded bg-zinc-800 px-3 py-1.5 disabled:opacity-40">Denegar</button>
          </div>
        </>
      ) : (
        <>
          <div className="text-xs text-amber-400">Permiso · {ask.tool}</div>
          <div className="mt-1 font-medium">{ask.summary}</div>
          {ask.detail && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-900 p-2 text-xs text-zinc-400">{ask.detail}</pre>}
          <div className="mt-2 flex gap-2">
            <button disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'allow' })} className="rounded bg-emerald-600 px-3 py-1.5 text-white disabled:opacity-40">Permitir</button>
            <button disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'deny' })} className="rounded bg-zinc-800 px-3 py-1.5 disabled:opacity-40">Denegar</button>
          </div>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
