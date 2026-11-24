// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import html from '../../index.html?raw'
import { THEME_KEY, applyTheme, getTheme, initTheme, resolveTheme, setTheme } from './theme'
import { THEME_COLOR } from './tokens'

let dark = false
let listeners: (() => void)[] = []

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() { return q === '(prefers-color-scheme: dark)' && dark },
    media: q,
    addEventListener: (_: string, fn: () => void) => { listeners.push(fn) },
    removeEventListener: (_: string, fn: () => void) => { listeners = listeners.filter((l) => l !== fn) },
  }))
}
const osChanges = (d: boolean) => { dark = d; listeners.forEach((l) => l()) }
const meta = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content')
const isDark = () => document.documentElement.classList.contains('dark')

beforeEach(() => {
  dark = false
  listeners = []
  localStorage.clear()
  document.documentElement.className = ''
  document.head.innerHTML = '<meta name="theme-color" content="#000000">'
  stubMatchMedia()
})
afterEach(() => { vi.unstubAllGlobals() })

describe('theme', () => {
  it('defaults to system and follows prefers-color-scheme', () => {
    expect(getTheme()).toBe('system')
    expect(resolveTheme()).toBe('light')
    dark = true
    expect(resolveTheme()).toBe('dark')
  })

  it('applies .dark, color-scheme and the theme-color meta', () => {
    expect(applyTheme('dark')).toBe('dark')
    expect(isDark()).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(meta()).toBe(THEME_COLOR.dark)
    applyTheme('light')
    expect(isDark()).toBe(false)
    expect(meta()).toBe(THEME_COLOR.light)
  })

  it('setTheme stores the choice; system clears it', () => {
    setTheme('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(getTheme()).toBe('dark')
    expect(isDark()).toBe(true)
    setTheme('system')
    expect(localStorage.getItem(THEME_KEY)).toBeNull()
    expect(isDark()).toBe(false)
  })

  it('ignores a corrupt stored value', () => {
    localStorage.setItem(THEME_KEY, 'sepia')
    expect(getTheme()).toBe('system')
  })

  it('tracks OS changes only while the choice is system', () => {
    const stop = initTheme()
    expect(isDark()).toBe(false)
    osChanges(true)
    expect(isDark()).toBe(true)
    expect(meta()).toBe(THEME_COLOR.dark)
    setTheme('light')
    expect(isDark()).toBe(false)
    osChanges(false); osChanges(true)
    expect(isDark()).toBe(false)
    stop()
    expect(listeners).toHaveLength(0)
  })

  it('follows a theme change made in another tab', () => {
    const stop = initTheme()
    expect(isDark()).toBe(false)
    localStorage.setItem(THEME_KEY, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'dark' }))
    expect(isDark()).toBe(true)
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }))
    expect(isDark()).toBe(true)
    localStorage.removeItem(THEME_KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: null }))
    expect(isDark()).toBe(false)
    stop()
    localStorage.setItem(THEME_KEY, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'dark' }))
    expect(isDark()).toBe(false)
  })

  it('survives blocked storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(getTheme()).toBe('system')
    expect(() => setTheme('dark')).not.toThrow()
    expect(isDark()).toBe(true)
    vi.restoreAllMocks()
  })
})

describe('pre-paint script in index.html', () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''
  const run = () => new Function(script)()

  it('uses the same storage key and theme colours', () => {
    expect(script).toContain(`'${THEME_KEY}'`)
    expect(script).toContain(THEME_COLOR.light)
    expect(script).toContain(THEME_COLOR.dark)
    expect(html).toContain('name="color-scheme" content="light dark"')
  })

  it('sets dark before paint from the OS or the stored choice', () => {
    dark = true
    run()
    expect(isDark()).toBe(true)
    expect(meta()).toBe(THEME_COLOR.dark)
    document.documentElement.className = ''
    localStorage.setItem(THEME_KEY, 'light')
    run()
    expect(isDark()).toBe(false)
    expect(meta()).toBe(THEME_COLOR.light)
    dark = false
    localStorage.setItem(THEME_KEY, 'dark')
    run()
    expect(isDark()).toBe(true)
  })
})
