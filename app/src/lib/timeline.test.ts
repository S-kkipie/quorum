import { describe, expect, it } from 'vitest'
import { buildTimeline, diffLines, inBase, type Item } from './timeline'
import type { Event } from '../proto.gen'

let n = 0
const ev = (kind: string, data: any, seq = ++n): Event => ({ seq, session: 's', ts: 0, kind, data })
const start = (id: string, name: string, input?: any, extra: any = {}) =>
  ev('tool_start', { id, name, summary: extra.summary ?? '', input, agent: extra.agent })
const end = (id: string, ok = true, output = '', agent?: string) => ev('tool_end', { id, ok, ms: 5, output, agent })
const tool = (items: Item[], i = 0) => items.filter((x) => x.t === 'tool')[i] as Extract<Item, { t: 'tool' }>
const BASE = '/home/u/proj'

describe('buildTimeline', () => {
  it('groups consecutive reads', () => {
    const items = buildTimeline([
      start('r1', 'Read', { file_path: `${BASE}/a.ts` }), end('r1'),
      start('r2', 'Read', { file_path: `${BASE}/src/b.ts` }), end('r2'),
      start('r3', 'Read', { file_path: `${BASE}/c.ts` }),
    ], BASE)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ t: 'reads', files: [`${BASE}/a.ts`, `${BASE}/src/b.ts`, `${BASE}/c.ts`], state: 'running', title: 'Read a.ts and 2 more' })
  })

  it('a single read stays a tool item', () => {
    const items = buildTimeline([start('r1', 'Read', { file_path: `${BASE}/a.ts` }), end('r1')], BASE)
    expect(items[0]).toMatchObject({ t: 'tool', kind: 'read', title: 'Read a.ts', state: 'ok', file: `${BASE}/a.ts` })
  })

  it('does not group reads across a bash', () => {
    const items = buildTimeline([
      start('r1', 'Read', { file_path: '/x/a.ts' }), end('r1'),
      start('b1', 'Bash', { command: 'ls -la\necho hi' }), end('b1', true, 'out'),
      start('r2', 'Read', { file_path: '/x/b.ts' }), end('r2'),
    ], BASE)
    expect(items.map((i) => i.t)).toEqual(['tool', 'tool', 'tool'])
    expect(tool(items, 1)).toMatchObject({ kind: 'bash', title: 'ls -la', output: 'out' })
  })

  it('does not group reads across assistant text or different agents', () => {
    const items = buildTimeline([
      start('r1', 'Read', { file_path: '/x/a.ts' }),
      ev('assistant', { text: 'hm' }),
      start('r2', 'Read', { file_path: '/x/b.ts' }),
      start('r3', 'Read', { file_path: '/x/c.ts' }, { agent: 'sub' }),
    ], BASE)
    expect(items.map((i) => i.t)).toEqual(['tool', 'assistant', 'tool', 'tool'])
  })

  it('edit item has file and diff counts', () => {
    const items = buildTimeline([
      start('e1', 'Edit', { file_path: `${BASE}/a.ts`, old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' }), end('e1'),
    ], BASE)
    expect(tool(items)).toMatchObject({ kind: 'edit', title: 'Edited a.ts', file: `${BASE}/a.ts`, diff: { add: 2, del: 1 }, state: 'ok' })
    expect(items).toHaveLength(1)
  })

  it('multiedit sums the diff of every edit', () => {
    const items = buildTimeline([
      start('e1', 'MultiEdit', { file_path: `${BASE}/a.ts`, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'x', new_string: 'x\ny' }] }), end('e1'),
    ], BASE)
    expect(tool(items)).toMatchObject({ kind: 'edit', title: 'Edited a.ts', diff: { add: 2, del: 1 } })
  })

  it('a long file name in the write title keeps its extension', () => {
    const items = buildTimeline([start('w1', 'Write', { file_path: `${BASE}/out/a-very-long-generated-report-name-2026.html`, content: 'x' }), end('w1')], BASE)
    const t = (tool(items) as any).title as string
    expect(t.startsWith('Created ')).toBe(true)
    expect(t).toContain('…')
    expect(t.endsWith('2026.html')).toBe(true)
  })

  it('write of html creates one artifact; second write moves it', () => {
    const p = `${BASE}/out/report.html`
    const items = buildTimeline([
      start('w1', 'Write', { file_path: p, content: '<p>1</p>' }), end('w1'),
      ev('assistant', { text: 'done' }),
      start('w2', 'Write', { file_path: p, content: '<p>2</p>' }), end('w2'),
    ], BASE)
    expect(tool(items)).toMatchObject({ kind: 'write', title: 'Created report.html' })
    const arts = items.filter((i) => i.t === 'artifact')
    expect(arts).toHaveLength(1)
    expect(arts[0]).toMatchObject({ path: p, name: 'report.html', inBase: true })
    expect(items[items.length - 1].t).toBe('artifact')
  })

  it('a running or failed write has no artifact', () => {
    const running = buildTimeline([start('w1', 'Write', { file_path: `${BASE}/a.html` })], BASE)
    expect(running.some((i) => i.t === 'artifact')).toBe(false)
    const failed = buildTimeline([start('w1', 'Write', { file_path: `${BASE}/a.html` }), end('w1', false, 'boom')], BASE)
    expect(failed.some((i) => i.t === 'artifact')).toBe(false)
    expect(tool(failed).state).toBe('error')
  })

  it('write of a non-viewable file creates no artifact', () => {
    const items = buildTimeline([start('w1', 'Write', { file_path: `${BASE}/a.ts` }), end('w1')], BASE)
    expect(items.some((i) => i.t === 'artifact')).toBe(false)
  })

  it('edit of md creates no artifact; edit of html does', () => {
    const md = buildTimeline([start('e1', 'Edit', { file_path: `${BASE}/README.md`, old_string: 'a', new_string: 'b' }), end('e1')], BASE)
    expect(md.some((i) => i.t === 'artifact')).toBe(false)
    const html = buildTimeline([start('e1', 'Edit', { file_path: `${BASE}/Index.HTML`, old_string: 'a', new_string: 'b' }), end('e1')], BASE)
    expect(html.filter((i) => i.t === 'artifact')).toHaveLength(1)
    const write = buildTimeline([start('w1', 'Write', { file_path: `${BASE}/notes.md` }), end('w1')], BASE)
    expect(write.filter((i) => i.t === 'artifact')).toHaveLength(1)
  })

  it('artifact outside base has inBase false', () => {
    const items = buildTimeline([start('w1', 'Write', { file_path: '/tmp/x.png' }), end('w1')], BASE)
    expect(items.find((i) => i.t === 'artifact')).toMatchObject({ path: '/tmp/x.png', inBase: false })
    const noBase = buildTimeline([start('w1', 'Write', { file_path: `${BASE}/x.png` }), end('w1')], '')
    expect(noBase.find((i) => i.t === 'artifact')).toMatchObject({ inBase: false })
  })

  it('an artifact in a git worktree of the session opens', () => {
    const items = buildTimeline([start('w1', 'Write', { file_path: '/home/u/work/acme/app-rewrite/r.html' }), end('w1')], BASE, ['/home/u/work/acme/app-rewrite'])
    expect(items.find((i) => i.t === 'artifact')).toMatchObject({ inBase: true })
  })

  it('a backfilled write (negative seq, no tool_end) is done and gets its card', () => {
    const items = buildTimeline([ev('tool_start', { id: 'w', name: 'Write', summary: `${BASE}/a.svg` }, -5)], BASE)
    expect(tool(items).state).toBe('ok')
    expect(items.find((i) => i.t === 'artifact')).toMatchObject({ path: `${BASE}/a.svg`, inBase: true })
  })

  it('old event without input falls back to summary for title', () => {
    const items = buildTimeline([
      start('a', 'Read', undefined, { summary: '/x/main.go' }), end('a'),
      ev('user', { text: 'x' }),
      start('b', 'Bash', undefined, { summary: 'go test ./...' }), end('b'),
      start('c', 'Grep', undefined, { summary: 'TODO' }), end('c'),
      start('d', 'Edit', undefined, { summary: '/x/y.go' }), end('d'),
      start('e', 'WebFetch', undefined, { summary: 'https://example.com/a?b' }), end('e'),
      start('f', 'Task', undefined, { summary: 'description=look around' }), end('f'),
      start('g', 'TodoWrite', undefined, { summary: '' }), end('g'),
    ], BASE)
    const titles = items.filter((i) => i.t === 'tool').map((i: any) => i.title)
    expect(titles).toEqual(['Read main.go', 'go test ./...', 'Searched TODO', 'Edited y.go', 'Read example.com', 'Updated the plan'])
    expect(items.find((i) => i.t === 'agent')).toMatchObject({ description: 'description=look around', status: 'completed' })
    expect(tool(items, 3)).toMatchObject({ file: '/x/y.go' })
    expect(tool(items, 3).diff).toBeUndefined()
  })

  it('titles for every kind', () => {
    const items = buildTimeline([
      start('1', 'Bash', { command: 'npm test', description: 'Run tests' }),
      start('2', 'Glob', { pattern: '**/*.ts' }),
      start('3', 'WebSearch', { query: 'vite 7' }),
      start('4', 'Skill', { skill: 'superpowers:brainstorming' }),
      start('5', 'Agent', { description: 'find callers', subagent_type: 'Explore' }),
      start('6', 'mcp__claude_ai_Gmail__search_threads', { q: 'x' }),
      start('7', 'NotebookRead', {}),
      start('8', 'Write', { file_path: 'C:\\Users\\u\\p\\a.txt' }),
    ], BASE)
    expect(items[4]).toMatchObject({ t: 'agent', description: 'find callers', type: 'Explore', status: 'running' })
    expect(items.filter((i) => i.t !== 'agent').map((i: any) => [i.kind, i.title])).toEqual([
      ['bash', 'Run tests'],
      ['search', 'Searched **/*.ts'],
      ['web_search', 'Searched "vite 7"'],
      ['skill', 'Used skill brainstorming'],
      ['mcp', 'Used search_threads (claude_ai_Gmail)'],
      ['other', 'NotebookRead'],
      ['write', 'Created a.txt'],
    ])
    expect(tool(items).detail).toBe('npm test')
  })

  it('denied state from output', () => {
    const items = buildTimeline([
      start('a', 'Bash', { command: 'rm -rf x' }), end('a', false, 'The user denied this tool'),
      start('b', 'Bash', { command: 'y' }), end('b', false, 'Denegado desde Quorum'),
      start('c', 'Bash', { command: 'z' }), end('c', false, 'exit 1'),
      start('d', 'Bash', { command: 'w' }), end('d', true, 'denied but ok'),
    ], BASE)
    expect(items.map((i: any) => i.state)).toEqual(['denied', 'denied', 'error', 'ok'])
  })

  it('todo title counts', () => {
    const items = buildTimeline([start('t', 'TodoWrite', { todos: [
      { content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'completed' },
    ] }), end('t')], BASE)
    expect(tool(items)).toMatchObject({ kind: 'todo', title: 'Updated the plan (3 tasks, 2 done)' })
  })

  it('no turn_end items', () => {
    const items = buildTimeline([ev('user', { text: 'hi' }), ev('turn_end', { reason: 'end', outputTokens: 30 }), ev('assistant', { text: 'yo' })], BASE)
    expect(items.map((i) => i.t)).toEqual(['user', 'assistant'])
  })

  it('pairs agent_start with agent_end and keeps an orphan tool_end', () => {
    const items = buildTimeline([
      ev('agent_start', { id: 'a', type: 'Explore', description: 'look' }),
      ev('agent_end', { id: 'a', status: 'completed', answer: 'found' }),
      end('zz', true, 'orphan'),
    ], BASE)
    expect(items[0]).toMatchObject({ t: 'agent', type: 'Explore', description: 'look', status: 'completed', answer: 'found' })
    expect(items[1]).toMatchObject({ t: 'tool', id: 'zz', state: 'ok', output: 'orphan' })
  })
})

