// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { Logo, SEATS_SVG } from './Logo'

const root = resolve(import.meta.dirname, '../../..')

describe('Logo', () => {
  it('renders seven seats and the tail, labelled when it has a title', () => {
    const { container } = render(<Logo size={32} title="Quorum" />)
    const svg = container.querySelector('svg')!
    expect(svg.querySelectorAll('circle')).toHaveLength(7)
    expect(svg.querySelectorAll('rect')).toHaveLength(1)
    expect(svg.getAttribute('role')).toBe('img')
    expect(svg.getAttribute('aria-label')).toBe('Quorum')
    expect(svg.getAttribute('width')).toBe('32')
    expect(svg.getAttribute('fill')).toBe('currentColor')
  })

  it('is hidden from assistive tech without a title', () => {
    const { container } = render(<Logo className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('role')).toBeNull()
    expect(svg.getAttribute('class')).toBe('x')
  })

  it('SEATS_SVG carries the colour and matches the generator geometry', () => {
    expect(SEATS_SVG('#3DDC97')).toContain('#3DDC97')
    const gen = createRequire(import.meta.url)(resolve(root, 'scripts/seats.mjs')) as { seatsSvg: (c: string) => string }
    expect(SEATS_SVG('#3DDC97')).toBe(gen.seatsSvg('#3DDC97'))
  })
})

describe('icons', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'app/public/manifest.webmanifest'), 'utf8'))
  it('the manifest lists the three icons and the files exist', () => {
    const srcs: string[] = manifest.icons.map((i: { src: string }) => i.src)
    expect(srcs).toEqual(expect.arrayContaining(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png']))
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true)
    for (const s of srcs) expect(existsSync(resolve(root, 'app/public', s.slice(1)))).toBe(true)
    expect(existsSync(resolve(root, 'app/public/favicon.svg'))).toBe(true)
  })
  it('the manifest uses the Terminal green dark colours', () => {
    expect(manifest.background_color).toBe('#0E1311')
    expect(manifest.theme_color).toBe('#0E1311')
  })
  it('index.html links the favicon', () => {
    expect(readFileSync(resolve(root, 'app/index.html'), 'utf8')).toContain('href="/favicon.svg"')
  })
  it('the launcher icons exist for every density, on a dark background', () => {
    const res = resolve(root, 'android-app/android/app/src/main/res')
    for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'])
      for (const f of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground'])
        expect(existsSync(resolve(res, `mipmap-${d}/${f}.png`))).toBe(true)
    expect(readFileSync(resolve(res, 'values/ic_launcher_background.xml'), 'utf8')).toContain('#0E1311')
  })
})
