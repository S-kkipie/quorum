import { expect, test } from 'claude-code/testing'

import { detectRole } from '../src/role'

test('CCAPI_SERVER=1 es rol servicio', () => {
  expect(detectRole(k => (k === 'CCAPI_SERVER' ? '1' : undefined))).toEqual({ role: 'service' })
})

test('sin CCAPI_SERVER es rol trabajo', () => {
  expect(detectRole(() => undefined)).toEqual({ role: 'work' })
})
