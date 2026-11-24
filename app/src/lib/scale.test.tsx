// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { render } from '@testing-library/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/** Plan 9 type scale and radius hierarchy. */
const SRC = join(process.cwd(), 'src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'dev' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : []
  })
}

/** Monospace runs use optical sizes between steps; the allowed ones, by file. */
const MONO_ALLOW: Record<string, string[]> = {
  [join('components', 'timeline', 'CommandCard.tsx')]: ['11.5'],
}

describe('type scale', () => {
  it('has no text below the 12px step', () => {
    const small = sources(SRC).flatMap((f) => {
      const rel = relative(SRC, f)
      return [...readFileSync(f, 'utf8').matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)]
        .filter((m) => Number(m[1]) < 12 && !(MONO_ALLOW[rel] ?? []).includes(m[1]))
        .map((m) => `${rel}: ${m[0]}`)
    })
    expect(sources(SRC).length).toBeGreaterThan(50)
    expect(small).toEqual([])
  })
})

describe('radius hierarchy', () => {
  it('controls use the 8px radius (rounded-lg), not rounded-md', () => {
    const { container } = render(<><Button>Go</Button><Button size="sm">Go</Button><Input /><Textarea /></>)
    for (const el of container.querySelectorAll('button, input, textarea')) {
      expect(el.className).toContain('rounded-lg')
      expect(el.className).not.toContain('rounded-md')
    }
  })
})
