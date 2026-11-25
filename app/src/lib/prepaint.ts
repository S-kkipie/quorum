import { ACCENT_VARS, DEFAULT_PALETTE, PALETTE_BG } from './palette-ids'

/** What the pre-paint script needs, passed in so the function stays self-contained. */
export type PrePaintOptions = {
  themeKey: string
  paletteKey: string
  fallback: string
  /** Page background per palette, [light, dark], for `<meta name="theme-color">`. */
  colors: Record<string, [string, string]>
  /** The inline variables a stored custom accent may set. */
  vars: readonly string[]
}

/**
 * Applies the stored theme and palette to <html> before first paint (no flash): `.dark`,
 * color-scheme, `data-palette`, a custom accent's stored variables (and its dark values with
 * `data-accent`) and the theme-color meta. It
 * mirrors src/lib/theme.ts. Vite inlines it into index.html (`prePaintScript`, see vite.config.ts), so
 * it must not use anything outside its own body and its arguments, and every storage access is
 * guarded.
 */
export function prePaint(win: Window, o: PrePaintOptions): void {
  var doc = win.document, root = doc.documentElement, ls: Storage | null = null
  var pref: string | null = null, dark = false, id = o.fallback, vars: Record<string, unknown> | null = null, dvars: Record<string, unknown> | null = null
  try { ls = win.localStorage; pref = ls.getItem(o.themeKey) } catch (e) { ls = null }
  try { dark = pref === 'dark' || (pref !== 'light' && win.matchMedia('(prefers-color-scheme: dark)').matches) } catch (e) { dark = pref === 'dark' }
  try {
    var v = JSON.parse((ls && ls.getItem(o.paletteKey)) || 'null')
    if (v && typeof v.id === 'string' && Object.prototype.hasOwnProperty.call(o.colors, v.id)) {
      id = v.id
      vars = (v.vars && v.vars[dark ? 'dark' : 'light']) || null
      dvars = (v.vars && v.vars.dark) || null
    }
  } catch (e) { vars = null; dvars = null }
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  root.setAttribute('data-palette', id)
  for (var i = 0; i < o.vars.length; i++) {
    var c = vars && vars[o.vars[i]]
    if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) root.style.setProperty(o.vars[i], c)
  }
  // the dark values for a .dark box inside a light page (the terminal screen), as theme.ts sets them
  var all = !!dvars
  for (var j = 0; j < o.vars.length; j++) {
    var d = dvars && dvars[o.vars[j]]
    if (typeof d === 'string' && /^#[0-9a-fA-F]{6}$/.test(d)) root.style.setProperty(o.vars[j] + '-dark', d)
    else all = false
  }
  if (all) root.setAttribute('data-accent', '')
  var meta = doc.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', o.colors[id][dark ? 1 : 0])
}

/** The options for this app (storage keys as in theme.ts). */
export function prePaintOptions(): PrePaintOptions {
  return {
    themeKey: 'quorum.theme',
    paletteKey: 'quorum.palette',
    fallback: DEFAULT_PALETTE,
    colors: PALETTE_BG,
    vars: ACCENT_VARS,
  }
}

/** The inline script body for index.html. */
export function prePaintScript(): string {
  return `(${prePaint.toString()})(window, ${JSON.stringify(prePaintOptions())})`
}
