import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { bundledThemes } from 'shiki/themes'
import { BASE, CODE_BG, CODE_THEMES, TEXT_PAIRS, TOKENS, UI_PAIRS, contrast, tokensFor, type ThemeName } from './tokens'
import { PALETTES, PALETTE_IDS, presetTokens, type PaletteId } from './palettes'

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

const THEMES: ThemeName[] = ['light', 'dark']
const CASES = PALETTE_IDS.flatMap((id) => THEMES.map((theme) => [id, theme] as [PaletteId, ThemeName]))

/** The selector that holds a palette's variables for a theme in index.css. */
function selector(id: PaletteId, theme: ThemeName): string {
  if (id === 'terminal-green') return theme === 'light' ? ':root' : '.dark'
  return theme === 'light' ? `:root[data-palette="${id}"]` : `:root.dark[data-palette="${id}"], :root[data-palette="${id}"] .dark`
}

describe('palettes', () => {
  it('Terminal green is the default and every preset has a name, a description and both themes', () => {
    expect(PALETTE_IDS).toEqual(['terminal-green', 'graphite', 'mono', 'violet', 'midnight', 'ember', 'quiet-paper'])
    expect(TOKENS.light.background).toBe('#F7F8F7')
    expect(TOKENS.dark.background).toBe('#0E1311')
    for (const id of PALETTE_IDS) {
      expect(PALETTES[id].name.length).toBeGreaterThan(0)
      expect(PALETTES[id].description.length).toBeGreaterThan(0)
    }
  })

  it('Quiet paper keeps its sidebar values and Mono uses the chip as its soft accent', () => {
    expect(PALETTES['quiet-paper'].light.sidebar).toBe('#F4F2EE')
    expect(PALETTES['quiet-paper'].dark.sidebar).toBe('#171614')
    for (const t of THEMES) expect(presetTokens('mono', t)['accent-soft']).toBe(PALETTES.mono[t].chip)
  })

  it('state colours are fixed and shared by every palette', () => {
    for (const id of PALETTE_IDS) for (const t of THEMES) {
      const all = tokensFor(id, t)
      for (const s of ['needs', 'working', 'background', 'done'] as const) expect(all[`state-${s}`]).toBe(BASE[t][`state-${s}`])
    }
  })
})

describe.each(CASES)('%s %s', (id, theme) => {
  const t = tokensFor(id, theme)

  it.each(TEXT_PAIRS)('%s on %s meets AA (4.5:1)', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(UI_PAIRS)('%s against %s meets 3:1 for UI', (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3)
  })

  it('index.css declares the same palette values', () => {
    const declared = block(selector(id, theme))
    for (const [name, value] of Object.entries(presetTokens(id, theme))) expect(declared[name], `--${name}`).toBe(value.toUpperCase())
  })
})

describe.each(THEMES)('%s base', (theme) => {
  it('index.css declares the shared base values', () => {
    const declared = block(theme === 'light' ? ':root' : '.dark')
    for (const [name, value] of Object.entries(BASE[theme])) expect(declared[name], `--${name}`).toBe(value.toUpperCase())
  })
})

it('a nested .dark box (the terminal) takes a custom accent from its inline dark values', () => {
  const body = css.slice(css.indexOf(':root[data-accent] .dark {'), css.indexOf('}', css.indexOf(':root[data-accent] .dark {')))
  for (const k of ['accent', 'on-accent', 'accent-soft', 'ring']) expect(body).toContain(`--${k}: var(--${k}-dark);`)
})

it('index.css maps idle and closed to the palette, and exposes the sidebar token', () => {
  expect(css).toMatch(/--state-idle:\s*var\(--muted-foreground\)/)
  expect(css).toMatch(/--state-idle-soft:\s*var\(--chip\)/)
  expect(css).toMatch(/--state-closed:\s*var\(--muted-foreground\)/)
  expect(css).toMatch(/--state-closed-soft:\s*var\(--background\)/)
  expect(css).toMatch(/--color-sidebar:\s*var\(--sidebar\)/)
})

describe('code block themes', () => {
  it.each([['light', CODE_THEMES[0]], ['dark', CODE_THEMES[1]]] as [ThemeName, keyof typeof bundledThemes][])(
    '%s: every %s token colour meets AA on the code block background of every palette', async (theme, name) => {
      const t = (await bundledThemes[name]()).default as { fg?: string; colors?: Record<string, string>; tokenColors?: { scope?: unknown; settings?: { foreground?: string } }[] }
      const fgs = new Set<string>([t.colors?.['editor.foreground'] ?? t.fg ?? ''].filter(Boolean))
      for (const r of t.tokenColors ?? []) {
        const f = r.settings?.foreground
        // a few scopes (carriage-return, markup.ignored) paint a light colour on their own token background: skip those
        if (f && /^#[0-9a-f]{6}$/i.test(f) && contrast(f, TOKENS[theme][CODE_BG]) > 1.5) fgs.add(f)
      }
      expect(fgs.size).toBeGreaterThan(3)
      for (const id of PALETTE_IDS) {
        const bg = tokensFor(id, theme)[CODE_BG]
        for (const f of fgs) expect(contrast(f, bg), `${name} ${f} on ${id} ${bg}`).toBeGreaterThanOrEqual(4.5)
      }
    })
})
