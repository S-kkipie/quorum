import { expect, test } from 'claude-code/testing'

import { HOLD_WARNING, makeHold } from '../src/hold'

const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function deps(spawn: () => AsyncIterable<unknown>) {
  const infos: string[] = []
  const debugs: string[] = []
  return { infos, debugs, d: { spawn, info: (t: string) => { infos.push(t) }, debug: (m: string) => { debugs.push(m) } } }
}

test('hold that fails to start warns only once (info + debug)', async () => {
  const f = deps(() => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('no spawn')) }) }) as never)
  const keep = makeHold(f.d)
  keep(new Promise(() => {}))
  keep(new Promise(() => {}))
  await tick()
  expect(f.infos).toEqual([HOLD_WARNING])
  expect(f.debugs).toHaveLength(1)
  expect(f.debugs[0]).toContain('failed to start')
})

test('hold that ends before the decision warns', async () => {
  const f = deps(async function* () { /* ends immediately */ } as never)
  makeHold(f.d)(new Promise(() => {}))
  await tick()
  expect(f.infos).toEqual([HOLD_WARNING])
})

test('hold sustained until a decision does not warn and is released', async () => {
  let returned = false
  let release!: () => void
  const f = deps(() => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}),
      return: async () => { returned = true; return { done: true, value: undefined } },
    }),
  }) as never)
  makeHold(f.d)(new Promise<void>(r => { release = r }))
  await tick()
  release()
  await tick()
  expect(f.infos).toEqual([])
  expect(returned).toBe(true)
})

test('hold uses the hook spawn when it lends one (its `$` sustains its own clock)', async () => {
  const used: string[] = []
  const f = deps(() => { used.push('session'); return (async function* () {})() })
  makeHold(f.d)(new Promise(() => {}), argv => { used.push(`hook:${argv.join(' ')}`); return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } as never })
  await tick()
  expect(used).toEqual(['hook:quorumd hold'])
  expect(f.infos).toEqual([])
})
