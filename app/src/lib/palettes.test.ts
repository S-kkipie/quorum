import { describe, expect, it } from 'vitest'
import { contrast } from './color'
import { ACCENT_TEXT_ON, PALETTES, PALETTE_BG, PALETTE_IDS, accentVars, deriveAccent, isPaletteId } from './palettes'

const terminal = PALETTES['terminal-green']

describe('deriveAccent', () => {
  it('nudges a pale accent until buttons and accent text reach contrast', () => {
    const d = deriveAccent('#FFF59D', 'light', terminal.light)
    expect(d.accent).not.toBe('#FFF59D')
    expect(contrast(d.accent, '#F7F8F7')).toBeGreaterThanOrEqual(3)
    expect(contrast(d.onAccent, d.accent)).toBeGreaterThanOrEqual(4.5)
    for (const k of ACCENT_TEXT_ON) expect(contrast(d.accent, terminal.light[k]), k).toBeGreaterThanOrEqual(4.5)
    expect(contrast(d.accent, d.accentSoft)).toBeGreaterThanOrEqual(4.5)
    expect(d.ring).toBe(d.accent)
  })

  it('lightens a dark accent in the dark theme', () => {
    const d = deriveAccent('#1A237E', 'dark', terminal.dark)
    expect(contrast(d.accent, terminal.dark.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(d.onAccent, d.accent)).toBeGreaterThanOrEqual(4.5)
    expect(d.onAccent).toBe('#000000')
  })

  it('keeps an accent that already has contrast and picks white or black text for it', () => {
    expect(deriveAccent('#1F5F5B', 'light', terminal.light)).toMatchObject({ accent: '#1F5F5B', onAccent: '#FFFFFF' })
    expect(deriveAccent('#3DDC97', 'dark', terminal.dark)).toMatchObject({ accent: '#3DDC97', onAccent: '#000000' })
  })

  it('every custom accent on every palette ends up text-safe', () => {
    for (const id of PALETTE_IDS) for (const t of ['light', 'dark'] as const) for (const c of ['#FFFFFF', '#000000', '#FFF59D', '#FF0000', '#00FFFF', '#808080']) {
      const base = PALETTES[id][t]
      const d = deriveAccent(c, t, base)
      for (const k of ACCENT_TEXT_ON) expect(contrast(d.accent, base[k]), `${id} ${t} ${c} on ${k}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(d.onAccent, d.accent)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('lists the inline variables it sets', () => {
    const d = deriveAccent('#FFF59D', 'light', terminal.light)
    expect(accentVars(d)).toEqual({ '--accent': d.accent, '--on-accent': d.onAccent, '--accent-soft': d.accentSoft, '--ring': d.ring })
  })
})

it('isPaletteId accepts only presets', () => {
  expect(isPaletteId('graphite')).toBe(true)
  expect(isPaletteId('toString')).toBe(false)
  expect(isPaletteId('sepia')).toBe(false)
})

it('the small background table used before the palettes load matches the presets', () => {
  expect(Object.keys(PALETTES)).toEqual(PALETTE_IDS)
  for (const id of PALETTE_IDS) expect(PALETTE_BG[id]).toEqual([PALETTES[id].light.background, PALETTES[id].dark.background])
})
