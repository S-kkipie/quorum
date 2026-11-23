const MAX_LEN = 60
const IN_MAX = 2000
const MIN_GAP_MS = 5 * 60_000
const TIMEOUT_MS = 8000

const INSTRUCTION =
  'Resume en una frase de máximo 8 palabras, en español, en qué está trabajando esta sesión de programación. Solo la frase.'

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
    const text = `${INSTRUCTION}\n\nÚltimo mensaje del usuario:\n${prompt.slice(0, IN_MAX)}\n\nRespuesta:\n${answer.slice(0, IN_MAX)}`
    void this.run(text)
  }

  private async run(text: string): Promise<void> {
    try {
      const limit = this.deps.sleep(this.deps.timeoutMs ?? TIMEOUT_MS).then((): string => { throw new Error('timeout') })
      const raw = await Promise.race([this.deps.complete(text), limit])
      const out = cleanRecap(raw)
      if (out) this.deps.update(out)
    } catch {
      // sin recap: el nombre cae al de la carpeta
    } finally {
      this.busy = false
    }
  }
}
