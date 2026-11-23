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

// Task 5 (Plan 3): la sesión informa con qué lanzamiento y en qué panel de herdr corre.
// El kit no tiene quorumd: se finge ensure y se captura el cuerpo de /v1/sessions/register.
async function registered($: never, on: never, env: Record<string, string>): Promise<Record<string, unknown>> {
  const o = on as (...a: unknown[]) => void
  mock.env(on as never, env)
  mock.clock(on as never)
  o('command.register', async () => ({ value: undefined }))
  o('session.start', async () => ({ cwd: '/x' }))
  o('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ok: true, port: 1, token: 't', machine: 'm' }), stderr: '' } }))
  let body: Record<string, unknown> | undefined
  let got: () => void = () => {}
  const done = new Promise<void>(r => { got = r })
  o('http.fetch', async (_$: unknown, e: { url?: string; init?: { body?: string } }) => {
    if (String(e.url).endsWith('/v1/sessions/register') && !body) { body = JSON.parse(String(e.init?.body)); got() }
    return { value: { status: 204 } }
  })
  await ($ as { session: { start(x: unknown): Promise<unknown> } }).session.start({ cwd: '/x', surface: null, interactive: false })
  await done
  return body!
}

test('register sends launchReq and herdr pane from env', async ($, on) => {
  const b = await registered($ as never, on as never, { CCAPI_SERVER: '1', QUORUM_LAUNCH_REQ: 'req-1', HERDR_PANE_ID: 'p_3', HERDR_WORKSPACE_ID: 'w_2' })
  expect(b.launchReq).toBe('req-1')
  expect(b.herdrPane).toBe('p_3')
  expect(b.herdrWorkspace).toBe('w_2')
})

test('sin las variables de entorno, launchReq y herdrPane van vacíos', async ($, on) => {
  const b = await registered($ as never, on as never, { CCAPI_SERVER: '1' })
  expect(b.launchReq).toBe('')
  expect(b.herdrPane).toBe('')
  expect(b.herdrWorkspace).toBe('')
})
