import { expect, test } from 'claude-code/testing'

import { detectRepo, makeBranchRefresher, type RepoDeps } from '../src/repo'

const ok = (stdout: string) => Promise.resolve({ exitCode: 0, stdout })

test('usa $.session.repo cuando existe', async () => {
  const deps: RepoDeps = {
    repo: () => ({ remote: 'git@github.com:o/r.git' }),
    run: argv => (argv.includes('branch') ? ok('main\n') : Promise.reject(new Error('no debe llamarse'))),
  }
  expect(await detectRepo(deps, '/w')).toEqual({ repoUrl: 'git@github.com:o/r.git', branch: 'main' })
})

test('sin $.session.repo cae a git remote get-url', async () => {
  const seen: string[][] = []
  const deps: RepoDeps = {
    repo: () => { throw new TypeError('repo is not a function') },
    run: argv => { seen.push(argv); return ok(argv.includes('get-url') ? 'https://x/o/r\n' : 'dev\n') },
  }
  expect(await detectRepo(deps, '/w')).toEqual({ repoUrl: 'https://x/o/r', branch: 'dev' })
  expect(seen[0]).toEqual(['git', '-C', '/w', 'remote', 'get-url', 'origin'])
  expect(seen[1]).toEqual(['git', '-C', '/w', 'branch', '--show-current'])
})

test('si git falla manda vacío sin lanzar', async () => {
  const deps: RepoDeps = {
    repo: () => null,
    run: argv => (argv.includes('get-url') ? ok('') : Promise.reject(new Error('boom'))),
  }
  expect(await detectRepo(deps, '/w')).toEqual({ repoUrl: '', branch: '' })
  const bad: RepoDeps = { repo: () => null, run: () => Promise.resolve({ exitCode: 128, stdout: 'x' }) }
  expect(await detectRepo(bad, '/w')).toEqual({ repoUrl: '', branch: '' })
})

test('el refresco de rama respeta el minuto y avisa solo si cambió', async () => {
  let t = 0
  let branch = 'main'
  const calls: string[] = []
  const deps: RepoDeps = { repo: () => null, run: () => ok(branch) }
  const r = makeBranchRefresher(deps, '/w', b => calls.push(b), () => t)
  r.seed('main')
  branch = 'feat'
  await r.refresh() // < 1 min: no consulta
  expect(calls).toEqual([])
  t = 61_000
  await r.refresh()
  expect(calls).toEqual(['feat'])
  t = 62_000
  branch = 'otra'
  await r.refresh()
  expect(calls).toEqual(['feat'])
})

test('las credenciales de la URL no salen del mod', async () => {
  const deps: RepoDeps = { repo: () => ({ remote: 'https://user:pass@github.com/o/r.git' }), run: () => ok('main') }
  expect((await detectRepo(deps, '/w')).repoUrl).toBe('https://github.com/o/r.git')
  const d2: RepoDeps = { repo: () => null, run: argv => ok(argv.includes('get-url') ? 'https://TOKEN@github.com/o/r' : 'm') }
  expect((await detectRepo(d2, '/w')).repoUrl).toBe('https://github.com/o/r')
})

test('contraseña con / y query/fragmento se descartan', async () => {
  const deps: RepoDeps = { repo: () => ({ remote: 'https://u:pa/ss@github.com/o/r.git?access_token=x#f' }), run: () => ok('main') }
  expect((await detectRepo(deps, '/w')).repoUrl).toBe('https://github.com/o/r.git')
})
