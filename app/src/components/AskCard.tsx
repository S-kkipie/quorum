import { useState } from 'react'
import { Check, MessageCircleQuestion, Send, ShieldAlert, X } from 'lucide-react'
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
      if (/already answered/i.test(msg)) {
        setGone(true)
        setTimeout(() => onDone?.(), 2000)
      } else setError(msg)
    } finally {
      setBusy(false)
    }
  }

  if (gone) return <div className="mx-3 my-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-zinc-500">already answered</div>

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

  const btn = 'flex min-h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-medium disabled:opacity-40'
  return (
    <div className="mx-3 my-2 rounded-xl border border-amber-500/30 bg-zinc-900/80 p-3 text-sm">
      {ask.kind === 'question' ? (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-amber-300"><MessageCircleQuestion size={14} aria-hidden />Question</div>
          {questions.map((q, qi) => (
            <fieldset key={qi} className="mb-3">
              {q.header && <div className="text-[11px] uppercase tracking-wide text-amber-400/80">{q.header}</div>}
              <legend className="font-medium">{q.question}</legend>
              {(q.options ?? []).map((o) => (
                <label key={o.label} className="mt-1 flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-zinc-800/60">
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`q${qi}`}
                    checked={(picked[qi] ?? []).includes(o.label)}
                    onChange={() => toggle(qi, o.label, !!q.multiSelect)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <span>{o.label}{o.description && <span className="block text-xs text-zinc-500">{o.description}</span>}</span>
                </label>
              ))}
              <input
                value={other[qi] ?? ''}
                onChange={(e) => setOther({ ...other, [qi]: e.target.value })}
                placeholder="Other…"
                aria-label={`Other: ${q.question}`}
                className="mt-2 min-h-11 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
              />
            </fieldset>
          ))}
          <div className="flex gap-2">
            <button disabled={busy || !complete} onClick={() => send({ askId: ask.askId, decision: 'allow', answers: answers() })} className={`${btn} bg-blue-600 text-white hover:bg-blue-500`}><Send size={14} aria-hidden />Send answers</button>
            <button disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'deny' })} className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}><X size={14} aria-hidden />Deny</button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs font-medium text-amber-300"><ShieldAlert size={14} aria-hidden />Permission · {ask.tool}</div>
          <div className="mt-1 font-medium">{ask.summary}</div>
          {ask.detail && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[11px] text-zinc-400">{ask.detail}</pre>}
          <div className="mt-3 flex gap-2">
            <button disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'allow' })} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-500`}><Check size={14} aria-hidden />Allow</button>
            <button disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'deny' })} className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}><X size={14} aria-hidden />Deny</button>
          </div>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
