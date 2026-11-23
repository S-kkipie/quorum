import { expect, mock, test } from 'claude-code/testing'

import { disabled, quorum } from '../hooks/register'

// El kit no tiene procesos ni red: quorumd no existe aquí, así que la sesión queda
// "sin daemon", pero el rol se decide antes y /quorum lo informa.
test('/quorum informa el estado tras session.start y no bloquea', async ($, on) => {
  mock.env(on, { CCAPI_SERVER: '1' })
  mock.clock(on)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.start', async (_$, e) => ({ cwd: '/x' }) as never)
  await $.session.start({ cwd: '/x', surface: null, interactive: false } as never)
  const r = await $.command.run({ command: 'quorum', args: '' } as never)
  expect(String((r as { text?: string }).text)).toContain('rol: servicio')
})

// QUORUM_DISABLE=1 (el `claude -p` del resumidor del hub): la sesión no se registra.
test('QUORUM_DISABLE=1 no arranca Link ni registra /quorum', async ($, on) => {
  mock.env(on, { CCAPI_SERVER: '1', QUORUM_DISABLE: '1' })
  mock.clock(on)
  let registered = 0
  on('command.register', async () => { registered++; return { value: undefined } as never })
  on('session.start', async (_$, e) => ({ cwd: '/x' }) as never)
  await $.session.start({ cwd: '/x', surface: null, interactive: false } as never)
  expect(registered).toBe(0)
  expect(quorum.link).toBeUndefined()
  expect(quorum.control).toBeUndefined()
})

test('disabled solo con QUORUM_DISABLE=1', () => {
  expect(disabled('1')).toBe(true)
  expect(disabled(undefined)).toBe(false)
  expect(disabled('0')).toBe(false)
})
