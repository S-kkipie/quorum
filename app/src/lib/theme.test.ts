// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import html from '../../index.html?raw'
import viteConfig from '../../vite.config.ts?raw'
import { PALETTE_KEY, THEME_KEY, applyTheme, getPalette, getTheme, initTheme, resolveTheme, setTheme } from './theme'
import { THEME_COLOR } from './tokens'
import { PALETTES, deriveAccent, setPalette } from './palettes'
import { prePaint, prePaintOptions, prePaintScript } from './prepaint'

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
  document.documentElement.removeAttribute('data-palette')
  document.documentElement.removeAttribute('data-accent')
  document.documentElement.removeAttribute('style')
  document.head.innerHTML = '<meta name="theme-color" content="#000000">'
  stubMatchMedia()
  // the choices in effect are module state: start every test from System and the default palette
  setTheme('system')
  setPalette({ id: 'terminal-green' })
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

const root = document.documentElement
const palette = () => root.getAttribute('data-palette')
const inline = (k: string) => root.style.getPropertyValue(k)

describe('palette', () => {
  it('defaults to Terminal green with no storage', () => {
    expect(getPalette()).toEqual({ id: 'terminal-green' })
    const stop = initTheme()
    expect(palette()).toBe('terminal-green')
    expect(meta()).toBe('#F7F8F7')
    stop()
  })

  it('old storage with only a theme gives Terminal green in that theme', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    const stop = initTheme()
    expect(isDark()).toBe(true)
    expect(palette()).toBe('terminal-green')
    expect(meta()).toBe(PALETTES['terminal-green'].dark.background)
    stop()
  })

  it('setPalette stores a preset, sets data-palette and the theme colour', () => {
    setPalette({ id: 'graphite' })
    expect(palette()).toBe('graphite')
    expect(meta()).toBe(PALETTES.graphite.light.background)
    expect(JSON.parse(localStorage.getItem(PALETTE_KEY)!)).toEqual({ id: 'graphite' })
    expect(getPalette()).toEqual({ id: 'graphite' })
    setTheme('dark')
    expect(meta()).toBe(PALETTES.graphite.dark.background)
  })

  it('a custom accent is applied inline, stored with its derived variables for both themes, and follows the theme', () => {
    setPalette({ id: 'graphite', accent: '#FFF59D' })
    const light = deriveAccent('#FFF59D', 'light', PALETTES.graphite.light)
    const dark = deriveAccent('#FFF59D', 'dark', PALETTES.graphite.dark)
    expect(inline('--accent')).toBe(light.accent)
    expect(inline('--on-accent')).toBe(light.onAccent)
    expect(inline('--accent-soft')).toBe(light.accentSoft)
    expect(inline('--ring')).toBe(light.ring)
    const stored = JSON.parse(localStorage.getItem(PALETTE_KEY)!)
    expect(stored).toMatchObject({ id: 'graphite', accent: '#FFF59D' })
    expect(stored.vars.light['--accent']).toBe(light.accent)
    expect(stored.vars.dark['--accent']).toBe(dark.accent)
    expect(getPalette()).toEqual({ id: 'graphite', accent: '#FFF59D' })
    // the dark values are set too, for the terminal's .dark box inside a light page
    expect(root.hasAttribute('data-accent')).toBe(true)
    expect(inline('--accent-dark')).toBe(dark.accent)
    expect(inline('--on-accent-dark')).toBe(dark.onAccent)
    expect(inline('--accent-soft-dark')).toBe(dark.accentSoft)
    expect(inline('--ring-dark')).toBe(dark.ring)
    setTheme('dark')
    expect(inline('--accent')).toBe(dark.accent)
    expect(inline('--accent-dark')).toBe(dark.accent)
    setPalette({ id: 'graphite' })
    for (const k of ['--accent', '--on-accent', '--accent-soft', '--ring']) { expect(inline(k)).toBe(''); expect(inline(`${k}-dark`)).toBe('') }
    expect(root.hasAttribute('data-accent')).toBe(false)
  })

  it('choosing the default without a custom accent clears the stored palette', () => {
    setPalette({ id: 'mono' })
    setPalette({ id: 'terminal-green' })
    expect(localStorage.getItem(PALETTE_KEY)).toBeNull()
    expect(palette()).toBe('terminal-green')
  })

  it('ignores a corrupt or unknown stored palette', () => {
    for (const v of ['{', '"graphite"', '{"id":"sepia"}', '{"id":"toString"}', '{"id":"mono","accent":"red"}']) {
      localStorage.setItem(PALETTE_KEY, v)
      const p = getPalette()
      expect(p.accent, v).toBeUndefined()
      if (v !== '{"id":"mono","accent":"red"}') expect(p.id, v).toBe('terminal-green')
    }
  })

  it('storage that throws falls back to the defaults', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
    expect(getPalette()).toEqual({ id: 'terminal-green' })
    expect(() => setPalette({ id: 'violet', accent: '#FFF59D' })).not.toThrow()
    expect(palette()).toBe('violet')
    expect(inline('--accent')).not.toBe('')
    vi.restoreAllMocks()
  })

  it('follows a palette change made in another tab', () => {
    const stop = initTheme()
    localStorage.setItem(PALETTE_KEY, JSON.stringify({ id: 'ember' }))
    window.dispatchEvent(new StorageEvent('storage', { key: PALETTE_KEY }))
    expect(palette()).toBe('ember')
    stop()
  })
})

