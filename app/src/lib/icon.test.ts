import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOKENS } from './tokens'

const svg = readFileSync(join(process.cwd(), 'public/icon.svg'), 'utf8')
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'public/manifest.webmanifest'), 'utf8'))

describe('app icon', () => {
  it('is Quiet paper: the accent ring on the light paper tile (hairline edge for white launchers)', () => {
    const colours = [...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toUpperCase())
    expect(new Set(colours)).toEqual(new Set([TOKENS.light.background, TOKENS.light.line, TOKENS.light.accent]))
    expect(svg).toMatch(/<rect[^>]*fill="#FAF9F6"/i)
    expect(svg).toMatch(/stroke="#1F5F5B"/i)
    expect(manifest.background_color.toUpperCase()).toBe(TOKENS.light.background)
  })
})
