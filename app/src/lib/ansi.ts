/** Minimal SGR parser (colors and styles) to draw the terminal snapshot. No dependencies. */
export type Span = { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean }

const BASE = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
]
const LEVELS = [0, 95, 135, 175, 215, 255]

/** xterm 256-color palette. */
export function xterm256(n: number): string {
  if (n < 16) return BASE[n]
  if (n < 232) {
    const i = n - 16
    return `rgb(${LEVELS[Math.floor(i / 36)]},${LEVELS[Math.floor(i / 6) % 6]},${LEVELS[i % 6]})`
  }
  const g = 8 + (n - 232) * 10
  return `rgb(${g},${g},${g})`
}

type Style = Omit<Span, 'text'>
const clean = (s: Style): Style => {
  const o: Style = {}
  for (const [k, v] of Object.entries(s)) if (v) (o as Record<string, unknown>)[k] = v
  return o
}

function applySgr(st: Style, params: number[]): Style {
  let s = { ...st }
  if (params.length === 0) params = [0]
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) s = {}
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 7) s.inverse = true
    else if (p === 22) { s.bold = false; s.dim = false }
    else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 27) s.inverse = false
    else if (p >= 30 && p <= 37) s.fg = xterm256(p - 30)
    else if (p === 39) s.fg = undefined
    else if (p >= 40 && p <= 47) s.bg = xterm256(p - 40)
    else if (p === 49) s.bg = undefined
    else if (p >= 90 && p <= 97) s.fg = xterm256(p - 90 + 8)
    else if (p >= 100 && p <= 107) s.bg = xterm256(p - 100 + 8)
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg'
      if (params[i + 1] === 5 && params[i + 2] !== undefined) { s[key] = xterm256(Math.max(0, Math.min(255, params[i + 2]))); i += 2 }
      else if (params[i + 1] === 2 && params[i + 4] !== undefined) { s[key] = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`; i += 4 }
      else break
    }
  }
  return s
}

// CSI: ESC [ params intermediates final ; OSC: ESC ] ... (BEL | ESC \) ; others ESC + 1 character
const TOKEN = /\x1b\[([0-9;:?<=>]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]?/g

/** One list of spans per line. Splits on \r\n and \n, ignores stray \r and drops anything that is not SGR. */
export function parseAnsi(input: string): Span[][] {
  const lines: Span[][] = [[]]
  let st: Style = {}
  const push = (text: string) => {
    if (!text) return
    const line = lines[lines.length - 1]
    const style = clean(st)
    const last = line[line.length - 1]
    if (last && JSON.stringify(clean({ ...last, text: '' } as Style)) === JSON.stringify(style)) last.text += text
    else line.push({ text, ...style })
  }
  const text = (t: string) => {
    const parts = t.replace(/\r\n/g, '\n').replace(/\r/g, '').split('\n')
    parts.forEach((p, i) => {
      if (i > 0) lines.push([])
      push(p)
    })
  }
  let pos = 0
  for (const m of input.matchAll(TOKEN)) {
    text(input.slice(pos, m.index))
    pos = m.index! + m[0].length
    if (m[2] === 'm' && !/[?<=>]/.test(m[1])) {
      st = applySgr(st, m[1] === '' ? [] : m[1].split(/[;:]/).map((x) => parseInt(x, 10) || 0))
    }
  }
  text(input.slice(pos))
  return lines
}
