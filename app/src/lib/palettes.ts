import { useCallback, useEffect, useState } from 'react'
import { contrast, isHex, mix, nudgeLightness } from './color'
import type { PaletteId } from './palette-ids'
import { currentPalette, getPalette, paletteEvent, storePalette, type PaletteChoice } from './theme'
import type { ThemeName } from './tokens'

export { ACCENT_VARS, DEFAULT_PALETTE, PALETTE_BG, PALETTE_IDS, isPaletteId, type PaletteId } from './palette-ids'

/**
 * Colour palettes (Plan 12). Each preset sets only the surface and accent tokens below, per theme; the
 * state colours and success/danger/diff tokens come from a shared base per theme (BASE in tokens.ts),
 * so a state reads the same in every palette. Values are copied from the design mockup; a value that
 * failed the WCAG AA table in tokens.test.ts was nudged minimally in lightness and carries a note.
 * src/index.css declares the same values under `[data-palette=…]` (tokens.test.ts checks they match).
 * This module is only loaded with the palette settings (and tests); the app applies a stored palette
 * through theme.ts and palette-ids.ts.
 */

/** The tokens a preset sets. */
export type Tokens = {
  background: string
  sidebar: string
  surface: string
  ink: string
  'muted-foreground': string
  line: string
  chip: string
  bubble: string
  accent: string
  'on-accent': string
}

export type Palette = { name: string; description: string; light: Tokens; dark: Tokens }

export const PALETTES: Record<PaletteId, Palette> = {
  'terminal-green': {
    name: 'Terminal green',
    description: 'Near-black slate with a green accent, a nod to the terminal.',
    // nudged for AA: accent #0E8A55 -> #0C7548, muted-foreground #5F6B64 -> #5D6861
    light: { background: '#F7F8F7', sidebar: '#EFF2F0', surface: '#FFFFFF', ink: '#111814', 'muted-foreground': '#5D6861', line: '#E0E6E2', chip: '#EAEFEC', bubble: '#E6EEE9', accent: '#0C7548', 'on-accent': '#FFFFFF' },
    dark: { background: '#0E1311', sidebar: '#0A0E0C', surface: '#161C19', ink: '#E3ECE7', 'muted-foreground': '#8FA198', line: '#24302A', chip: '#1D2622', bubble: '#1F2A25', accent: '#3DDC97', 'on-accent': '#06140D' },
  },
  graphite: {
    name: 'Graphite',
    description: 'Cool greys, cobalt accent. Precise, developer tool.',
    // nudged for AA: muted-foreground #646B75 -> #5F6670
    light: { background: '#F6F7F8', sidebar: '#EEF0F2', surface: '#FFFFFF', ink: '#16181C', 'muted-foreground': '#5F6670', line: '#E2E5E9', chip: '#EDEFF2', bubble: '#E9ECF0', accent: '#2D55C8', 'on-accent': '#FFFFFF' },
    dark: { background: '#16181B', sidebar: '#121417', surface: '#1E2125', ink: '#E8EAED', 'muted-foreground': '#9AA1AB', line: '#2C3035', chip: '#262A2F', bubble: '#262A30', accent: '#7C9BF0', 'on-accent': '#0E1426' },
  },
  mono: {
    name: 'Mono',
    description: 'Pure black and white; the accent is the ink itself.',
    light: { background: '#FFFFFF', sidebar: '#FAFAFA', surface: '#FFFFFF', ink: '#0A0A0A', 'muted-foreground': '#6B6B6B', line: '#EAEAEA', chip: '#F2F2F2', bubble: '#F2F2F2', accent: '#0A0A0A', 'on-accent': '#FFFFFF' },
    // nudged for AA: muted-foreground #8F8F8F -> #929292
    dark: { background: '#0A0A0A', sidebar: '#000000', surface: '#141414', ink: '#EDEDED', 'muted-foreground': '#929292', line: '#262626', chip: '#1C1C1C', bubble: '#1F1F1F', accent: '#EDEDED', 'on-accent': '#0A0A0A' },
  },
  violet: {
    name: 'Violet',
    description: 'Neutral zinc with an electric violet accent.',
    // nudged for AA: accent #6D4AFF -> #6540FF, muted-foreground #71717A -> #67676F
    light: { background: '#FAFAFA', sidebar: '#F4F4F5', surface: '#FFFFFF', ink: '#18181B', 'muted-foreground': '#67676F', line: '#E4E4E7', chip: '#F1F1F3', bubble: '#EFEEF6', accent: '#6540FF', 'on-accent': '#FFFFFF' },
    dark: { background: '#111113', sidebar: '#0C0C0E', surface: '#19191C', ink: '#ECECEF', 'muted-foreground': '#A1A1AA', line: '#27272A', chip: '#222226', bubble: '#24222E', accent: '#A38BFF', 'on-accent': '#140C33' },
  },
  midnight: {
    name: 'Midnight',
    description: 'Deep navy and blue-grey, cyan accent. Calm, night-friendly.',
    // nudged for AA: accent #0B7BB8 -> #0A6BA0, muted-foreground #5B6B80 -> #58677C
    light: { background: '#F5F7FA', sidebar: '#EDF1F6', surface: '#FFFFFF', ink: '#0F1B2D', 'muted-foreground': '#58677C', line: '#DDE4EE', chip: '#E8EDF4', bubble: '#E4EBF4', accent: '#0A6BA0', 'on-accent': '#FFFFFF' },
    dark: { background: '#0B1220', sidebar: '#080E1A', surface: '#111A2B', ink: '#E2E8F2', 'muted-foreground': '#8D9BB0', line: '#1E2A3E', chip: '#18233A', bubble: '#1A2740', accent: '#4CC3F0', 'on-accent': '#04131D' },
  },
  ember: {
    name: 'Ember',
    description: 'Warm charcoal with an amber orange accent.',
    // nudged for AA: accent #C2570C -> #A84B0A, muted-foreground #6F675D -> #6C645B
    light: { background: '#FAF8F5', sidebar: '#F3F0EB', surface: '#FFFFFF', ink: '#1C1915', 'muted-foreground': '#6C645B', line: '#E7E1D8', chip: '#F0EBE4', bubble: '#EFE9E1', accent: '#A84B0A', 'on-accent': '#FFFFFF' },
    dark: { background: '#161412', sidebar: '#110F0D', surface: '#1F1C19', ink: '#EEE8E1', 'muted-foreground': '#A39A8F', line: '#302B26', chip: '#29251F', bubble: '#2C2722', accent: '#F59E42', 'on-accent': '#1E0F02' },
  },
  'quiet-paper': {
    name: 'Quiet paper',
    description: 'Warm paper with a deep teal accent.',
    // nudged for AA: muted-foreground #6E6A64 -> #6A6660
    light: { background: '#FAF9F6', sidebar: '#F4F2EE', surface: '#FFFFFF', ink: '#1D1C1A', 'muted-foreground': '#6A6660', line: '#E8E5DF', chip: '#F1EFEA', bubble: '#EEECE7', accent: '#1F5F5B', 'on-accent': '#FFFFFF' },
    dark: { background: '#1B1A18', sidebar: '#171614', surface: '#232220', ink: '#ECEAE5', 'muted-foreground': '#A19D96', line: '#33312E', chip: '#2C2A27', bubble: '#2E2C29', accent: '#6FB8B1', 'on-accent': '#0F1F1E' },
  },
}

