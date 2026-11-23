import type { SessionInfo } from '../proto.gen'

/** Readable title: the name, or the basename of root/cwd; the short id goes separately. */
export function sessionTitle(s: Pick<SessionInfo, 'id' | 'name' | 'root' | 'cwd'> & { recap?: string }): { title: string; short: string } {
  const short = s.id.slice(0, 8)
  if (s.recap) return { title: s.recap, short }
  if (s.name) return { title: s.name, short }
  const base = (s.root || s.cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return { title: base || short, short }
}
