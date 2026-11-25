import { useCallback, useEffect, useState } from 'react'
import { isHex } from './color'
import { ACCENT_VARS, DEFAULT_PALETTE, PALETTE_BG, isPaletteId, type PaletteId } from './palette-ids'
import type { ThemeName } from './tokens'

/** The user's choice: follow the OS, or force one theme. Stored per device. */
export type ThemePref = 'system' | 'light' | 'dark'

/** localStorage key; the pre-paint script in index.html reads the same key. */
export const THEME_KEY = 'quorum.theme'
const QUERY = '(prefers-color-scheme: dark)'

/** localStorage key for the palette: `{id, accent?, vars?}` (vars: the derived inline variables per theme, for the pre-paint script). */
export const PALETTE_KEY = 'quorum.palette'

/** A preset, optionally with a custom accent on top of it. */
export type PaletteChoice = { id: PaletteId; accent?: string }

/** Inline variables per theme for a custom accent (set by palettes.ts `setPalette`). */
type AccentVars = Record<ThemeName, Record<string, string>>

/** What is stored under PALETTE_KEY. */
export type StoredPalette = PaletteChoice & { vars?: AccentVars }

/** The choices in effect this page load (null until initTheme or a setter runs). */
let current: ThemePref | null = null
let palette: StoredPalette | null = null

function isPref(v: unknown): v is ThemePref {
  return v === 'system' || v === 'light' || v === 'dark'
}

export function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return isPref(v) ? v : 'system'
  } catch { return 'system' }
}

function systemDark(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia(QUERY).matches } catch { return false }
}

/** The theme actually shown for a choice. */
export function resolveTheme(pref: ThemePref = getTheme()): ThemeName {
  if (pref === 'system') return systemDark() ? 'dark' : 'light'
  return pref
}

function validVars(v: unknown): AccentVars | null {
  if (!v || typeof v !== 'object') return null
  const out = {} as AccentVars
  for (const t of ['light', 'dark'] as const) {
    const src = (v as Record<string, unknown>)[t] as Record<string, unknown> | undefined
    out[t] = {}
    for (const k of ACCENT_VARS) {
      const c = src?.[k]
      if (!isHex(c)) return null
      out[t][k] = c
    }
  }
  return out
}

/** The stored palette with its custom accent variables; Terminal green when none (or an unreadable one) is stored. */
function readPalette(): StoredPalette {
  try {
    const v = JSON.parse(localStorage.getItem(PALETTE_KEY) || 'null')
    if (!v || !isPaletteId(v.id)) return { id: DEFAULT_PALETTE }
    const vars = isHex(v.accent) ? validVars(v.vars) : null
    return vars ? { id: v.id, accent: v.accent.toUpperCase(), vars } : { id: v.id }
  } catch { return { id: DEFAULT_PALETTE } }
}

/** The stored palette choice (a preset, and a custom accent when one is set). */
export function getPalette(): PaletteChoice {
  const { id, accent } = readPalette()
  return accent ? { id, accent } : { id }
}

/** The palette choice in effect this page load, or null before initTheme or a setter runs. */
export function currentPalette(): PaletteChoice | null {
  if (!palette) return null
  return palette.accent ? { id: palette.id, accent: palette.accent } : { id: palette.id }
}

/** Puts a palette on <html> for a theme: `data-palette`, a custom accent's inline variables and the chrome colour. */
function applyPalette(p: StoredPalette, theme: ThemeName): void {
  const root = document.documentElement
  root.setAttribute('data-palette', p.id)
  const vars = p.accent && p.vars ? p.vars[theme] : null
  // the dark values too, for a .dark box inside a light page (the terminal screen; see index.css)
  const dark = p.accent && p.vars ? p.vars.dark : null
  for (const k of ACCENT_VARS) {
    if (vars) root.style.setProperty(k, vars[k])
    else root.style.removeProperty(k)
    if (dark) root.style.setProperty(`${k}-dark`, dark[k])
    else root.style.removeProperty(`${k}-dark`)
  }
  root.toggleAttribute('data-accent', !!dark)
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = PALETTE_BG[p.id][theme === 'dark' ? 1 : 0]
}

/** Puts the resolved theme on <html> (`.dark`, color-scheme) with the palette in effect and the browser chrome colour. */
export function applyTheme(pref: ThemePref = getTheme()): ThemeName {
  const theme = resolveTheme(pref)
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
  applyPalette(palette ?? readPalette(), theme)
  return theme
}

/**
 * Stores and applies a palette record (palettes.ts `setPalette` derives a custom accent's variables
 * first). The default preset with no accent is stored as nothing. Blocked storage keeps the choice
 * until reload.
 */
export function storePalette(p: StoredPalette): void {
  const vars = p.accent && isHex(p.accent) ? validVars(p.vars) : null
  const rec: StoredPalette = vars ? { id: p.id, accent: p.accent!.toUpperCase(), vars } : { id: p.id }
  try {
    if (rec.id === DEFAULT_PALETTE && !rec.accent) localStorage.removeItem(PALETTE_KEY)
    else localStorage.setItem(PALETTE_KEY, JSON.stringify(rec))
  } catch { /* storage blocked: the choice lasts until reload */ }
  palette = rec
  applyTheme(current ?? getTheme())
}

export function setTheme(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch { /* storage blocked: the choice lasts until reload */ }
  current = pref
  applyTheme(pref)
}

/** True for a `storage` event that may change the theme choice (its key, or storage cleared). */
function themeEvent(e: StorageEvent): boolean {
  return e.key === THEME_KEY || e.key === null
}

/** True for a `storage` event that may change the palette. */
export function paletteEvent(e: StorageEvent): boolean {
  return e.key === PALETTE_KEY || e.key === null
}

/**
 * Applies the stored theme and palette, follows OS changes while the choice is "system" and follows
 * a choice made in another open tab (`storage` event). Returns a cleanup.
 */
export function initTheme(): () => void {
  current = getTheme()
  palette = readPalette()
  applyTheme(current)
  const onStorage = (e: StorageEvent) => {
    if (!themeEvent(e) && !paletteEvent(e)) return
    current = getTheme()
    palette = readPalette()
    applyTheme(current)
  }
  window.addEventListener('storage', onStorage)
  const offStorage = () => window.removeEventListener('storage', onStorage)
  if (typeof matchMedia !== 'function') return offStorage
  let mq: MediaQueryList
  try { mq = matchMedia(QUERY) } catch { return offStorage }
  const onChange = () => { if ((current ?? getTheme()) === 'system') applyTheme('system') }
  mq.addEventListener('change', onChange)
  return () => { offStorage(); mq.removeEventListener('change', onChange) }
}

/** The theme choice for a settings control. */
export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => current ?? getTheme())
  const set = useCallback((p: ThemePref) => { setTheme(p); setPref(p) }, [])
  // a choice made in another tab shows here too
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (themeEvent(e)) setPref(getTheme()) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return [pref, set]
}
