import { useRef, useState } from 'react'
import {
  Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest, ConfirmationTitle,
} from '@/components/ai-elements/confirmation'
import { Check, ChevronDown, ChevronUp, MessageCircleQuestion, Send, ShieldAlert, X } from 'lucide-react'
import { decide } from '../lib/api'
import { useDraft } from '../lib/drafts'
import type { Ask } from '../proto.gen'

interface Q { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }

function parseQuestions(raw: unknown): Q[] {
  let v: unknown = raw
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return [] } }
  if (v && !Array.isArray(v) && Array.isArray((v as any).questions)) v = (v as any).questions
  return Array.isArray(v) ? (v as Q[]) : []
}

function parseOther(raw: string): Record<number, string> {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

const CLAMP_LINES = 8
const CLAMP_CHARS = 600

// Long command/prompt text: clamped to 8 lines with a toggle so the action buttons stay in view.
function ClampedText({ text, className = '', as: Tag = 'div' }: { text: string; className?: string; as?: 'div' | 'pre' }) {
  const [open, setOpen] = useState(false)
  const long = text.split('\n').length > CLAMP_LINES || text.length > CLAMP_CHARS
  return (
    <>
      <Tag className={`whitespace-pre-wrap font-mono [overflow-wrap:anywhere] ${long ? (open ? 'max-h-[50dvh] overflow-auto' : 'line-clamp-8') : ''} ${className}`}>{text}</Tag>
      {long && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="mt-1 flex min-h-11 items-center gap-1 text-xs font-medium text-accent hover:underline">
          {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}{open ? 'Show less' : 'Show all'}
        </button>
      )}
    </>
  )
}

export default function AskCard({ session, ask, onDone }: { session: string; ask: Ask; onDone?: () => void }) {
  const questions = ask.kind === 'question' ? parseQuestions(ask.questions) : []
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [otherRaw, setOtherRaw, clearOther] = useDraft(`ask.${ask.askId}`)
  const other = parseOther(otherRaw)
  const setOther = (o: Record<number, string>) => setOtherRaw(JSON.stringify(o))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [gone, setGone] = useState(false)
  // permission: the decision that was accepted; the first choice wins
  const [decided, setDecided] = useState<'allow' | 'deny' | ''>('')
  const inflight = useRef(false)

  async function send(body: Parameters<typeof decide>[1]) {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setError('')
    try {
      await decide(session, body)
      clearOther()
      if (ask.kind !== 'question') setDecided(body.decision as 'allow' | 'deny')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error'
      if (/already answered/i.test(msg)) {
        setGone(true)
        setTimeout(() => onDone?.(), 2000)
      } else setError(msg)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }

  if (gone) return <div className="mx-3 my-2 rounded-xl border border-line bg-surface p-3 text-xs text-muted-foreground">already answered</div>

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

  const btn = 'press flex min-h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-medium disabled:opacity-40'
  return (
    <div className="mx-3 my-2 rounded-xl border border-accent bg-surface p-3 text-sm text-ink">
      {ask.kind === 'question' ? (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-accent"><MessageCircleQuestion size={14} aria-hidden />Question</div>
          {questions.map((q, qi) => (
            <fieldset key={qi} className="mb-3">
              {q.header && <div className="text-xs font-medium text-muted-foreground">{q.header}</div>}
              <legend className="w-full font-medium"><ClampedText text={q.question} className="font-sans" /></legend>
              {(q.options ?? []).map((o) => (
                <label key={o.label} className="mt-1 flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-chip">
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`q${qi}`}
                    checked={(picked[qi] ?? []).includes(o.label)}
                    onChange={() => toggle(qi, o.label, !!q.multiSelect)}
                    className="mt-0.5 accent-accent"
                  />
                  <span>{o.label}{o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}</span>
                </label>
              ))}
              <input
                value={other[qi] ?? ''}
                onChange={(e) => setOther({ ...other, [qi]: e.target.value })}
                placeholder="Other…"
                aria-label={`Other: ${q.question}`}
                className="mt-2 min-h-11 w-full rounded-lg border border-line bg-background px-3 text-sm placeholder:text-muted-foreground focus:border-accent focus:outline-none"
              />
            </fieldset>
          ))}
          <div className="flex gap-2">
            <button disabled={busy || !complete} onClick={() => send({ askId: ask.askId, decision: 'allow', answers: answers() })} className={`${btn} bg-accent text-on-accent hover:bg-accent/90`}><Send size={14} aria-hidden />Send answers</button>
            <button disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'deny' })} className={`${btn} bg-chip text-ink hover:bg-line`}><X size={14} aria-hidden />Deny</button>
          </div>
        </>
      ) : (
        <Confirmation
          approval={decided ? { id: ask.askId, approved: decided === 'allow' } : { id: ask.askId }}
          state={decided ? 'approval-responded' : 'approval-requested'}
          role="group" aria-label="Permission request"
          className="block border-0 bg-transparent p-0 text-ink"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-accent"><ShieldAlert size={14} aria-hidden />Permission · {ask.tool}</div>
          <ConfirmationTitle className="mt-1 block font-medium text-ink"><ClampedText text={ask.summary} className="font-sans" /></ConfirmationTitle>
          <ConfirmationRequest>
            {ask.detail && <ClampedText as="pre" text={ask.detail} className="mt-2 rounded-lg bg-chip p-2.5 text-xs text-muted-foreground" />}
          </ConfirmationRequest>
          <ConfirmationAccepted><p className="mt-2 flex items-center gap-1.5 text-xs text-success"><Check size={14} aria-hidden />Allowed</p></ConfirmationAccepted>
          <ConfirmationRejected><p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><X size={14} aria-hidden />Denied</p></ConfirmationRejected>
          <ConfirmationActions className="sticky bottom-0 -mx-3 -mb-3 mt-3 justify-start self-stretch rounded-b-xl border-t border-line bg-surface p-3">
            <ConfirmationAction disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'allow' })} className={`${btn} h-auto bg-accent text-on-accent hover:bg-accent/90`}><Check size={14} aria-hidden />Allow</ConfirmationAction>
            <ConfirmationAction disabled={busy} onClick={() => send({ askId: ask.askId, decision: 'deny' })} className={`${btn} h-auto bg-chip text-ink hover:bg-line`}><X size={14} aria-hidden />Deny</ConfirmationAction>
          </ConfirmationActions>
        </Confirmation>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  )
}
