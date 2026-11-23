type Spawn = (argv: string[]) => AsyncIterable<unknown>
/**
 * KeepAlive de una sesión. `spawn` lanza `quorumd hold` con el `$` del hook que
 * espera (solo un `$` del propio hook para su reloj); sin él, `HoldDeps.spawn`.
 */
export type Hold = (until: Promise<unknown>, spawn?: Spawn) => void

export const HOLD_WARNING = 'Quorum no pudo esperar a los dispositivos (quorumd hold no disponible); responde aquí'

export type HoldDeps = {
  /** spawn por defecto (cuando el hook no presta el suyo). */
  spawn: Spawn
  /** Aviso al dispositivo (evento info). */
  info(text: string): void
  /** Línea de depuración en la UI. */
  debug(msg: string): void
}

/**
 * KeepAlive que sostiene la espera con `quorumd hold`. Si hold no arranca o termina
 * antes de que haya decisión (quorumd viejo, spawn no disponible) avisa una sola vez
 * por instancia: la espera sigue sin sostén y el permiso se responde en la terminal.
 */
export function makeHold(d: HoldDeps): Hold {
  let warned = false
  const failed = (why: string) => {
    if (warned) return
    warned = true
    try { d.info(HOLD_WARNING) } catch { /* nunca hacia Claude Code */ }
    try { d.debug(`quorum: quorumd hold ${why}`) } catch { /* idem */ }
  }
  return (until, spawn = d.spawn) => {
    const it = spawn(['quorumd', 'hold'])[Symbol.asyncIterator]()
    let settled = false
    const fin = () => { settled = true; return { done: true as const, value: undefined } }
    const done = until.then(fin, fin)
    void (async () => {
      try {
        for (;;) if ((await Promise.race([it.next(), done])).done) break
        if (!settled) failed('terminó antes de tiempo')
      } catch (err) {
        if (!settled) failed(`no arrancó: ${String((err as Error)?.message ?? err)}`)
      } finally {
        void Promise.resolve(it.return?.(undefined as never)).catch(() => {})
      }
    })()
  }
}