describe('diffLines', () => {
  it('counts added and removed lines via LCS', () => {
    expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual({ add: 0, del: 0 })
    expect(diffLines('', 'a\nb')).toEqual({ add: 2, del: 0 })
    expect(diffLines('a\nb', '')).toEqual({ add: 0, del: 2 })
    expect(diffLines('a\nx\nb\ny', 'a\nb\nz')).toEqual({ add: 1, del: 2 })
  })
})

describe('fix round 1', () => {
  it('diffLines caps its cost on large differing inputs', () => {
    const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join('\n')
    const t0 = Date.now()
    expect(diffLines(a, b)).toEqual({ add: 2000, del: 2000 })
    expect(Date.now() - t0).toBeLessThan(100)
  })
  it('read/edit/write without input nor summary use the tool name as title', () => {
    const items = buildTimeline([
      start('a', 'Read', undefined), ev('user', { text: 'x' }),
      start('b', 'Edit', undefined), start('c', 'Write', undefined),
    ], BASE)
    expect(items.filter((i) => i.t === 'tool').map((i: any) => i.title)).toEqual(['Read', 'Edit', 'Write'])
  })
  it('artifact paths are cleaned, keeping case', () => {
    const items = buildTimeline([start('w', 'Write', { file_path: '/home/u/Proj/./x/../Out/R.html' }), end('w')], '/home/u/Proj')
    expect(items.find((i) => i.t === 'artifact')).toMatchObject({ path: '/home/u/Proj/Out/R.html', inBase: true })
    const rel = buildTimeline([start('w', 'Write', { file_path: './docs/a.md' }), end('w')], '/home/u/Proj/')
    expect(rel.find((i) => i.t === 'artifact')).toMatchObject({ path: '/home/u/Proj/docs/a.md' })
    const win = buildTimeline([start('w', 'Write', { file_path: 'C:\\Users\\U\\.\\P\\A.html' }), end('w')], 'C:\\Users\\U\\P')
    expect(win.find((i) => i.t === 'artifact')).toMatchObject({ path: 'C:\\Users\\U\\P\\A.html', inBase: true })
  })
})

