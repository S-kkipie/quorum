/**
 * Images the owner pasted into the prompt in the terminal. Claude Code stores each one as
 * `<tmp>/claude-<uid>/<project path, dashed>/<session id>/images/<N>.<ext>` and writes
 * `[Image #N]` in the prompt (layout read from the image-preview plugin 0.2.3).
 */

export type PastedImage = { n: number; path: string }
type Entry = { name: string; kind: 'file' | 'dir' | 'other' }

const TOKEN = /\[Image #(\d{1,4})\]/g
// the same names the hub serves (internal/hub/views.go pastedImage)
const FILE = /^(\d{1,4})\.(png|jpg|jpeg|gif|webp)$/

/** A path as Claude Code names its temp folder after it: every non-alphanumeric is a dash. */
export function dashed(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

/** `<tmp>/claude-<uid>/<projectPath dashed>/<sessionId>/images`. */
export function imagesDir(tmpRoot: string, uid: number, projectPath: string, sessionId: string): string {
  return `${tmpRoot.replace(/\/+$/, '')}/claude-${uid}/${dashed(projectPath)}/${sessionId}/images`
}

/** The ids of the `[Image #N]` placeholders in a text, each once, in order. */
export function imageIds(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(TOKEN)) {
    const n = Number(m[1])
    if (!out.includes(n)) out.push(n)
  }
  return out
}

/**
 * Finds the files behind a prompt's `[Image #N]`. `tmpRoot` is CLAUDE_CODE_TMPDIR or /tmp,
 * `uid` the user's id (undefined where there is none, e.g. Windows: the feature is then off);
 * both are asked once. `projects` are the session root and cwd (Claude Code names the folder
 * after one of them). Only regular files (`kind: 'file'`: a symbolic link is `other`) named
 * `<N>.<ext>` count. Never throws.
 */
export function makeImageFinder(deps: {
  tmpRoot: () => Promise<string | undefined>
  uid: () => Promise<number | undefined>
  projects: string[]
  sessionId: () => string
  list: (dir: string) => Promise<Entry[]>
}) {
  let base: Promise<{ tmp: string; uid: number } | undefined> | undefined
  const temp = () => (base ??= (async () => {
    const [tmp, uid] = await Promise.all([deps.tmpRoot(), deps.uid()])
    return Number.isInteger(uid) && (uid as number) >= 0 ? { tmp: tmp || '/tmp', uid: uid as number } : undefined
  })().catch(() => undefined))
  const projects = [...new Set(deps.projects.filter(Boolean))]
  const candidates = async (): Promise<string[]> => {
    const t = await temp()
    const sid = deps.sessionId()
    if (!t || !sid || /[\\/]/.test(sid)) return []
    return projects.map(p => imagesDir(t.tmp, t.uid, p, sid))
  }

  return {
    /** The folder this session's images would be in (root first); '' when unknown. */
    async dir(): Promise<string> {
      return (await candidates().catch(() => []))[0] ?? ''
    },

    /** The images a prompt names that exist on disk, and the folder they are in (`list` may be a later hook's). */
    async find(text: string, list: (dir: string) => Promise<Entry[]> = deps.list): Promise<{ dir: string; images: PastedImage[] }> {
      const ids = imageIds(text)
      if (!ids.length) return { dir: '', images: [] }
      try {
        for (const dir of await candidates()) {
          const entries = await list(dir).catch(() => undefined)
          if (!entries) continue
          const byId = new Map<number, string>()
          for (const e of entries) {
            const m = e.kind === 'file' ? FILE.exec(e.name) : null
            if (m && !byId.has(Number(m[1]))) byId.set(Number(m[1]), e.name)
          }
          const images = ids.filter(n => byId.has(n)).map(n => ({ n, path: `${dir}/${byId.get(n)}` }))
          return { dir, images }
        }
      } catch { /* never reaches the hook */ }
      return { dir: '', images: [] }
    },
  }
}
