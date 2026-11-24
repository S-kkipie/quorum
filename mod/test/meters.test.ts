import { expect, test } from 'claude-code/testing'

import { contextOf, Meters, sumTokens } from '../src/meters'

test('sumTokens folds cache read and creation together', () => {
  expect(sumTokens({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 }))
    .toEqual({ in: 1000, out: 200, cache: 75 })
  expect(sumTokens(undefined)).toEqual({ in: 0, out: 0, cache: 0 })
})

function setup() {
  let t = 1_000_000
  const updates: any[] = []
  const m = new Meters({ now: () => t, update: p => updates.push(p) })
  return { m, updates, advance: (ms: number) => { t += ms } }
}

const rl = [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-01-01T00:00:00Z' }, { kind: 'spend_limit', percentUsed: 1 }]

test('measure reports are throttled to once per 30 s and stamp usageAt', () => {
  const { m, updates, advance } = setup()
  m.addTurn({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 })
  m.report({ rateLimits: rl as never, context: { window: 1000, percent: 40 } })
  expect(updates).toHaveLength(1)
  expect(updates[0].tokens).toEqual({ in: 10, out: 2, cache: 2 })
  expect(updates[0].rateLimits).toEqual([{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-01-01T00:00:00Z' }])
  expect(updates[0].usageAt).toBe(1_000_000)
  expect(updates[0].contextEstimate).toBe(false)
  advance(10_000)
  m.report({ rateLimits: rl as never, context: { window: 1000, percent: 40 } })
  expect(updates).toHaveLength(1)
  advance(30_000)
  m.report({ rateLimits: [], context: { window: 1000, percent: 40 } })
  expect(updates).toHaveLength(2)
  expect(updates[1].rateLimits).toEqual([])
  expect(updates[1].usageAt).toBe(1_040_000)
})

test('a measure without rate limits sends neither rateLimits nor usageAt', () => {
  const { m, updates } = setup()
  m.report({ context: { window: 1000, percent: 40 } })
  expect(updates).toHaveLength(1)
  expect('rateLimits' in updates[0]).toBe(false)
  expect('usageAt' in updates[0]).toBe(false)
})

test('every main-turn end sends the token totals and context; only rate limits are throttled', () => {
  const { m, updates, advance } = setup()
  m.addTurn({ input_tokens: 10, output_tokens: 2 })
  m.report({ rateLimits: rl as never, context: { window: 1000, percent: 40 } }, undefined, { turnEnd: true })
  advance(5_000)
  m.addTurn({ input_tokens: 5, output_tokens: 1 })
  m.report({ rateLimits: rl as never, context: { window: 1000, tokens: 500 } }, undefined, { turnEnd: true })
  expect(updates).toHaveLength(2)
  expect(updates[1].tokens).toEqual({ in: 15, out: 3, cache: 0 })
  expect(updates[1].contextPct).toBe(50)
  expect(updates[1].contextEstimate).toBe(true)
  expect('rateLimits' in updates[1]).toBe(false) // throttled
  expect('usageAt' in updates[1]).toBe(false)
  // without a usage reading the turn still reports its totals
  m.addTurn({ input_tokens: 1 })
  m.report(undefined, undefined, { turnEnd: true })
  expect(updates[2]).toEqual({ tokens: { in: 16, out: 3, cache: 0 } })
})

test('context without percent is an estimate from tokens/window', () => {
  const { m, updates } = setup()
  m.report({ rateLimits: [], context: { window: 1000, tokens: 250 } })
  expect(updates[0].contextEstimate).toBe(true)
  expect(updates[0].contextPct).toBe(25)
})

test('contextOf: reported percent is never flagged as an estimate; pct and flag share one source', () => {
  expect(contextOf({ window: 1000, percent: 40, tokens: 100 })).toEqual({ pct: 40, estimate: false })
  expect(contextOf({ window: 1000, tokens: 250 })).toEqual({ pct: 25, estimate: true })
  expect(contextOf({ window: 1000 })).toBeUndefined()
})
