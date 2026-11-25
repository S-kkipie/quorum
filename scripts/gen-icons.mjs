#!/usr/bin/env node
// Regenerates every brand asset from the Seats mark (scripts/seats.mjs). Run from anywhere: node scripts/gen-icons.mjs
// Needs @resvg/resvg-js, a dev dependency of app/. The outputs are committed; rerun only when the mark or colours change.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seatsShapes } from './seats.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { Resvg } = createRequire(resolve(root, 'app/package.json'))('@resvg/resvg-js')

const BG = '#0E1311' // Terminal green, dark background
const FG = '#3DDC97' // Terminal green, dark accent

/** A 48-unit tile: the background (optionally rounded or absent) and the mark scaled about the centre. */
function tile({ scale, radius = 0, bg = BG }) {
  const back = bg ? `<rect width="48" height="48" rx="${radius}" fill="${bg}"/>` : ''
  const mark = `<g transform="translate(24 24) scale(${scale}) translate(-24 -24)">${seatsShapes(FG)}</g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${back}${mark}</svg>`
}

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
const out = (path, data) => {
  const p = resolve(root, path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, data)
}

// The mark spans about 40 of the 48 units, so a scale of s fills 40*s/48 of the tile.
const ANY = 0.8 // about 67% of the tile
const MASKABLE = 0.912 // 76% of the tile: 12% safe-zone padding on every side
const ADAPTIVE = 0.64 // 53% of the 108dp layer: inside the 66dp safe zone

// Web: favicon and PWA icons.
out('app/public/favicon.svg', tile({ scale: 0.9, radius: 10 }))
out('app/public/icons/icon-192.png', png(tile({ scale: ANY, radius: 9 }), 192))
out('app/public/icons/icon-512.png', png(tile({ scale: ANY, radius: 9 }), 512))
out('app/public/icons/maskable-512.png', png(tile({ scale: MASKABLE }), 512))

// Android: adaptive foreground (transparent) plus the legacy square and round icons.
const res = 'android-app/android/app/src/main/res'
const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
for (const [d, k] of Object.entries(DENSITY)) {
  out(`${res}/mipmap-${d}/ic_launcher_foreground.png`, png(tile({ scale: ADAPTIVE, bg: null }), 108 * k))
  out(`${res}/mipmap-${d}/ic_launcher.png`, png(tile({ scale: ANY, radius: 8 }), 48 * k))
  const round = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="${BG}"/><g transform="translate(24 24) scale(0.72) translate(-24 -24)">${seatsShapes(FG)}</g></svg>`
  out(`${res}/mipmap-${d}/ic_launcher_round.png`, png(round, 48 * k))
}
out(`${res}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`)

// Windows: an .ico of PNG frames (16, 32, 48, 256), the format Vista and later read.
const sizes = [16, 32, 48, 256]
const frames = sizes.map((s) => png(tile({ scale: 0.86, radius: 9 }), s))
const head = Buffer.alloc(6 + 16 * sizes.length)
head.writeUInt16LE(1, 2) // type: icon
head.writeUInt16LE(sizes.length, 4)
let offset = head.length
sizes.forEach((s, i) => {
  const e = 6 + 16 * i
  head[e] = s === 256 ? 0 : s // 0 means 256
  head[e + 1] = s === 256 ? 0 : s
  head.writeUInt16LE(1, e + 4) // planes
  head.writeUInt16LE(32, e + 6) // bits per pixel
  head.writeUInt32LE(frames[i].length, e + 8)
  head.writeUInt32LE(offset, e + 12)
  offset += frames[i].length
})
out('cmd/quorum-desktop/quorum.ico', Buffer.concat([head, ...frames]))
console.log('icons written')
