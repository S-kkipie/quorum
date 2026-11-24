import { absPath, inBase } from './timeline'

export type PathMatch = { start: number; end: number; path: string }

// A candidate is a run of characters that can belong to a path; brackets, quotes and spaces end it.
const TOKEN = /[^\s`'"()<>[\]{},;|*]+/g
const LINE_SUFFIX = /:\d+(?::\d+)?$/
const FILE_EXT = /\.[A-Za-z][A-Za-z0-9]{0,9}$/

/**
 * Paths in prose that point at a file inside `base`: absolute ones, and relative ones with a `/`
 * and an extension (`src/a.ts`, `./docs/x.md`), resolved against `base`. URLs, paths outside
 * `base`, bare words and `..` escapes are ignored. `start`/`end` cover the text as written
 * (without trailing punctuation or a `:line` suffix).
 */
export function findPaths(text: string, base: string): PathMatch[] {
  const out: PathMatch[] = []
  if (!base || !text) return out
  for (const m of text.matchAll(TOKEN)) {
    let tok = m[0]
    const start = m.index!
    if (tok.includes('://') || !tok.includes('/')) continue
    tok = tok.replace(/[.,:!?]+$/, '').replace(LINE_SUFFIX, '').replace(/[.,:!?]+$/, '')
    if (!tok.includes('/') || !FILE_EXT.test(tok) || tok.endsWith('/')) continue
    const path = absPath(tok, base)
    if (!inBase(path, base)) continue
    out.push({ start, end: start + tok.length, path })
  }
  return out
}
