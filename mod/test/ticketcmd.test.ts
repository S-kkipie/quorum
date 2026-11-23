import { expect, test } from 'claude-code/testing'
import { ticketArg } from '../hooks/register'

test('ticketArg parses the command', () => {
  expect(ticketArg('ticket 41')).toBe('41')
  expect(ticketArg('ticket #41')).toBe('41')
  expect(ticketArg('ticket ACME-12')).toBe('ACME-12')
  expect(ticketArg('ticket -')).toBe('')
  expect(ticketArg('ticket')).toBe('')
  expect(ticketArg('')).toBeUndefined()
  expect(ticketArg('status')).toBeUndefined()
})
