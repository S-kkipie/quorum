import { contrast, luminance } from './color'
import { DEFAULT_PALETTE, presetTokens, type PaletteId } from './palettes'

export { contrast, luminance }

/**
 * Colour tokens, mirrored from src/index.css (a test checks the two stay in sync) so the WCAG contrast
 * of every text-on-background pair the app uses can be computed in a unit test, for every palette.
 * A palette (lib/palettes.ts) sets the surface and accent tokens; BASE holds the rest, shared by all
 * palettes, so states read the same in any palette.
 */
export type ThemeName = 'light' | 'dark'

/** Shared per theme: fixed state colours, success / warning / danger and the diff tints. */
export const BASE = {
  // nudged for AA on every palette's chip and sidebar: needs #B45309 -> #AD5009, working #2563EB ->
  // #2060EB, done #15803D -> #14793A (success, warning and add use the same values)
  light: {
    success: '#14793A',
    warning: '#AD5009',
    danger: '#B3261E',
    'on-danger': '#FFFFFF',
    'state-needs': '#AD5009',
    'state-needs-soft': '#FDF0E0',
    'state-working': '#2060EB',
    'state-working-soft': '#E8EFFD',
    'state-background': '#7C3AED',
    'state-background-soft': '#F1EAFD',
    'state-done': '#14793A',
    'state-done-soft': '#E5F3EA',
    add: '#14793A',
    'add-soft': '#E5F3EA',
    del: '#B3261E',
    'del-soft': '#FAE8E6',
  },
  dark: {
    success: '#4ADE80',
    warning: '#F2A93B',
    danger: '#F08A80',
    'on-danger': '#2A0F0C',
    'state-needs': '#F2A93B',
    'state-needs-soft': '#3A2C17',
    'state-working': '#60A5FA',
    'state-working-soft': '#172A45',
    'state-background': '#B794F6',
    'state-background-soft': '#2C2340',
    'state-done': '#4ADE80',
    'state-done-soft': '#16301F',
    add: '#4ADE80',
    'add-soft': '#16301F',
    del: '#F08A80',
    'del-soft': '#3A2220',
  },
} as const

/** Every token for a palette and theme. Idle and closed states follow the palette's muted text. */
export function tokensFor(id: PaletteId, theme: ThemeName) {
  const p = presetTokens(id, theme)
  return {
    ...p,
    ...BASE[theme],
    'state-idle': p['muted-foreground'],
    'state-idle-soft': p.chip,
    'state-closed': p['muted-foreground'],
    'state-closed-soft': p.background,
  }
}

export type TokenSet = ReturnType<typeof tokensFor>
export type Token = keyof TokenSet

/** The default palette's tokens. */
export const TOKENS: Record<ThemeName, TokenSet> = { light: tokensFor(DEFAULT_PALETTE, 'light'), dark: tokensFor(DEFAULT_PALETTE, 'dark') }

/** The default palette's browser chrome colour per theme. */
export const THEME_COLOR: Record<ThemeName, string> = { light: TOKENS.light.background, dark: TOKENS.dark.background }

const STATES = ['needs', 'working', 'background', 'done', 'idle', 'closed'] as const

/** Text-on-background pairs the app renders, as [text, background]. Body text: 4.5:1 (AA). */
export const TEXT_PAIRS: [Token, Token][] = [
  ...(['ink', 'muted-foreground', 'accent'] as const).flatMap((t) =>
    (['background', 'sidebar', 'surface', 'chip', 'bubble', 'accent-soft'] as const).map((b) => [t, b] as [Token, Token])),
  ['on-accent', 'accent'],
  ['on-danger', 'danger'],
  ...(['success', 'warning', 'danger'] as const).flatMap((t) =>
    (['background', 'surface', 'chip'] as const).map((b) => [t, b] as [Token, Token])),
  ...STATES.flatMap((s) => [
    [`state-${s}`, `state-${s}-soft`],
    [`state-${s}`, 'background'],
    [`state-${s}`, 'surface'],
    [`state-${s}`, 'sidebar'],
  ] as [Token, Token][]),
  ['add', 'add-soft'], ['add', 'surface'], ['add', 'background'],
  ['del', 'del-soft'], ['del', 'surface'], ['del', 'background'],
  // session view (Plan 9 Task 2): state icons and tool tints on chip fills, diffs inside tool
  // rows (code area = chip), diff and pill text in ink, and meta text on diff lines
  ...STATES.map((s) => [`state-${s}`, 'chip'] as [Token, Token]),
  ...STATES.map((s) => ['ink', `state-${s}-soft`] as [Token, Token]),
  ['add', 'chip'], ['del', 'chip'],
  ['ink', 'add-soft'], ['ink', 'del-soft'],
  ['muted-foreground', 'add-soft'], ['muted-foreground', 'del-soft'],
  ['danger', 'del-soft'], ['success', 'add-soft'],
]

/**
 * Shiki themes for code blocks, [light, dark]: both are loaded on demand with the highlighter and the
 * page switches between them with the `.dark` class (CSS variables), so a theme change needs no
 * re-highlight. Their token colours meet AA on CODE_BG (tested).
 */
export const CODE_THEMES = ['github-light-default', 'github-dark-default'] as const
/** The background code blocks are drawn on. */
export const CODE_BG: Token = 'surface'

/** Non-text UI pairs (focus ring, state dots, accent buttons on the page): 3:1. */
export const UI_PAIRS: [Token, Token][] = [
  ['accent', 'background'], ['accent', 'surface'], ['accent', 'sidebar'],
  ...STATES.map((s) => [`state-${s}`, 'surface'] as [Token, Token]),
]
