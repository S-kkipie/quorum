import { optional } from './compat'

/** Quita usuario/token de una URL con esquema; nunca se envían credenciales al hub. */
export function stripUserinfo(u: string): string {
  let v = u.trim()
  const q = v.search(/[?#]/)
  if (q >= 0) v = v.slice(0, q)
  const i = v.indexOf('://')
  if (i < 0) return v
  const rest = v.slice(i + 3)
  return v.slice(0, i + 3) + rest.slice(rest.lastIndexOf('@') + 1)
}

export type RepoInfo = { repoUrl: string; branch: string }

export type RepoDeps = {
  /** `$.session.repo()`; puede no existir en este build. */
  repo: () => Promise<{ remote: string | null } | null> | { remote: string | null } | null
  /** `$.process.run(argv, { timeoutMs: 3000 })`. */
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>
}

async function git(deps: RepoDeps, root: string, args: string[]): Promise<string> {
  const r = await optional(() => deps.run(['git', '-C', root, ...args]), undefined)
  return r && r.exitCode === 0 ? String(r.stdout ?? '').trim() : ''
}

export function currentBranch(deps: RepoDeps, root: string): Promise<string> {
  return git(deps, root, ['branch', '--show-current'])
}

/** Remoto y rama del repo de la sesión; vacíos si no hay o falla. Nunca lanza. */
export async function detectRepo(deps: RepoDeps, root: string): Promise<RepoInfo> {
  if (!root) return { repoUrl: '', branch: '' }
  const repo = await optional(() => deps.repo(), undefined)
  let repoUrl = typeof repo?.remote === 'string' ? repo.remote : ''
  if (!repoUrl) repoUrl = await git(deps, root, ['remote', 'get-url', 'origin'])
  return { repoUrl: stripUserinfo(repoUrl), branch: await currentBranch(deps, root) }
}

/** Refresca la rama a lo sumo una vez por `everyMs`; llama a `onChange` solo si cambió. */
export function makeBranchRefresher(deps: RepoDeps, root: string, onChange: (branch: string) => void, now: () => number, everyMs = 60_000) {
  let last = -Infinity
  let known: string | undefined
  return {
    seed(branch: string) { known = branch; last = now() },
    async refresh(): Promise<void> {
      const t = now()
      if (!root || t - last < everyMs) return
      last = t
      const b = await currentBranch(deps, root)
      if (b && b !== known) { known = b; onChange(b) }
    },
  }
}