describe('inBase', () => {
  it('needs a separator after the base', () => {
    expect(inBase('/home/u/proj/a.html', '/home/u/proj')).toBe(true)
    expect(inBase('/home/u/proj/a.html', '/home/u/proj/')).toBe(true)
    expect(inBase('/home/u/project2/a.html', '/home/u/proj')).toBe(false)
    expect(inBase('/home/u/proj', '/home/u/proj')).toBe(false)
    expect(inBase('/home/u/proj/../x/a.html', '/home/u/proj')).toBe(false)
    expect(inBase('/home/u/proj/a.html', '')).toBe(false)
  })
  it('handles Windows paths case-insensitively and with either separator', () => {
    expect(inBase('c:\\users\\u\\proj\\a.html', 'C:\\Users\\U\\Proj')).toBe(true)
    expect(inBase('C:/Users/U/Proj/sub/a.html', 'C:\\Users\\U\\Proj')).toBe(true)
    expect(inBase('D:\\Users\\U\\Proj\\a.html', 'C:\\Users\\U\\Proj')).toBe(false)
  })
  it('is case-sensitive for posix bases', () => {
    expect(inBase('/Home/u/proj/a.html', '/home/u/proj')).toBe(false)
  })
})

describe('buildTimeline: command events', () => {
  it('one item per id, at its first position, with the latest status', () => {
    const items = buildTimeline([
      ev('command', { id: 'c1', name: 'compact', args: '', origin: 'device', status: 'queued' }, 1),
      ev('assistant', { text: 'still working' }, 2),
      ev('command', { id: 'c2', name: 'model', args: 'sonnet', origin: 'device', status: 'done', text: 'Set model to Sonnet' }, 3),
      ev('command', { id: 'c1', name: 'compact', args: '', origin: 'device', status: 'done', text: 'Compacted' }, 4),
    ], BASE)
    expect(items.map((i) => i.t)).toEqual(['command', 'assistant', 'command'])
    expect(items[0]).toMatchObject({ t: 'command', seq: 1, id: 'c1', name: 'compact', status: 'done', text: 'Compacted' })
    expect(items[2]).toMatchObject({ id: 'c2', name: 'model', args: 'sonnet', status: 'done' })
  })
  it('a failed status keeps its error; malformed events are dropped', () => {
    const items = buildTimeline([
      ev('command', { id: 'c1', name: 'init', args: '', origin: 'device', status: 'queued' }, 1),
      ev('command', { id: 'c1', name: 'init', args: '', origin: 'device', status: 'failed', error: 'Waiting for an answer in the terminal.' }, 2),
      ev('command', { name: 'x' }, 3),
    ], BASE)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ status: 'failed', error: 'Waiting for an answer in the terminal.' })
  })
})

