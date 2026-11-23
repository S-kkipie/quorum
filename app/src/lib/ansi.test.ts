import { describe, expect, it } from 'vitest'
import { parseAnsi, xterm256 } from './ansi'

describe('parseAnsi', () => {
  it('colores de 8, 256 y truecolor', () => {
    const [l] = parseAnsi('\x1b[31ma\x1b[38;5;196mb\x1b[38;2;1;2;3mc\x1b[44md')
    expect(l[0]).toMatchObject({ text: 'a', fg: xterm256(1) })
    expect(l[1]).toMatchObject({ text: 'b', fg: xterm256(196) })
    expect(l[2]).toMatchObject({ text: 'c', fg: 'rgb(1,2,3)' })
    expect(l[3]).toMatchObject({ text: 'd', bg: xterm256(4) })
  })
  it('reset, bold e inverse', () => {
    const [l] = parseAnsi('\x1b[1;7mA\x1b[0mB\x1b[1mC\x1b[22mD')
    expect(l[0]).toMatchObject({ text: 'A', bold: true, inverse: true })
    expect(l[1].bold).toBeFalsy()
    expect(l[1].inverse).toBeFalsy()
    expect(l[2].bold).toBe(true)
    expect(l[3].bold).toBeFalsy()
  })
  it('brillantes 90-97 y 100-107, dim, italic, underline', () => {
    const [l] = parseAnsi('\x1b[91;102;2;3;4mx')
    expect(l[0]).toMatchObject({ fg: xterm256(9), bg: xterm256(10), dim: true, italic: true, underline: true })
  })
  it('descarta secuencias no SGR', () => {
    expect(parseAnsi('\x1b[2J\x1b[Hhola')).toEqual([[{ text: 'hola' }]])
  })
  it('divide en líneas e ignora \\r sueltos', () => {
    expect(parseAnsi('a\r\nb\nc\rd').map((l) => l.map((s) => s.text).join(''))).toEqual(['a', 'b', 'cd'])
  })
  it('texto real de herdr', () => {
    const s = '\r\n\u001b[0m\u001b[2mResume this session with:\u001b[0m\r\n\u001b[0m\u001b[1m\u001b[38;5;2muser@host \u001b[0m\u001b[1m\u001b[38;5;4m[07:44:59] \u001b[0m\u001b[38;5;7m[~]\u001b[0m \r\n'
    const lines = parseAnsi(s)
    expect(lines[0]).toEqual([])
    expect(lines[1][0]).toMatchObject({ text: 'Resume this session with:', dim: true })
    expect(lines[2][0]).toMatchObject({ text: 'user@host ', bold: true, fg: xterm256(2) })
  })
})
