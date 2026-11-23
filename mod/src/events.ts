import type { Link } from './link'

export const ERROR_ANSWER =
  '⚠️ Claude devolvió un error (sesión vencida, límite de uso o fallo de la API). Revísalo en la terminal.'

const TOOL_OUTPUT_MAX = 4000
const AGENT_ANSWER_MAX = 2000
const TURN_ANSWER_MAX = 40_000

/** Resumen de una línea de la llamada a una herramienta. */
export function summarize(tool: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined)
  const key =
    tool === 'Bash' ? 'command'
    : tool === 'Read' || tool === 'Write' || tool === 'Edit' ? 'file_path'
    : tool === 'Grep' || tool === 'Glob' ? 'pattern'
    : tool === 'WebFetch' ? 'url'
    : ''
  if (key) {
    const v = pick(key)
    if (v !== undefined) return v
  }
  let out = ''
  for (const [k, v] of Object.entries(o)) {
    if (k === 'tool' || k === 'tool_use_id' || k === 'agentId') continue
    const part = `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`
    out = out ? `${out} ${part}` : part
    if (out.length >= 120) break
  }
  return out.slice(0, 120)
}

type Chunk = { kind: string; text?: string; name?: string; id?: string }
type Call = { tool: string; tool_use_id: string; agentId?: string; [k: string]: unknown }
type Done = {
  answer: string
  reason?: string
  isAborted?: boolean
  agentId?: string
  usage?: { output_tokens?: number }
}

/**
 * Manejadores puros de los hooks de sesión. `getLink` se consulta en cada llamada
 * (el Link nace en session.start); `turnComplete` recibe `getPct` para el porcentaje de contexto.
 * `opts.fromDevice(text)` dice (y consume) si el prompt vino del dispositivo: su
 * `user` ya lo emitió el control, así que turnStart no lo repite.
 * Nada aquí lanza ni espera algo lento.
 */
export function makeHandlers(
  getLink: () => Link | undefined,
  opts: { fromDevice?: (text: string) => boolean } = {},
) {
  const safe = (fn: (l: Link) => void): void => {
    try {
      const l = getLink()
      if (l) fn(l)
    } catch { /* un fallo de eventos no debe llegar a Claude Code */ }
  }
  const full = (l: Link) => l.role !== 'service'
  const tag = (agent: string | undefined, d: Record<string, unknown>) => (agent ? { agent, ...d } : d)
  const status = (l: Link, state: 'working' | 'idle') => {
    l.emit({ kind: 'status', data: { state } })
    l.update({ state })
  }

  return {
    turnStart(e: { text: string; agentId?: string }): void {
      if (e.agentId !== undefined) return
      safe(l => {
        if (full(l)) {
          l.emit({ kind: 'turn_start', data: {} })
          if (!opts.fromDevice?.(e.text)) l.emit({ kind: 'user', data: { text: e.text } })
        }
        status(l, 'working')
      })
    },

    /** Observa un chunk de turn.step; `st` es el estado del paso en curso. */
    chunk(e: { agentId?: string }, c: Chunk, st: StepState): void {
      safe(l => {
        if (!full(l)) return
        const agent = e.agentId
        if (c.kind === 'thinking') {
          if (!st.thinking) l.emit({ kind: 'thinking', data: tag(agent, { text: '' }) })
          st.thinking = true
          return
        }
        st.thinking = false
        if (c.kind === 'text' && c.text) {
          st.text += c.text
          l.emit({ kind: 'assistant_delta', data: tag(agent, { text: c.text }) })
        }
      })
    },

    stepEnd(e: { agentId?: string }, st: StepState): void {
      safe(l => {
        if (full(l) && st.text.trim()) {
          l.emit({ kind: 'assistant', data: tag(e.agentId, { text: st.text.slice(0, TURN_ANSWER_MAX) }) })
        }
      })
    },

    toolStart(e: Call): void {
      safe(l => {
        if (!full(l)) return
        l.emit({ kind: 'tool_start', data: tag(e.agentId, { id: e.tool_use_id, name: e.tool, summary: summarize(e.tool, e) }) })
      })
    },

    toolEnd(e: Call, r: { isError?: boolean; deny?: string; text?: string; result?: unknown } | undefined, ms: number): void {
      safe(l => {
        if (!full(l)) return
        let output = ''
        if (r?.deny !== undefined) output = String(r.deny)
        else if (typeof r?.text === 'string') output = r.text
        else if (r?.result !== undefined) output = typeof r.result === 'string' ? r.result : JSON.stringify(r.result) ?? ''
        l.emit({
          kind: 'tool_end',
          data: tag(e.agentId, { id: e.tool_use_id, ok: !(r?.isError || r?.deny !== undefined), ms, output: output.slice(0, TOOL_OUTPUT_MAX) }),
        })
      })
    },

    agentSpawn(e: { subagentType?: string; description?: string }, r: { agentId?: string } | undefined): void {
      safe(l => {
        if (!full(l) || !r?.agentId) return
        l.emit({ kind: 'agent_start', data: { id: r.agentId, type: e.subagentType ?? '', description: e.description ?? '' } })
      })
    },

    turnComplete(e: Done, getPct?: () => Promise<number | undefined>): void {
      safe(l => {
        if (e.agentId !== undefined) {
          if (!full(l)) return
          const status = e.isAborted ? 'killed' : e.reason === 'error' ? 'error' : 'completed'
          l.emit({ kind: 'agent_end', data: { id: e.agentId, status, answer: (e.answer ?? '').slice(0, AGENT_ANSWER_MAX) } })
          return
        }
        if (full(l)) {
          const answer = e.reason === 'error' && !(e.answer ?? '').trim() ? ERROR_ANSWER : (e.answer ?? '')
          l.emit({
            kind: 'turn_end',
            data: { answer: answer.slice(0, TURN_ANSWER_MAX), reason: e.reason ?? 'answer', outputTokens: e.usage?.output_tokens ?? 0 },
          })
        }
        status(l, 'idle')
        if (full(l) && getPct) {
          void getPct().then(p => {
            if (typeof p === 'number') safe(l2 => l2.update({ contextPct: p }))
          }, () => {})
        }
      })
    },
  }
}

