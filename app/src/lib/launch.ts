import type { Envelope } from '../proto.gen'
import { launch } from './api'

export interface Prefs { machine?: string; bypass: boolean }
const key = (projectId: string) => 'quorum.launch.' + projectId

/** Preferencias de lanzamiento por proyecto; "Sin permisos" viene activado por defecto. */
export function loadPrefs(projectId: string): Prefs {
  try {
    const j = JSON.parse(localStorage.getItem(key(projectId)) ?? 'null')
    if (j && typeof j === 'object') {
      return { ...(typeof j.machine === 'string' && j.machine ? { machine: j.machine } : {}), bypass: j.bypass !== false }
    }
  } catch { /* sin datos o ilegibles */ }
  return { bypass: true }
}
export function savePrefs(projectId: string, p: Prefs) {
  try { localStorage.setItem(key(projectId), JSON.stringify(p)) } catch { /* ignorar */ }
}

/** Lanzamiento en curso, mientras la app espera que la sesión nueva se registre. */
export type Pending = { reqId: string; machine: string; label: string; startedAt: number; pane?: string; error?: string }
export const LAUNCH_TIMEOUT_MS = 60000

export function pendingReducer(p: Pending | null, env: Envelope, _now: number): { pending: Pending | null; open?: string } {
  if (!p) return { pending: null }
  const pl = env.payload
  if (!pl || pl.reqId !== p.reqId) return { pending: p }
  if (env.type === 'launch_session') return { pending: null, open: pl.sessionId }
  if (env.type === 'launch_result') {
    if (!pl.ok) return { pending: { ...p, error: pl.error || 'no se pudo lanzar' } }
    return { pending: { ...p, pane: pl.pane || p.pane } }
  }
  return { pending: p }
}

/**
 * Guarda por reqId los launch_result/launch_session recientes (60 s, como mucho 32):
 * pueden llegar por el WS antes de que el POST /api/launch responda, cuando aún no
 * hay Pending. replay los aplica al Pending recién creado.
 */
export class EarlyLaunches {
  private byReq = new Map<string, { at: number; envs: Envelope[] }>()
  constructor(private max = 32, private ttl = LAUNCH_TIMEOUT_MS) {}
  remember(env: Envelope, now: number) {
    const id = env.payload?.reqId
    if (typeof id !== 'string' || !id) return
    for (const [k, v] of this.byReq) if (now - v.at > this.ttl) this.byReq.delete(k)
    const cur = this.byReq.get(id)
    if (cur) { cur.envs.push(env); return }
    while (this.byReq.size >= this.max) this.byReq.delete(this.byReq.keys().next().value as string)
    this.byReq.set(id, { at: now, envs: [env] })
  }
  /** Aplica a p lo guardado de su reqId (y lo olvida). */
  replay(p: Pending, now: number): { pending: Pending | null; open?: string } {
    const cur = this.byReq.get(p.reqId)
    this.byReq.delete(p.reqId)
    let r: { pending: Pending | null; open?: string } = { pending: p }
    if (!cur || now - cur.at > this.ttl) return r
    for (const e of cur.envs) {
      if (!r.pending) break
      r = pendingReducer(r.pending, e, now)
    }
    return r
  }
}

export const timedOut = (p: Pending, now: number) => now - p.startedAt > LAUNCH_TIMEOUT_MS

/** Lanza en machine+dir con "Sin permisos" (apagado si la máquina corre como root). Un solo camino para tarjeta, conversaciones y menú. */
export async function launchIn(a: { machine: string; dir: string; bypass: boolean; root: boolean; resume?: string; projectId?: string }): Promise<{ reqId: string; machine: string; label: string }> {
  const r = await launch({ machine: a.machine, dir: a.dir, permissionMode: a.bypass && !a.root ? 'bypass' : 'default', ...(a.resume ? { resume: a.resume } : {}), projectId: a.projectId || undefined })
  return { reqId: r.reqId, machine: a.machine, label: a.dir }
}
