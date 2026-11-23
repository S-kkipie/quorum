import type { TermFrame } from '../proto.gen'

/** Última foto de cada terminal (máquina + panel). Fuera del reducer: llegan hasta 8 por segundo. */
const last = new Map<string, TermFrame>()
const at = new Map<string, number>()
const subs = new Map<string, Set<() => void>>()

export const frames = {
  key: (machine: string, pane: string) => `${machine}\x00${pane}`,
  set(machine: string, pane: string, f: TermFrame) {
    const k = frames.key(machine, pane)
    last.set(k, f)
    at.set(k, Date.now())
    subs.get(k)?.forEach((fn) => fn())
  },
  get: (machine: string, pane: string) => last.get(frames.key(machine, pane)),
  /** Cuándo llegó la última foto (ms), para descartar fotos de una visita anterior. */
  receivedAt: (machine: string, pane: string) => at.get(frames.key(machine, pane)) ?? 0,
  subscribe(key: string, fn: () => void) {
    let s = subs.get(key)
    if (!s) subs.set(key, (s = new Set()))
    s.add(fn)
    return () => { s!.delete(fn); if (s!.size === 0) subs.delete(key) }
  },
}