describe('buildTimeline: command user events', () => {
  const cmdUser = (seq: number, name: string, args: string, device?: boolean) =>
    ev('user', { text: args ? `/${name} ${args}` : `/${name}`, command: { name, args }, ...(device ? { device: true } : {}) }, seq)
  const card = (seq: number, id: string, name: string, args = '') => ev('command', { id, name, args, origin: 'device', status: 'done' }, seq)
  it('a user event with command keeps it on the item', () => {
    const items = buildTimeline([cmdUser(1, 'humanizer', 'fix it')], BASE)
    expect(items).toEqual([{ t: 'user', seq: 1, text: '/humanizer fix it', command: { name: 'humanizer', args: 'fix it' } }])
  })
  it("a device command's user event is dropped when its command card is nearby; a typed one stays", () => {
    const items = buildTimeline([
      cmdUser(1, 'humanizer', 'fix it', true),
      ev('assistant', { text: 'rewritten' }, 2),
      card(3, 'c1', 'humanizer', 'fix it'),
      cmdUser(4, 'humanizer', 'again'),
    ], BASE)
    expect(items.map((i) => i.t)).toEqual(['assistant', 'command', 'user'])
    expect(items[2]).toMatchObject({ text: '/humanizer again' })
  })
  it('a device command user event without a matching card stays; one card hides only one', () => {
    const items = buildTimeline([
      cmdUser(1, 'humanizer', '', true),
      card(2, 'c1', 'humanizer'),
      cmdUser(3, 'humanizer', '', true),
      cmdUser(4, 'other', '', true),
    ], BASE)
    expect(items.map((i) => (i.t === 'user' ? `user:${i.seq}` : i.t))).toEqual(['command', 'user:3', 'user:4'])
  })
})

