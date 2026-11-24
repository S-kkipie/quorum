import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { bundledThemes } from 'shiki/themes'
import { CODE_BG, CODE_THEMES, TEXT_PAIRS, TOKENS, UI_PAIRS, contrast, type ThemeName } from './tokens'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/** `--name: #hex;` declarations inside the first block opened by `selector {`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  expect(start, `${selector} block in index.css`).toBeGreaterThanOrEqual(0)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2].toUpperCase()]))
}

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5)
    expect(contrast('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2)
  })
})

describe.each(['light', 'dark'] as ThemeName[])('%s theme', (theme) => {
  const t = TOKENS[theme]

  it.each(TEXT_PAIRS)('%s on %s meets AA (4.5:1)', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(UI_PAIRS)('%s against %s meets 3:1 for UI', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3)
  })

  it('index.css declares the same values', () => {
    const declared = block(theme === 'light' ? ':root' : '.dark')
    for (const [name, value] of Object.entries(t)) expect(declared[name], `--${name}`).toBe(value.toUpperCase())
  })
})

describe('code block themes', () => {
  it.each([['light', CODE_THEMES[0]], ['dark', CODE_THEMES[1]]] as [ThemeName, keyof typeof bundledThemes][])(
    '%s: every %s token colour meets AA on the code block background', async (theme, name) => {
      const t = (await bundledThemes[name]()).default as { fg?: string; colors?: Record<string, string>; tokenColors?: { scope?: unknown; settings?: { foreground?: string } }[] }
      const bg = TOKENS[theme][CODE_BG]
      const fgs = new Set<string>([t.colors?.['editor.foreground'] ?? t.fg ?? ''].filter(Boolean))
      for (const r of t.tokenColors ?? []) {
        const f = r.settings?.foreground
        // a few scopes (carriage-return, markup.ignored) paint a light colour on their own token background: skip those
        if (f && /^#[0-9a-f]{6}$/i.test(f) && contrast(f, bg) > 1.5) fgs.add(f)
      }
      expect(fgs.size).toBeGreaterThan(3)
      for (const f of fgs) expect(contrast(f, bg), `${name} ${f} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    })
})
