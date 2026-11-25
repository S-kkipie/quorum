import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PALETTES } from './palettes'

const dark = PALETTES['terminal-green'].dark
const svg = readFileSync(join(process.cwd(), 'public/favicon.svg'), 'utf8')
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'public/manifest.webmanifest'), 'utf8'))

describe('app icon', () => {
  it('is Seats: the dark Terminal green accent mark on the dark background tile', () => {
    const colours = [...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toUpperCase())
    expect(new Set(colours)).toEqual(new Set([dark.background.toUpperCase(), dark.accent.toUpperCase()]))
    expect(svg.match(/<circle/g)).toHaveLength(7)
    expect(manifest.background_color.toUpperCase()).toBe(dark.background.toUpperCase())
  })
})