describe('history and compacts', () => {
  const h = (key: string, kind: string, data: any): Event => ({ seq: 0, session: 's', ts: 1, kind, data, key })
  it('compact events become divider items with their time and trigger', () => {
    const items = buildTimeline([ev('compact', { at: 1234, trigger: 'auto', preTokens: 9000 }), ev('compact', { trigger: 'manual' })], BASE)
    expect(items).toEqual([
      { t: 'compact', seq: items[0].seq, at: 1234, trigger: 'auto' },
      { t: 'compact', seq: items[1].seq, at: undefined, trigger: 'manual' },
    ])
  })
  it('task_end passes through as its own item', () => {
    const [it0] = buildTimeline([ev('task_end', { taskId: 'b1', kind: 'command', summary: 'npm test', status: 'completed', exitCode: 0 })], BASE)
    expect(it0).toMatchObject({ t: 'task_end', taskId: 'b1', kind: 'command', summary: 'npm test', status: 'completed', exitCode: 0 })
  })
  it('machine history events (no seq) get distinct, stable row seqs and finished tools', () => {
    const page1 = [h('b/0', 'user', { text: 'two' }), h('b/1', 'tool_start', { id: 't', name: 'Bash', summary: 'ls' })]
    const a = buildTimeline([...page1, ev('assistant', { text: 'live' })], BASE)
    expect(new Set(a.map((x) => x.seq)).size).toBe(3)
    expect(a[1]).toMatchObject({ t: 'tool', state: 'ok' })
    // an older page prepended: rows already shown keep their seq
    const b = buildTimeline([h('a/0', 'user', { text: 'one' }), ...page1, ev('assistant', { text: 'live' }, a[2].seq)], BASE)
    expect(b.slice(1).map((x) => x.seq)).toEqual(a.map((x) => x.seq))
    expect(b[0].seq).not.toBe(b[1].seq)
  })
})

