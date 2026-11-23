import { expect, test } from 'claude-code/testing'

import { optional } from '../src/compat'

test('optional: una API ausente (TypeError síncrono) da el valor por defecto', async () => {
  const $ = { session: {} as { info?: () => Promise<{ transcriptPath: string }> } }
  expect(await optional(() => $.session.info!(), undefined)).toBe(undefined)
})

test('optional: una promesa rechazada da el valor por defecto', async () => {
  expect(await optional(() => Promise.reject(new Error('x')), 'def')).toBe('def')
})

test('optional: un valor normal pasa tal cual', async () => {
  expect(await optional(() => Promise.resolve(7), 0)).toBe(7)
})
