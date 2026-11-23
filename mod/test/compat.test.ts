import { expect, test } from 'claude-code/testing'

import { optional } from '../src/compat'

test('optional: a missing API (synchronous TypeError) gives the default value', async () => {
  const $ = { session: {} as { info?: () => Promise<{ transcriptPath: string }> } }
  expect(await optional(() => $.session.info!(), undefined)).toBe(undefined)
})

test('optional: a rejected promise gives the default value', async () => {
  expect(await optional(() => Promise.reject(new Error('x')), 'def')).toBe('def')
})

test('optional: a normal value passes through as is', async () => {
  expect(await optional(() => Promise.resolve(7), 0)).toBe(7)
})
