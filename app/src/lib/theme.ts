import { useCallback, useEffect, useState } from 'react'
import { THEME_COLOR, type ThemeName } from './tokens'

/** The user's choice: follow the OS, or force one theme. Stored per device. */
export type ThemePref = 'system' | 'light' | 'dark'

/** localStorage key; the pre-paint script in index.html reads the same key. */
export const THEME_KEY = 'quorum.theme'
const QUERY = '(prefers-color-scheme: dark)'

/** The choice in effect this page load (null until initTheme or setTheme runs). */
let current: ThemePref | null = null

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

/** Puts the resolved theme on <html> (`.dark`, color-scheme) and the browser chrome colour. */
export function applyTheme(pref: ThemePref = getTheme()): ThemeName {
  const theme = resolveTheme(pref)
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = THEME_COLOR[theme]
  return theme
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

/**
 * Applies the stored theme, follows OS changes while the choice is "system" and follows a choice
 * made in another open tab (`storage` event). Returns a cleanup.
 */
export function initTheme(): () => void {
  current = getTheme()
  applyTheme(current)
  const onStorage = (e: StorageEvent) => {
    if (!themeEvent(e)) return
    current = getTheme()
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
