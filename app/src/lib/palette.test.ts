import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every colour comes from a semantic token (Plan 9): no Tailwind palette classes (including white and
 * black) and no raw colours (#hex, rgb(), hsl()) in class names anywhere in app/src, except dev/
 * fixtures and tests. Colours that come from data (a workspace's own colour, ANSI colours) go through
 * inline styles and are allowed.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url))
const PALETTE = /(?<![\w-])(?:bg|text|border|ring|ring-offset|divide|fill|stroke|outline|from|to|via|placeholder|accent|caret|decoration|shadow)-(?:(?:zinc|neutral|slate|gray|stone|blue|sky|indigo|violet|purple|fuchsia|pink|rose|red|orange|amber|yellow|lime|green|emerald|teal|cyan)-\d{2,3}|white|black)(?![\w-])/g
/** An arbitrary-value colour utility such as `bg-[#123456]`, `text-[rgb(0,0,0)]` or `border-[hsl(0_0%_0%)]`. */
const RAW_CLASS = /(?<![\w-])[a-z-]+-\[(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()[^\]]*\]/g
/** A className / class attribute string literal (plain, template or braced) on one line. */
const CLASS_ATTR = /class(?:Name)?=\{?["'`]([^"'`]*)["'`]/g

/**
 * Intentional exceptions, by path relative to src, with the exact class allowed there:
 * - dialog/sheet overlays are a black scrim that dims the page in both themes.
 */
const ALLOW: Record<string, string[]> = {
  [join('components', 'ui', 'dialog.tsx')]: ['bg-black/50'],
  [join('components', 'ui', 'sheet.tsx')]: ['bg-black/50'],
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'dev' || name === 'node_modules' ? [] : sources(path)
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}

/** Colour violations in one file's text (each palette class or raw colour found). */
function violations(text: string, allowed: string[] = []): string[] {
  const found = [...text.matchAll(PALETTE), ...text.matchAll(RAW_CLASS)]
    .map((m) => m[0] + (text[m.index! + m[0].length] === '/' ? '/' + (text.slice(m.index! + m[0].length + 1).match(/^\d+/)?.[0] ?? '') : ''))
  for (const m of text.matchAll(CLASS_ATTR)) {
    for (const raw of m[1].match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? []) found.push(raw)
  }
  return found.filter((v) => !allowed.includes(v))
}

/** Walks a source tree (skipping dev/ and tests) and lists `path: violation` lines. */
function scan(root: string, allow: Record<string, string[]> = {}): string[] {
  return sources(root).flatMap((f) => {
    const rel = relative(root, f)
    return violations(readFileSync(f, 'utf8'), allow[rel]).map((v) => `${rel}: ${v}`)
  })
}

describe('design tokens only', () => {
  it('walks app/src without dev/ and tests', () => {
    const files = sources(SRC)
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((f) => f.endsWith('App.tsx'))).toBe(true)
    expect(files.some((f) => f.includes(`${sep}dev${sep}`))).toBe(false)
    expect(files.some((f) => /\.test\./.test(f))).toBe(false)
  })

  it('app/src has no Tailwind palette colour classes or raw colours in class names', () => {
    expect(scan(SRC, ALLOW)).toEqual([])
  })

  it('the allow-list entries still exist (drop them when the class goes away)', () => {
    for (const [rel, classes] of Object.entries(ALLOW)) {
      const text = readFileSync(join(SRC, rel), 'utf8')
      for (const c of classes) expect(text, `${rel} ${c}`).toContain(c)
    }
  })

  it('flags palette, white/black, ring-offset, caret and raw colours; passes tokens', () => {
    expect(violations('className="bg-zinc-900 hover:text-emerald-400"')).toEqual(['bg-zinc-900', 'text-emerald-400'])
    expect(violations('className="border-amber-500/40 ring-white ring-offset-zinc-950 caret-blue-500"')).toEqual(
      ['border-amber-500/40', 'ring-white', 'ring-offset-zinc-950', 'caret-blue-500'])
    expect(violations('className="bg-black/50 text-white"')).toEqual(['bg-black/50', 'text-white'])
    expect(violations('className="bg-[#09090b] text-[rgb(1,2,3)] border-[hsl(0_0%_0%)]"')).toHaveLength(3 + 3)
    expect(violations('className="p-2" data-x="#ff0000"')).toEqual([])
    expect(violations('style={{ background: "#3b82f6" }} className="h-2 w-2"')).toEqual([])
    expect(violations('className="bg-surface text-muted-foreground bg-state-needs-soft ring-offset-surface ring-ink"')).toEqual([])
    expect(violations('className="bg-white"', ['bg-white'])).toEqual([])
  })

  describe('end to end on a planted tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'palette-'))
    afterAll(() => rmSync(root, { recursive: true, force: true }))

    it('reports a planted bg-red-500 and ignores dev/ and tests', () => {
      mkdirSync(join(root, 'components'))
      mkdirSync(join(root, 'dev'))
      writeFileSync(join(root, 'components', 'Bad.tsx'), 'export const B = () => <div className="p-2 bg-red-500" />\n')
      writeFileSync(join(root, 'components', 'Good.tsx'), 'export const G = () => <div className="p-2 bg-surface" style={{ color: "#123456" }} />\n')
      writeFileSync(join(root, 'components', 'Bad.test.tsx'), 'const x = "bg-red-500"\n')
      writeFileSync(join(root, 'dev', 'Fixture.tsx'), 'export const F = () => <div className="bg-blue-600" />\n')
      expect(scan(root)).toEqual([`${join('components', 'Bad.tsx')}: bg-red-500`])
      expect(scan(root, { [join('components', 'Bad.tsx')]: ['bg-red-500'] })).toEqual([])
    })
  })
})