describe('pre-paint script', () => {
  const run = () => new Function(prePaintScript())()

  it('index.html carries the placeholder the Vite plugin fills, and the default theme colour', () => {
    expect(html.split('<!-- prepaint -->')).toHaveLength(2)
    expect(viteConfig).toContain('prePaintScript()')
    expect(html).toContain(`name="theme-color" content="${THEME_COLOR.light}"`)
    expect(html).toContain('name="color-scheme" content="light dark"')
  })

  it('uses the same storage keys and every palette background', () => {
    const o = prePaintOptions()
    expect(o.themeKey).toBe(THEME_KEY)
    expect(o.paletteKey).toBe(PALETTE_KEY)
    for (const [id, p] of Object.entries(PALETTES)) expect(o.colors[id]).toEqual([p.light.background, p.dark.background])
  })

  it('sets dark before paint from the OS or the stored choice', () => {
    dark = true
    run()
    expect(isDark()).toBe(true)
    expect(meta()).toBe(THEME_COLOR.dark)
    localStorage.setItem(THEME_KEY, 'light')
    run()
    expect(isDark()).toBe(false)
    expect(meta()).toBe(THEME_COLOR.light)
    dark = false
    localStorage.setItem(THEME_KEY, 'dark')
    run()
    expect(isDark()).toBe(true)
  })

  it('sets data-palette, Terminal green by default', () => {
    run()
    expect(palette()).toBe('terminal-green')
    localStorage.setItem(PALETTE_KEY, JSON.stringify({ id: 'midnight' }))
    run()
    expect(palette()).toBe('midnight')
    expect(meta()).toBe(PALETTES.midnight.light.background)
  })

  it('applies the stored custom accent variables for the theme in effect, matching what setPalette stores', () => {
    setPalette({ id: 'violet', accent: '#FFF59D' })
    const stored = JSON.parse(localStorage.getItem(PALETTE_KEY)!)
    root.removeAttribute('style')
    root.removeAttribute('data-palette')
    localStorage.setItem(THEME_KEY, 'dark')
    run()
    expect(palette()).toBe('violet')
    expect(isDark()).toBe(true)
    for (const [k, v] of Object.entries(stored.vars.dark)) expect(inline(k), k).toBe(v)
  })

  it('in light it also applies the stored dark accent values for a nested .dark box', () => {
    setPalette({ id: 'violet', accent: '#FFF59D' })
    const stored = JSON.parse(localStorage.getItem(PALETTE_KEY)!)
    root.removeAttribute('style')
    root.removeAttribute('data-palette')
    root.removeAttribute('data-accent')
    localStorage.setItem(THEME_KEY, 'light')
    run()
    for (const [k, v] of Object.entries(stored.vars.light)) expect(inline(k), k).toBe(v)
    for (const [k, v] of Object.entries(stored.vars.dark)) expect(inline(`${k}-dark`), k).toBe(v)
    expect(root.hasAttribute('data-accent')).toBe(true)
  })

  it('applies only the accent variables, and only #RRGGBB values', () => {
    localStorage.setItem(PALETTE_KEY, JSON.stringify({ id: 'mono', accent: '#FF0000', vars: { light: { '--accent': 'red;x', '--background': '#000000', '--ring': '#123456' } } }))
    run()
    expect(inline('--accent')).toBe('')
    expect(inline('--background')).toBe('')
    expect(inline('--ring')).toBe('#123456')
  })

  it('survives blocked storage and a missing matchMedia', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.stubGlobal('matchMedia', undefined)
    expect(run).not.toThrow()
    expect(palette()).toBe('terminal-green')
    expect(isDark()).toBe(false)
    vi.restoreAllMocks()
  })

  it('is a pure function of the window it is given', () => {
    const doc = document.implementation.createHTMLDocument('x')
    const fake = { document: doc, localStorage: { getItem: (k: string) => (k === PALETTE_KEY ? '{"id":"ember"}' : 'dark') }, matchMedia: () => ({ matches: false }) }
    prePaint(fake as unknown as Window, prePaintOptions())
    expect(doc.documentElement.getAttribute('data-palette')).toBe('ember')
    expect(doc.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('desktop title bar', () => {
  afterEach(() => { delete (window as { quorumChrome?: unknown }).quorumChrome })
  it('tells the Windows app the background and mode when the theme applies', () => {
    const chrome = vi.fn(async () => {})
    ;(window as { quorumChrome?: unknown }).quorumChrome = chrome
    applyTheme('dark')
    expect(chrome).toHaveBeenLastCalledWith(expect.stringMatching(/^#[0-9A-Fa-f]{6}$/), true)
    applyTheme('light')
    expect(chrome).toHaveBeenLastCalledWith(expect.stringMatching(/^#[0-9A-Fa-f]{6}$/), false)
  })
  it('never throws when the binding throws', () => {
    ;(window as { quorumChrome?: unknown }).quorumChrome = () => { throw new Error('x') }
    expect(() => applyTheme('dark')).not.toThrow()
  })
})
