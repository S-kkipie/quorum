const MAX_LEN = 60
const IN_MAX = 2000
const CTX_MSGS = 6
const CTX_MSG_RUNES = 600
const CTX_TOTAL_RUNES = 4000
const MIN_GAP_MS = 5 * 60_000
const TIMEOUT_MS = 8000

const INSTRUCTION =
  'Summarize in a short English phrase (at most 60 characters, no quotes, no trailing period) what this programming session is working on. Only the phrase. If you cannot tell from the given context, answer exactly `-`.'

// Non-answers in English and Spanish (the model may still answer in either language).
const NON_ANSWER = [
  /no hay (suficiente )?contexto/, /sin contexto/, /contexto insuficiente/, /no (est[aá]|queda|es) claro/,
  /no se puede (determinar|saber|decir)/, /^no (lo )?s[eé]($|[^a-záéíóú])/, /no puedo (determinar|saber)/, /no tengo (suficiente|contexto)/,
  /no context/, /\bunclear\b/, /cannot (determine|tell)/, /can'?t (tell|determine)/, /not enough/, /i don'?t know/, /i'?m not sure/,
  /insufficient/, /^unknown$/, /^no (information|info)\b/, /^n\/?a$/, /^not (clear|possible)/, /^unable to/,
]

const runes = (s: string): string[] => Array.from(s)
const trimRunes = (s: string, n: number): string => { const r = runes(s); return r.length > n ? r.slice(0, n).join('') : s }

export type CtxMsg = { role: string; text: string }

/** Recent context: last messages with text, each ≤ 600 runes, total ≤ 4000, newest last. */
export function buildContext(msgs: readonly CtxMsg[]): string {
  const recent = msgs
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-CTX_MSGS)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${trimRunes(m.text.trim(), CTX_MSG_RUNES)}`)
  // if over the total, the oldest are dropped
  let total = 0
  const kept: string[] = []
  for (let i = recent.length - 1; i >= 0; i--) {
    const len = runes(recent[i]!).length + 2
    if (total + len > CTX_TOTAL_RUNES) {
      if (kept.length === 0) kept.push(trimRunes(recent[i]!, CTX_TOTAL_RUNES))
      break
    }
    total += len
    kept.unshift(recent[i]!)
  }
  return kept.join('\n\n')
}

/** Is it a non-answer ("-", empty, "no context"...)? */
export function isNonAnswer(s: string): boolean {
  const t = s.trim().toLowerCase()
  if (!t || /^[-–—_.\s]+$/.test(t)) return true
  return NON_ANSWER.some(re => re.test(t))
}

/** Leaves the model's phrase ready to use as a name: no quotes, trailing period or line breaks; ≤ 60. */
export function cleanRecap(raw: string): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  s = s.replace(/^["'“”‘’«»`]+|["'“”‘’«»`]+$/g, '').trim()
  s = s.replace(/[.。]+$/, '').trim()
  if (s.length > MAX_LEN) {
    const cut = s.slice(0, MAX_LEN + 1)
    const sp = cut.lastIndexOf(' ')
    s = (sp > 0 ? cut.slice(0, sp) : cut.slice(0, MAX_LEN)).trim()
  }
  return s
}

export type RecapDeps = {
  complete: (prompt: string) => Promise<string>
  now: () => number
  update: (recap: string) => void
  sleep: (ms: number) => Promise<void>
  /** Wait limit per generation (ms). */
  timeoutMs?: number
  /** Recent messages of the main thread; if missing or failing, last prompt + answer is used. */
  messages?: () => Promise<readonly CtxMsg[]>
}

/**
 * Generates the session recap (short name) without blocking anything: everything is
 * fire-and-forget and any failure is ignored.
 */
export class Recap {
  private lastGen = -Infinity
  private busy = false
  /** The current turn is already covered by the first-prompt generation. */
  private covered = false

  constructor(private deps: RecapDeps) {}

  onFirstPrompt(text: string): void {
    this.covered = true
    this.generate(text, '')
  }

  onTurnEnd(lastPrompt: string, answer: string): void {
    if (this.covered) { this.covered = false; return }
    if (this.deps.now() - this.lastGen < MIN_GAP_MS) return
    this.generate(lastPrompt, answer)
  }

  private generate(prompt: string, answer: string): void {
    if (this.busy) return
    this.busy = true
    this.lastGen = this.deps.now()
    void this.run(prompt, answer)
  }

  private async run(prompt: string, answer: string): Promise<void> {
    try {
      let ctx = ''
      try {
        const msgs = [...((await this.deps.messages?.()) ?? [])]
        // the prompt (and answer) that trigger the recap always go in the context
        const lastOf = (role: string) => msgs.filter(m => m.role === role && m.text?.trim()).at(-1)?.text.trim()
        if (prompt.trim() && msgs.length && lastOf('user') !== prompt.trim()) msgs.push({ role: 'user', text: prompt })
        if (answer.trim() && msgs.length && lastOf('assistant') !== answer.trim()) msgs.push({ role: 'assistant', text: answer })
        ctx = buildContext(msgs)
      } catch { /* no context: falls back */ }
      const text = ctx
        ? `${INSTRUCTION}\n\nRecent conversation (newest last):\n${ctx}`
        : `${INSTRUCTION}\n\nLast user message:\n${prompt.slice(0, IN_MAX)}\n\nAnswer:\n${answer.slice(0, IN_MAX)}`
      const limit = this.deps.sleep(this.deps.timeoutMs ?? TIMEOUT_MS).then((): string => { throw new Error('timeout') })
      const raw = await Promise.race([this.deps.complete(text), limit])
      const out = cleanRecap(raw)
      if (out && !isNonAnswer(out)) this.deps.update(out)
    } catch {
      // no recap: the name falls back to the folder name
    } finally {
      this.busy = false
    }
  }
}