/** How much accent goes into `accent-soft` (mixed into the page background). */
const SOFT: Record<ThemeName, number> = { light: 0.12, dark: 0.16 }

/** The soft accent fill (selected rows, pills) for an accent on a base. */
export function accentSoft(accent: string, theme: ThemeName, base: Tokens): string {
  return mix(accent, base.background, SOFT[theme])
}

/** A preset's tokens plus its derived `accent-soft`. In Mono the accent is the ink, so the soft fill is the chip. */
export function presetTokens(id: PaletteId, theme: ThemeName): Tokens & { 'accent-soft': string } {
  const t = PALETTES[id][theme]
  return { ...t, 'accent-soft': id === 'mono' ? t.chip : accentSoft(t.accent, theme, t) }
}

/** The fills accent-coloured text is drawn on, besides `accent-soft`. */
export const ACCENT_TEXT_ON = ['background', 'sidebar', 'surface', 'chip', 'bubble'] as const

export type DerivedAccent = { accent: string; onAccent: string; accentSoft: string; ring: string }

/**
 * Tokens for a custom accent on a base palette. The accent is moved away from the page in lightness
 * (darker in light, lighter in dark) until it is text-safe: 4.5:1 against every fill it colours text
 * on (which also gives the 3:1 UI contrast against the background). `onAccent` is black or white,
 * whichever contrasts more; the soft fill and the focus ring follow the nudged accent.
 */
export function deriveAccent(accent: string, theme: ThemeName, base: Tokens): DerivedAccent {
  const ok = (c: string) => {
    const fills = [...ACCENT_TEXT_ON.map((k) => base[k]), accentSoft(c, theme, base)]
    return fills.every((f) => contrast(c, f) >= 4.5)
  }
  const a = nudgeLightness(accent, theme === 'light' ? -1 : 1, ok)
  const onAccent = contrast(a, '#000000') >= contrast(a, '#FFFFFF') ? '#000000' : '#FFFFFF'
  return { accent: a, onAccent, accentSoft: accentSoft(a, theme, base), ring: a }
}

/** The CSS variables a custom accent sets inline on <html>. */
export function accentVars(d: DerivedAccent): Record<string, string> {
  return { '--accent': d.accent, '--on-accent': d.onAccent, '--accent-soft': d.accentSoft, '--ring': d.ring }
}

/**
 * Stores and applies a palette. A custom accent is stored with its derived variables for both themes,
 * so the pre-paint script (and theme changes later) apply them with no flash and no re-derivation.
 */
export function setPalette(p: PaletteChoice): void {
  if (!(p.accent && isHex(p.accent))) { storePalette({ id: p.id }); return }
  const accent = p.accent.toUpperCase()
  const vars = (t: ThemeName) => accentVars(deriveAccent(accent, t, PALETTES[p.id][t]))
  storePalette({ id: p.id, accent, vars: { light: vars('light'), dark: vars('dark') } })
}

/** The palette choice for a settings control (follows a choice made in another tab). */
export function usePalette(): [PaletteChoice, (p: PaletteChoice) => void] {
  const [choice, setChoice] = useState<PaletteChoice>(() => currentPalette() ?? getPalette())
  const set = useCallback((p: PaletteChoice) => { setPalette(p); setChoice(currentPalette() ?? p) }, [])
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (paletteEvent(e)) setChoice(getPalette()) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return [choice, set]
}