describe('background tool rows and task ends', () => {
  const start = (id: string) => ev('tool_start', { id, name: 'Bash', summary: 'npm test', input: { command: 'npm test', run_in_background: true } })
  const end = (id: string, o: any = {}) => ev('tool_end', { id, ok: true, output: 'started', ...o })
  const tend = (taskId: string, status: string) => ev('task_end', { taskId, kind: 'command', summary: 'npm test', status })
  const row = (items: any[]) => items.find((x) => x.t === 'tool')
  it('a tool_end with background.taskId marks the row as running in the background', () => {
    expect(row(buildTimeline([start('t'), end('t', { background: { taskId: 'b1' } })], BASE)).bg).toEqual({ taskId: 'b1' })
    expect(row(buildTimeline([start('t'), end('t')], BASE)).bg).toBeUndefined()
  })
  it('the matching task_end settles the row with its status; other tasks do not', () => {
    const base = [start('t'), end('t', { background: { taskId: 'b1' } })]
    expect(row(buildTimeline([...base, tend('b2', 'failed')], BASE)).bg).toEqual({ taskId: 'b1' })
    expect(row(buildTimeline([...base, tend('b1', 'failed')], BASE)).bg).toEqual({ taskId: 'b1', status: 'failed' })
  })
  it('a task_end that arrives before the tool_end still settles the row', () => {
    expect(row(buildTimeline([start('t'), tend('b1', 'completed'), end('t', { background: { taskId: 'b1' } })], BASE)).bg).toEqual({ taskId: 'b1', status: 'completed' })
  })
  it('a real task_end replaces a synthetic "stopped" one; a synthetic after a real one is ignored', () => {
    const synth = ev('task_end', { taskId: 'b1', kind: 'command', summary: 'npm test', status: 'stopped', synthetic: true })
    const real = ev('task_end', { taskId: 'b1', kind: 'command', summary: 'Background command "npm test" was stopped', status: 'killed', exitCode: 137 })
    const items = buildTimeline([start('t'), end('t', { background: { taskId: 'b1' } }), synth, real], BASE)
    const ends = items.filter((x) => x.t === 'task_end') as any[]
    expect(ends.length).toBe(1)
    expect(ends[0]).toMatchObject({ status: 'killed', exitCode: 137, summary: 'Background command "npm test" was stopped' })
    expect(row(items).bg).toEqual({ taskId: 'b1', status: 'killed' })
    const again = buildTimeline([real, synth], BASE).filter((x) => x.t === 'task_end') as any[]
    expect(again.length).toBe(1)
    expect(again[0].status).toBe('killed')
  })
  it('one card per task id (live + history duplicates)', () => {
    const items = buildTimeline([tend('b1', 'completed'), tend('b1', 'completed'), tend('b2', 'stopped')], BASE)
    expect(items.filter((x) => x.t === 'task_end').map((x: any) => x.taskId)).toEqual(['b1', 'b2'])
  })
  it('a background subagent row follows its Agent call and its task_end', () => {
    const items = buildTimeline([
      ev('tool_start', { id: 'tu', name: 'Agent', summary: '', input: { description: 'Audit' } }),
      ev('agent_start', { id: 'ag', type: 'general-purpose', description: 'Audit' }),
      ev('tool_end', { id: 'tu', ok: true, output: 'launched', background: { taskId: 'ag' } }),
    ], BASE)
    expect(items.find((x) => x.t === 'agent')).toMatchObject({ bg: { taskId: 'ag' } })
    const done = buildTimeline([
      ev('tool_start', { id: 'tu', name: 'Agent', summary: '', input: { description: 'Audit' } }),
      ev('agent_start', { id: 'ag', type: 'x', description: 'Audit' }),
      ev('tool_end', { id: 'tu', ok: true, output: '', background: { taskId: 'ag' } }),
      ev('task_end', { taskId: 'ag', kind: 'subagent', summary: 'Audit', status: 'completed' }),
    ], BASE)
    expect(done.find((x) => x.t === 'agent')).toMatchObject({ bg: { taskId: 'ag', status: 'completed' } })
  })
})
