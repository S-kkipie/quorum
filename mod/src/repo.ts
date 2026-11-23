import { optional } from './compat'

/** Strips user/token from a URL with a scheme; credentials are never sent to the hub. */
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
  /** `$.session.repo()`; may not exist in this build. */
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

/** Remote and branch of the session's repo; empty if there is none or it fails. Never throws. */
export async function detectRepo(deps: RepoDeps, root: string): Promise<RepoInfo> {
  if (!root) return { repoUrl: '', branch: '' }
  const repo = await optional(() => deps.repo(), undefined)
  let repoUrl = typeof repo?.remote === 'string' ? repo.remote : ''
  if (!repoUrl) repoUrl = await git(deps, root, ['remote', 'get-url', 'origin'])
  return { repoUrl: stripUserinfo(repoUrl), branch: await currentBranch(deps, root) }
}

/** Refreshes the branch at most once per `everyMs`; calls `onChange` only if it changed. */
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
