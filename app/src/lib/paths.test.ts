import { describe, it, expect } from 'vitest'
import { findPaths } from './paths'

const B = '/home/u/app'
describe('findPaths', () => {
  it('finds relative and absolute paths under base', () => {
    const t = 'Edited src/auth/google.ts and /home/u/app/README.md'
    const r = findPaths(t, B)
    expect(r.map((x) => x.path)).toEqual(['/home/u/app/src/auth/google.ts', '/home/u/app/README.md'])
    expect(t.slice(r[0].start, r[0].end)).toBe('src/auth/google.ts')
    expect(t.slice(r[1].start, r[1].end)).toBe('/home/u/app/README.md')
  })
  it('resolves ./ and ignores URLs, outside paths, no-extension and no-slash words', () => {
    expect(findPaths('see ./docs/x.md', B).map((x) => x.path)).toEqual(['/home/u/app/docs/x.md'])
    expect(findPaths('https://x.dev/a.ts', B)).toEqual([])
    expect(findPaths('/etc/passwd and /etc/a.conf', B)).toEqual([])
    expect(findPaths('../other/a.ts', B)).toEqual([])
    expect(findPaths('and/or src/dir and a.ts', B)).toEqual([])
  })
  it('excludes trailing punctuation and keeps a :line suffix out of the path', () => {
    const t = 'Look at (src/a/google.ts.) then src/b.go:42, ok'
    const r = findPaths(t, B)
    expect(r.map((x) => x.path)).toEqual(['/home/u/app/src/a/google.ts', '/home/u/app/src/b.go'])
    expect(t.slice(r[0].start, r[0].end)).toBe('src/a/google.ts')
  })
  it('absolute paths in a git worktree of the session are found; relative ones still join the base', () => {
    const W = ['/home/u/app', '/home/u/app-rewrite']
    const t = 'See /home/u/app-rewrite/docs/decisions/x.md and docs/y.md, not /home/u/app-old/z.md'
    expect(findPaths(t, B, W).map((x) => x.path)).toEqual(['/home/u/app-rewrite/docs/decisions/x.md', '/home/u/app/docs/y.md'])
    expect(findPaths('/home/u/app-rewrite/a.md', B)).toEqual([])
  })
  it('returns nothing without a base', () => {
    expect(findPaths('src/a.ts', '')).toEqual([])
  })
})
