const MAX_LEN = 60
const IN_MAX = 2000
const CTX_MSGS = 6
const CTX_MSG_RUNES = 600
const CTX_TOTAL_RUNES = 4000
const MIN_GAP_MS = 5 * 60_000
const TIMEOUT_MS = 8000

const INSTRUCTION =
  'Resume en una frase de máximo 8 palabras, en español, en qué está trabajando esta sesión de programación. Solo la frase. Si no puedes saberlo con el contexto dado, responde exactamente `-`.'

const NON_ANSWER = [
  /no hay (suficiente )?contexto/, /sin contexto/, /contexto insuficiente/, /no (est[aá]|queda|es) claro/,
  /no se puede (determinar|saber|decir)/, /^no (lo )?s[eé]($|[^a-záéíóú])/, /no puedo (determinar|saber)/, /no tengo (suficiente|contexto)/,
  /no context/, /\bunclear\b/, /cannot determine/, /can'?t (tell|determine)/, /not enough/, /i don'?t know/, /insufficient/,
]

const runes = (s: string): string[] => Array.from(s)
const trimRunes = (s: string, n: number): string => { const r = runes(s); return r.length > n ? r.slice(0, n).join('') : s }

export type CtxMsg = { role: string; text: string }

/** Contexto reciente: últimos mensajes con texto, cada uno ≤ 600 runas, total ≤ 4000, el más nuevo al final. */
export function buildContext(msgs: readonly CtxMsg[]): string {
  const recent = msgs
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-CTX_MSGS)
    .map(m => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${trimRunes(m.text.trim(), CTX_MSG_RUNES)}`)
  // si pasa del total, se descartan los más viejos
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

/** ¿Es una no-respuesta ("-", vacío, "no hay contexto"…)? */
export function isNonAnswer(s: string): boolean {
  const t = s.trim().toLowerCase()
  if (!t || /^[-–—_.\s]+$/.test(t)) return true
  return NON_ANSWER.some(re => re.test(t))
}

/** Deja la frase del modelo lista para usar de nombre: sin comillas, punto final ni saltos; ≤ 60. */
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
  /** Límite de espera por generación (ms). */
  timeoutMs?: number
  /** Mensajes recientes del hilo principal; si falta o falla, se usa último prompt + respuesta. */
  messages?: () => Promise<readonly CtxMsg[]>
}

/**
 * Genera el recap de la sesión (nombre corto) sin bloquear nada: todo es
 * fire-and-forget y cualquier fallo se ignora.
 */
export class Recap {
  private lastGen = -Infinity
  private busy = false
  /** El turno en curso ya está cubierto por la generación del primer prompt. */
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
      try { ctx = buildContext((await this.deps.messages?.()) ?? []) } catch { /* sin contexto: cae al fallback */ }
      const text = ctx
        ? `${INSTRUCTION}\n\nConversación reciente (lo más nuevo al final):\n${ctx}`
        : `${INSTRUCTION}\n\nÚltimo mensaje del usuario:\n${prompt.slice(0, IN_MAX)}\n\nRespuesta:\n${answer.slice(0, IN_MAX)}`
      const limit = this.deps.sleep(this.deps.timeoutMs ?? TIMEOUT_MS).then((): string => { throw new Error('timeout') })
      const raw = await Promise.race([this.deps.complete(text), limit])
      const out = cleanRecap(raw)
      if (out && !isNonAnswer(out)) this.deps.update(out)
    } catch {
      // sin recap: el nombre cae al de la carpeta
    } finally {
      this.busy = false
    }
  }
}
