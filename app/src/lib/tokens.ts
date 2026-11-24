/**
 * "Quiet paper" colour tokens, mirrored from src/index.css (a test checks the two stay in sync) so the
 * WCAG contrast of every text-on-background pair the app uses can be computed in a unit test.
 */
export type ThemeName = 'light' | 'dark'

export const TOKENS = {
  light: {
    background: '#FAF9F6',
    surface: '#FFFFFF',
    ink: '#1D1C1A',
    'muted-foreground': '#6E6A64',
    line: '#E8E5DF',
    chip: '#F1EFEA',
    bubble: '#EEECE7',
    accent: '#1F5F5B',
    'on-accent': '#FFFFFF',
    'accent-soft': '#E6F0EE',
    success: '#2B784B',
    warning: '#A15C07',
    danger: '#B3261E',
    'on-danger': '#FFFFFF',
    'state-needs': '#A15C07',
    'state-needs-soft': '#F8EEDF',
    'state-working': '#1F5F5B',
    'state-working-soft': '#E6F0EE',
    'state-background': '#6B4FA0',
    'state-background-soft': '#EFEAF6',
    'state-done': '#2B784B',
    'state-done-soft': '#E5F1E9',
    'state-idle': '#6E6A64',
    'state-idle-soft': '#F1EFEA',
    'state-closed': '#6E6A64',
    'state-closed-soft': '#FAF9F6',
    add: '#2B784B',
    'add-soft': '#E5F1E9',
    del: '#B3261E',
    'del-soft': '#FAE8E6',
  },
  dark: {
    background: '#1B1A18',
    surface: '#232220',
    ink: '#ECEAE5',
    'muted-foreground': '#A19D96',
    line: '#33312E',
    chip: '#2C2A27',
    bubble: '#2E2C29',
    accent: '#6FB8B1',
    'on-accent': '#0F1F1E',
    'accent-soft': '#22312F',
    success: '#7CC497',
    warning: '#E3A857',
    danger: '#F08A80',
    'on-danger': '#2A0F0C',
    'state-needs': '#E3A857',
    'state-needs-soft': '#352A1C',
    'state-working': '#6FB8B1',
    'state-working-soft': '#22312F',
    'state-background': '#B49BE0',
    'state-background-soft': '#2D2738',
    'state-done': '#7CC497',
    'state-done-soft': '#213027',
    'state-idle': '#A19D96',
    'state-idle-soft': '#2C2A27',
    'state-closed': '#A19D96',
    'state-closed-soft': '#1B1A18',
    add: '#7CC497',
    'add-soft': '#1F2F24',
    del: '#F08A80',
    'del-soft': '#3A2220',
  },
} as const

export type Token = keyof typeof TOKENS.light

/** Browser chrome colour (`<meta name="theme-color">`) per theme: the page background. */
export const THEME_COLOR: Record<ThemeName, string> = { light: TOKENS.light.background, dark: TOKENS.dark.background }

const STATES = ['needs', 'working', 'background', 'done', 'idle', 'closed'] as const

/** Text-on-background pairs the app renders, as [text, background]. Body text: 4.5:1 (AA). */
export const TEXT_PAIRS: [Token, Token][] = [
  ...(['ink', 'muted-foreground', 'accent'] as const).flatMap((t) =>
    (['background', 'surface', 'chip', 'bubble', 'accent-soft'] as const).map((b) => [t, b] as [Token, Token])),
  ['on-accent', 'accent'],
  ['on-danger', 'danger'],
  ...(['success', 'warning', 'danger'] as const).flatMap((t) =>
    (['background', 'surface', 'chip'] as const).map((b) => [t, b] as [Token, Token])),
  ...STATES.flatMap((s) => [
    [`state-${s}`, `state-${s}-soft`],
    [`state-${s}`, 'background'],
    [`state-${s}`, 'surface'],
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
  ['accent', 'background'], ['accent', 'surface'],
  ...STATES.map((s) => [`state-${s}`, 'surface'] as [Token, Token]),
]

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

/** WCAG contrast ratio between two #RRGGBB colours (1–21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
