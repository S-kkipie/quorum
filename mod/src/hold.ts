type Spawn = (argv: string[]) => AsyncIterable<unknown>
/**
 * KeepAlive of a session. `spawn` launches `quorumd hold` with the `$` of the hook that
 * waits (only a `$` owned by the hook itself counts for its clock); without it, `HoldDeps.spawn`.
 */
export type Hold = (until: Promise<unknown>, spawn?: Spawn) => void

export const HOLD_WARNING = 'Quorum could not wait for devices (quorumd hold unavailable); answer here'

export type HoldDeps = {
  /** Default spawn (when the hook does not lend its own). */
  spawn: Spawn
  /** Notice to the device (info event). */
  info(text: string): void
  /** Debug line in the UI. */
  debug(msg: string): void
}

/**
 * KeepAlive that sustains the wait with `quorumd hold`. If hold fails to start or ends
 * before a decision is made (old quorumd, spawn unavailable) it warns once per
 * instance: the wait continues unsupported and the permission is answered in the terminal.
 */
export function makeHold(d: HoldDeps): Hold {
  let warned = false
  const failed = (why: string) => {
    if (warned) return
    warned = true
    try { d.info(HOLD_WARNING) } catch { /* never toward Claude Code */ }
    try { d.debug(`quorum: quorumd hold ${why}`) } catch { /* same */ }
  }
  return (until, spawn = d.spawn) => {
    const it = spawn(['quorumd', 'hold'])[Symbol.asyncIterator]()
    let settled = false
    const fin = () => { settled = true; return { done: true as const, value: undefined } }
    const done = until.then(fin, fin)
    void (async () => {
      try {
        for (;;) if ((await Promise.race([it.next(), done])).done) break
        if (!settled) failed('ended early')
      } catch (err) {
        if (!settled) failed(`failed to start: ${String((err as Error)?.message ?? err)}`)
      } finally {
        void Promise.resolve(it.return?.(undefined as never)).catch(() => {})
      }
    })()
  }
}