export type StepState = { text: string; thinking: boolean }
export const newStep = (): StepState => ({ text: '', thinking: false })

/**
 * Porcentaje de contexto de `$.session.usage().context`: `percent` si existe;
 * si no, round(100 * tokens / window) cuando hay ambos; si no, undefined.
 */
export function contextPct(u: { context?: { percent?: number; tokens?: number; window?: number } } | undefined): number | undefined {
  const c = u?.context
  if (!c) return undefined
  if (typeof c.percent === 'number') return Math.max(0, Math.min(100, Math.round(c.percent)))
  if (typeof c.tokens === 'number' && c.window) return Math.max(0, Math.min(100, Math.round((100 * c.tokens) / c.window)))
  return undefined
}

type Handlers = ReturnType<typeof makeHandlers>

/**
 * Cuerpo del hook turn.step: reenvía cada chunk y el valor de retorno del flujo
 * interno. Si el consumidor cierra (return) o lanza (throw) el envoltorio, cierra
 * o reenvía al flujo interno y aun así emite el texto parcial del paso.
 */
export async function* stepHook<C extends { kind: string }, R>(
  h: Handlers,
  e: { agentId?: string },
  stream: AsyncGenerator<C, R>,
): AsyncGenerator<C, R> {
  const st = newStep()
  let finished = false // el generador interno terminó o falló: nada que cerrar
  try {
    while (true) {
      let r: IteratorResult<C, R>
      try {
        r = await stream.next()
      } catch (err) {
        finished = true
        throw err
      }
      if (r.done) {
        finished = true
        return r.value
      }
      h.chunk(e, r.value, st)
      try {
        yield r.value
      } catch (err) {
        // el flujo interno decide; si no lanza, se relanza igual
        let res: IteratorResult<C, R>
        try {
          res = await stream.throw(err)
        } catch (err2) {
          finished = true
          throw err2
        }
        // si se recuperó y sigue suspendido en un yield, el finally lo cierra
        if (res.done) finished = true
        throw err
      }
    }
  } finally {
    h.stepEnd(e, st)
    if (!finished) await stream.return(undefined as never).catch(() => {})
  }
}

/**
 * La llamada no la hizo el modelo sino un mod: un `$.ui.ask` (que el engine corre como
 * tool.call de AskUserQuestion, p. ej. el diálogo de permiso de Quorum) o un `$.tool.call`.
 * No se refleja en los dispositivos (ni fila de herramienta ni tarjeta de pregunta).
 * `next.origin` dice quién la causó; sin él (builds viejos), el id `toolu_plugin_…` del engine.
 */
export function fromPlugin(origin: { plugin?: string } | undefined, e: { tool_use_id?: unknown }): boolean {
  if (origin?.plugin !== undefined && origin.plugin !== 'engine') return true
  return typeof e.tool_use_id === 'string' && e.tool_use_id.startsWith('toolu_plugin_')
}

/** Cuerpo del hook tool.call: tool_start, llama, tool_end (también si lanza). */
export async function toolHook<R>(h: Handlers, e: Call, run: () => Promise<R>): Promise<R> {
  h.toolStart(e)
  const t0 = Date.now()
  let r: R
  try {
    r = await run()
  } catch (err) {
    h.toolEnd(e, { isError: true, text: String((err as Error)?.message ?? err) }, Date.now() - t0)
    throw err
  }
  h.toolEnd(e, r as never, Date.now() - t0)
  return r
}
