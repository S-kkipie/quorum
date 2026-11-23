import { expect, test } from 'claude-code/testing'

import { Recap, cleanRecap } from '../src/recap'

const tick = () => new Promise<void>(r => setTimeout(r, 0))

function mk(complete: (p: string) => Promise<string>, t = { v: 1_000_000 }) {
  const updates: string[] = []
  const calls: string[] = []
  const r = new Recap({
    complete: p => { calls.push(p); return complete(p) },
    now: () => t.v,
    update: s => { updates.push(s) },
    sleep: ms => new Promise<void>(r => setTimeout(r, ms)),
    timeoutMs: 30,
  })
  return { r, updates, calls, t }
}

test('cleanRecap quita comillas, punto final y saltos de línea', () => {
  expect(cleanRecap('"Arreglando el login con OAuth."\n')).toBe('Arreglando el login con OAuth')
  expect(cleanRecap('Línea uno\nlínea dos')).toBe('Línea uno línea dos')
})

test('cleanRecap corta a 60 en límite de palabra', () => {
  const out = cleanRecap('palabra '.repeat(20))
  expect(out.length).toBeLessThanOrEqual(60)
  expect(out.endsWith('palabra')).toBe(true)
})

test('onFirstPrompt genera una vez y actualiza con el resultado limpio', async () => {
  const { r, updates, calls } = mk(async () => '"Arreglando el login."')
  r.onFirstPrompt('arregla el login')
  await tick(); await tick()
  expect(calls.length).toBe(1)
  expect(calls[0]).toContain('arregla el login')
  expect(updates).toEqual(['Arreglando el login'])
})

test('dos onTurnEnd en menos de 5 min generan una sola vez', async () => {
  const { r, calls, t } = mk(async () => 'Algo')
  r.onTurnEnd('a', 'b'); await tick(); await tick()
  t.v += 60_000
  r.onTurnEnd('c', 'd'); await tick(); await tick()
  expect(calls.length).toBe(1)
  t.v += 5 * 60_000
  r.onTurnEnd('e', 'f'); await tick(); await tick()
  expect(calls.length).toBe(2)
})

test('onTurnEnd sin turno nuevo desde la última generación no genera', async () => {
  const { r, calls, t } = mk(async () => 'Algo')
  r.onFirstPrompt('hola'); await tick(); await tick()
  t.v += 10 * 60_000
  r.onTurnEnd('hola', 'resp'); await tick(); await tick()
  expect(calls.length).toBe(1)
})

test('complete que rechaza no actualiza ni lanza', async () => {
  const { r, updates } = mk(async () => { throw new Error('x') })
  r.onFirstPrompt('hola'); await tick(); await tick()
  expect(updates).toEqual([])
})

test('complete que tarda más del límite no actualiza', async () => {
  const { r, updates } = mk(() => new Promise(res => setTimeout(() => res('tarde'), 100)))
  r.onFirstPrompt('hola')
  await new Promise(res => setTimeout(res, 150))
  expect(updates).toEqual([])
})
