import { expect, test } from 'claude-code/testing'

import { detectRole } from '../src/role'

test('CCAPI_SERVER=1 is the service role', () => {
  expect(detectRole(k => (k === 'CCAPI_SERVER' ? '1' : undefined))).toEqual({ role: 'service' })
})

test('without CCAPI_SERVER is the work role', () => {
  expect(detectRole(() => undefined)).toEqual({ role: 'work' })
})
