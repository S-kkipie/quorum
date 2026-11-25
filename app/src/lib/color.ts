/** Small sRGB colour helpers for #RRGGBB strings: WCAG contrast, mixing and HSL lightness. */

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase()
}

/** True for a #RRGGBB colour. */
export function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two #RRGGBB colours (1–21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `a` mixed into `b` by `amount` (0–1), per channel in sRGB (like CSS `color-mix(in srgb, …)`). */
export function mix(a: string, b: string, amount: number): string {
  const [x, y] = [rgb(a), rgb(b)]
  return toHex(...(x.map((v, i) => v * amount + y[i] * (1 - amount)) as [number, number, number]))
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => v / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function fromHsl(h: number, s: number, l: number): string {
  if (s === 0) return toHex(l * 255, l * 255, l * 255)
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    t = (t + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return toHex(hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255)
}

/**
 * Moves `hex` in HSL lightness, in small steps, darker (`dir` -1) or lighter (+1), until `ok` holds.
 * Returns the first passing colour (the input itself when it already passes), or the end of the range.
 */
export function nudgeLightness(hex: string, dir: 1 | -1, ok: (c: string) => boolean): string {
  const [h, s, l0] = toHsl(hex)
  let c = hex.toUpperCase()
  for (let l = l0; ok(c) === false; ) {
    l += dir * 0.005
    if (l <= 0 || l >= 1) return fromHsl(h, s, Math.min(1, Math.max(0, l)))
    c = fromHsl(h, s, l)
  }
  return c
}
