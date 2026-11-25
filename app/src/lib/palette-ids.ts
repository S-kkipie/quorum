/**
 * The palette facts the app needs before the palette settings load: ids, page backgrounds (for
 * `<meta name="theme-color">`) and the inline variables a custom accent sets. Kept tiny and
 * dependency-free because it is in the initial bundle and in the pre-paint script; the full token
 * values live in palettes.ts (a test checks the backgrounds match).
 */
export type PaletteId = 'terminal-green' | 'graphite' | 'mono' | 'violet' | 'midnight' | 'ember' | 'quiet-paper'

export const DEFAULT_PALETTE: PaletteId = 'terminal-green'

/** Page background per palette, [light, dark], in display order (the default first). */
export const PALETTE_BG: Record<PaletteId, [string, string]> = {
  'terminal-green': ['#F7F8F7', '#0E1311'],
  graphite: ['#F6F7F8', '#16181B'],
  mono: ['#FFFFFF', '#0A0A0A'],
  violet: ['#FAFAFA', '#111113'],
  midnight: ['#F5F7FA', '#0B1220'],
  ember: ['#FAF8F5', '#161412'],
  'quiet-paper': ['#FAF9F6', '#1B1A18'],
}

export const PALETTE_IDS = Object.keys(PALETTE_BG) as PaletteId[]

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PALETTE_BG, v)
}

/** Names of the inline variables a custom accent sets on <html> (the pre-paint script applies only these). */
export const ACCENT_VARS = ['--accent', '--on-accent', '--accent-soft', '--ring'] as const
