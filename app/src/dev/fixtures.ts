import type { AccountUsage, Checkout, Conversation, Event, Project, Proposal, SessionInfo, SessionState, Workspace } from '../proto.gen'
import { addEvents, initialState, setConversations, setProjectsData, setUsage, type AppState } from '../lib/store'
import type { Machine } from '../lib/api'

/** Dev-only fixtures for the Break UI pass: extreme but plausible data, no hub needed. */
export type DataMode = 'demo' | 'worst' | 'empty' | 'one' | 'huge'
export type FixtureMode = Exclude<DataMode, 'demo'>

/** Size cap of a tool output as the mod sends it. */
export const TOOL_OUTPUT_MAX = 8000

const NOW = 1_800_000_000_000
const MIN = 60_000

const machine = (name: string, o: Partial<Machine> = {}): Machine => ({
  name, os: 'linux', env: name === 'desktop-wsl' ? 'wsl' : '', version: '0.5.0', online: true, lastSeen: NOW,
  caps: { herdr: true, terminal: true, root: false }, ...o,
})
const workspace = (id: string, name: string, color: string): Workspace => ({ id, name, color, whoasProfile: '' })
const project = (id: string, workspaceId: string, name: string, o: Partial<Project> = {}): Project => ({
  id, workspaceId, name, repoUrl: 'https://example.com/acme/' + id + '.git', connector: { kind: 'none', settings: {}, hasToken: false, intervalMin: 5 },
  summary: '', summaryAt: 0, progress: { done: 3, total: 9 }, syncError: '', syncedAt: NOW, ...o,
})
const checkout = (id: string, projectId: string, m: string, root: string): Checkout => ({ id, projectId, machine: m, root, repoUrl: '', branch: 'main', updatedAt: NOW })
const session = (id: string, o: Partial<SessionInfo> = {}): SessionInfo => ({
  id, previousId: '', machine: 'vps-1', name: '', cwd: '/work/app', root: '/work/app', model: 'claude-opus-4', role: 'work', state: 'idle',
  contextPct: 40, startedAt: NOW - 60 * MIN, updatedAt: NOW - MIN, transcriptPath: '', recap: '', repoUrl: '', branch: 'main', projectId: '',
  launchReq: '', herdrPane: '', herdrWorkspace: '', account: '', accountKey: '', configDir: '', plugins: [], contextEstimate: false, tokens: { in: 0, out: 0, cache: 0 }, rateLimits: [], usageAt: 0, imagesDir: '', ...o,
})
// Usage windows are relative to the real clock at fixture build (the strip compares them with
// Date.now()): five_hour resets within 0-5 h, seven_day within 0-7 d; ageMin > 60 is a stale report.
const usage = (key: string, alias: string, five: number, week: number, ageMin = 1, fiveResetMin = 130, weekResetH = 72): AccountUsage => {
  const t = Date.now()
  return {
    key, alias,
    fiveHour: { pct: five, resetsAt: new Date(t + Math.min(fiveResetMin, 300) * MIN).toISOString() },
    sevenDay: { pct: week, resetsAt: new Date(t + Math.min(weekResetH, 168) * 60 * MIN).toISOString() },
    at: t - ageMin * MIN,
  }
}
const proposal = (id: string, ticketId: string): Proposal => ({ id, ticketId, kind: 'comment', body: 'Draft reply to the reporter.', status: 'pending', error: '', createdAt: NOW })

const longTitle = (n: number, seed: string): string => {
  const base = `${seed} Refactor the reconnect and backfill pipeline so replayed history never duplicates live events, and document the ordering guarantees. `
  let s = ''
  while (s.length < n) s += base
  return s.slice(0, n - 1).trimEnd() + '.'
}
const padTo = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + 'x'.repeat(n - s.length))

let seq = 0
const ev = (session: string, kind: string, data: any): Event => ({ seq: ++seq, session, ts: NOW - 50 * MIN + seq * 1000, kind, data })
const tool = (session: string, id: string, name: string, input: any, output: string, ok = true): Event[] => [
  ev(session, 'tool_start', { id, name, summary: '', agent: '', input }),
  ev(session, 'tool_end', { id, ok, ms: 420, output }),
]

const codeBlock = (lines: number): string => {
  const body = Array.from({ length: lines }, (_, i) => `  const step${i + 1} = await run('step-${i + 1}', { retries: ${i % 4}, timeoutMs: ${1000 + i * 25} })`)
  return '```ts\nexport async function pipeline() {\n' + body.join('\n') + '\n}\n```'
}
const LONG_PATH = '/work/app/' + Array.from({ length: 24 }, (_, i) => 'segment-number-' + i).join('/') + '/internationalisation-resource-bundle-final.json'
const wide = (n: number): string => {
  const out: string[] = []
  for (let i = 0; out.join('\n').length < n; i++) out.push(`line ${String(i + 1).padStart(4, '0')} ok  ${'.'.repeat(60)} ${i * 7 % 1000} ms`)
  return padTo(out.join('\n'), n)
}

// The non-English Unicode left in these fixtures (CJK, Greek, Arabic, accented Latin) is deliberate i18n stress data.
/** A full session transcript: every row type the session view renders. */
function worstEvents(id: string, root: string): Event[] {
  const doc = `${root}/reports/summary-ünïcode.html`
  return [
    ev(id, 'user', { text: 'Could you review the sync module? Mixed scripts: 日本語のテキスト, Ελληνικά, العربية. Long description: ' + 'word '.repeat(60) }),
    ev(id, 'assistant', { text: `Sure. I will start with ${LONG_PATH} and then the code below.\n\n${codeBlock(200)}\n\nThe path above is one unbroken token of ${LONG_PATH.length} characters. Accented Latin also works: naïve, café, Zoë, Łukasz, 日本語, Ελληνικά, العربية.` }),
    ...tool(id, 'r1', 'Read', { file_path: root + '/src/a.ts' }, 'ok'),
    ...tool(id, 'r2', 'Read', { file_path: LONG_PATH }, 'ok'),
    ...tool(id, 'r3', 'Read', { file_path: root + '/src/c.ts' }, 'ok'),
    ...tool(id, 'e1', 'Edit', { file_path: root + '/src/a.ts', old_string: 'const a = 1\nconst b = 2\nconst c = 3', new_string: 'const a = 1\nconst b = 20\nconst c = 3\nconst d = 4' }, 'ok'),
    ...tool(id, 'b1', 'Bash', { command: 'npm test -- --reporter verbose', description: 'Run the full test suite with a very long description that keeps going well past one line of a phone screen' }, wide(TOOL_OUTPUT_MAX)),
    ...tool(id, 'b2', 'Bash', { command: 'false' }, 'exit status 1', false),
    ...tool(id, 'w1', 'WebSearch', { query: 'websocket reconnect backfill duplicate events ordering' }, 'ok'),
    ...tool(id, 's1', 'Skill', { skill: 'superpowers:systematic-debugging' }, 'ok'),
    ev(id, 'agent_start', { id: 'ag1', type: 'general-purpose', description: 'Audit every caller of the event reducer for ordering assumptions' }),
    ev(id, 'agent_end', { id: 'ag1', status: 'done', answer: 'Found 3 callers; none assume ordering. ' + 'Details. '.repeat(40) }),
    ...tool(id, 'a1', 'Write', { file_path: doc, content: '<h1>Summary</h1>' }, 'ok'),
    ev(id, 'assistant', { text: 'Done. The report is above.' }),
    ev(id, 'turn_end', { reason: 'end', outputTokens: 340, tokens: { in: 1200, out: 340, cache: 4100 }, model: 'claude-haiku-5-5' }),
    // pasted images: in dev the hub refuses the link, so the thumbnails show their placeholders
    ev(id, 'user', { text: 'And the follow-up? See [Image #1] [Image #2] [Image #3] [Image #4] [Image #5] [Image #6]', images: [1, 2, 3, 4, 5, 6].map((n) => ({ n, path: `/tmp/claude-1000/-dev/${id}/images/${n}.png` })) }),
    ev(id, 'assistant', { text: 'Nothing else to add.' }),
    ev(id, 'turn_end', { reason: 'end', outputTokens: 12, tokens: { in: 12_345_678, out: 999, cache: 1_200_000 }, model: 'claude-opus-4' }),
  ]
}

const conversations = (n: number, open = false, tag = 'c'): Conversation[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${tag}-${String(i).padStart(4, '0')}`,
    title: i === 0 ? longTitle(200, 'Conversation') : i === 1 ? 'x' : i === 2 ? 'Überprüfung der Synchronisierung 日本語' : `Conversation ${i + 1}`,
    firstPrompt: i % 5 === 0 ? padTo('Please look at ' + LONG_PATH + ' ', 400) : 'First prompt ' + (i + 1),
    messages: i === 3 ? 1 : (i * 37) % 900 + 1,
    updatedAt: NOW - i * 3 * MIN,
    open: open && i === 0,
  }))

const finish = (parts: { machines: Machine[]; workspaces: Workspace[]; projects: Project[]; checkouts: Checkout[]; sessions: SessionInfo[]; proposals?: Proposal[]; convs?: (machine: string, root: string) => Conversation[]; events?: Record<string, Event[]>; usage?: AccountUsage[] }): AppState => {
  let s = initialState()
  s = { ...s, machines: Object.fromEntries(parts.machines.map((m) => [m.name, m])) }
  s = { ...s, sessions: Object.fromEntries(parts.sessions.map((x) => [x.id, x])), order: parts.sessions.map((x) => x.id) }
  s = setProjectsData(s, { workspaces: parts.workspaces, projects: parts.projects, proposals: parts.proposals ?? [] })
  const byProject: Record<string, Checkout[]> = {}
  for (const c of parts.checkouts) (byProject[c.projectId] ??= []).push(c)
  s = { ...s, checkouts: byProject }
  if (parts.convs) for (const c of parts.checkouts) s = setConversations(s, c.machine, c.root, parts.convs(c.machine, c.root))
  if (parts.usage) s = setUsage(s, parts.usage)
  for (const [id, evs] of Object.entries(parts.events ?? {})) s = addEvents(s, id, evs)
  return s
}

const STATES: SessionState[] = ['working', 'needs_you', 'waiting', 'idle', 'closed']

function worst(): AppState {
  const machines = [machine('vps-1'), machine('laptop', { os: 'darwin', online: false }), machine('desktop-wsl', { os: 'linux' })]
  const workspaces = [
    workspace('w1', 'Platform', '#2563eb'),
    workspace('w2', padTo('Customer research and long-term experimentation programme ', 90), '#16a34a'),
    workspace('w3', 'Équipe Ünïcödé 日本語ワークスペース', '#d97706'),
    workspace('w4', 'Q', '#9333ea'),
  ]
  const projects = [
    project('p1', 'w1', padTo('Next-generation synchronisation and offline-first reconciliation layer ', 120), { summary: longTitle(600, 'Summary'), progress: { done: 1, total: 1 }, syncError: padTo('connector: 502 from upstream while listing tickets ', 300) }),
    project('p2', 'w2', 'Ünïcödé 日本語 résumé', { progress: { done: 0, total: 0 } }),
    project('p3', 'w3', 'Z', { progress: { done: 999, total: 1200 } }),
  ]
  const checkouts = [
    checkout('k1', 'p1', 'vps-1', '/work/app'), checkout('k2', 'p1', 'laptop', '/work/app'), checkout('k3', 'p1', 'desktop-wsl', '/work/app'),
    checkout('k4', 'p2', 'vps-1', LONG_PATH.replace(/\/[^/]+$/, '')),
  ]
  const sessions: SessionInfo[] = STATES.map((st, i) => session(`s${i + 1}-` + 'a1b2c3d4e5f6'.slice(0, 8), {
    state: st, machine: i === 2 ? 'laptop' : 'vps-1', projectId: i % 2 ? 'p2' : 'p1', root: i % 2 ? checkouts[3].root : '/work/app', cwd: i % 2 ? checkouts[3].root : '/work/app',
    recap: i === 0 ? longTitle(200, 'Recap') : i === 1 ? 'x' : i === 2 ? 'Überprüfung 日本語' : '', name: i === 3 ? longTitle(200, 'Name') : '', contextPct: [0, 55, 99, 100, 7][i], account: i % 2 ? 'personal-test' : 'work', accountKey: i % 2 ? 'b'.repeat(16) : 'a'.repeat(16), contextEstimate: i % 2 === 1, tokens: { in: 12_000 * (i + 1), out: 3_000 * (i + 1), cache: 40_000 }, branch: i === 0 ? 'feature/' + 'very-long-branch-name-'.repeat(8) : 'main',
  }))
  sessions.forEach((x) => { if (x.state !== 'closed') x.plugins = ['after', 'time-machine'] })
  sessions.push(session('s6-unassigned', { state: 'working', projectId: '', root: '/work/scratch', cwd: '/work/scratch', name: 'scratch' }))
  const events: Record<string, Event[]> = {}
  for (const x of sessions.slice(0, 2)) events[x.id] = worstEvents(x.id, x.root)
  return finish({ machines, workspaces, projects, checkouts, sessions, proposals: [proposal('pr1', 't1'), proposal('pr2', 't2'), proposal('pr3', 't3')], convs: () => conversations(40, true), events,
    usage: [usage('a'.repeat(16), 'work', 97, 41, 1, 25, 30), usage('b'.repeat(16), 'personal-test', 58, 22, 2, 260, 150), usage('c'.repeat(16), padTo('an-extremely-long-account-alias-', 60), 12, 85, 180)] })
}

function empty(): AppState {
  return finish({
    machines: [machine('vps-1')], workspaces: [workspace('w1', 'Platform', '#2563eb'), workspace('w2', 'Research', '#16a34a'), workspace('w3', 'Archive', '#71717a')],
    projects: [project('p1', 'w1', 'Empty project', { progress: { done: 0, total: 0 } })], checkouts: [checkout('k1', 'p1', 'vps-1', '/work/app')], sessions: [], convs: () => [],
  })
}

function one(): AppState {
  const x = session('s1-onlyone', { state: 'needs_you', projectId: 'p1', recap: 'Only session', plugins: ['after', 'time-machine'] })
  return finish({
    machines: [machine('vps-1')], workspaces: [workspace('w1', 'Platform', '#2563eb')], projects: [project('p1', 'w1', 'Only project', { progress: { done: 1, total: 2 } })],
    checkouts: [checkout('k1', 'p1', 'vps-1', '/work/app')], sessions: [x], proposals: [proposal('pr1', 't1')], convs: () => conversations(1), usage: [usage('a'.repeat(16), 'work', 58, 22)],
    events: { [x.id]: [ev(x.id, 'user', { text: 'Hi' }), ev(x.id, 'assistant', { text: 'Hello.' })] },
  })
}

function huge(): AppState {
  const names = ['vps-1', 'vps-2', 'vps-3', 'laptop', 'desktop-wsl']
  const machines = names.map((n) => machine(n))
  const checkouts = names.map((n, i) => checkout('k' + i, 'p1', n, '/work/app'))
  const sessions = Array.from({ length: 200 }, (_, i) => session(`h${String(i).padStart(3, '0')}-live`, {
    machine: names[i % 5], projectId: 'p1', state: (['working', 'needs_you', 'waiting', 'idle'] as SessionState[])[i % 4], recap: `Live session ${i + 1}`, updatedAt: NOW - i * MIN,
  }))
  return finish({
    machines, workspaces: [workspace('w1', 'Platform', '#2563eb')], projects: [project('p1', 'w1', 'Busy project')], checkouts, sessions,
    convs: (m) => (m === 'vps-1' ? conversations(1000, false, 'big') : []),
  })
}

export function fixtureState(mode: FixtureMode): AppState {
  seq = 0
  return { worst, empty, one, huge }[mode]()
}

/** Replacement for listConversations: answers from the fixture's own lists. */
export function fixtureConversations(mode: FixtureMode): (machine: string, root: string) => Promise<Conversation[]> {
  const s = fixtureState(mode)
  return async (m, root) => s.conversations[m + '\u0000' + root] ?? []
}

/** Replacement for pluginState: an after queue for the sessions that list the plugin. */
export function fixturePluginState(mode: FixtureMode, id: string, plugin: string): unknown {
  if (plugin === 'time-machine') return timelineFixture(mode)
  if (plugin !== 'after') return null
  const items = (n: number, long: boolean) => Array.from({ length: n }, (_, i) => ({
    id: i + 2, createdAt: NOW - (n - i) * MIN,
    text: long ? padTo(`Task ${i + 1}: refactor the reconciliation layer and ${LONG_PATH} `, 40 + i * 40) : `Task ${i + 1}`,
  }))
  if (mode === 'worst') return { items: items(12, true), running: { id: 1, text: padTo('Running now: migrate every call site of the legacy client ', 160) }, paused: false, done: [] }
  if (mode === 'one') return { items: [{ id: 2, text: 'Run the tests', createdAt: NOW }], running: null, paused: false, done: [] }
  return null
}

/** A time-machine `session:<sid>` state: 30 states with long labels and paths in worst, a single start state in one. */
function timelineFixture(mode: string): unknown {
  const st = (id: number, label: string, files: object[], parent: number | null) => ({ id, kind: id === 1 ? 'start' : 'turn', label, at: NOW - (31 - id) * 20 * MIN, commit: 'c' + id, tree: 't' + id, head: null, parent, files, prompt: label })
  if (mode === 'one') return { at: NOW, cursor: 1, states: [st(1, 'start of the session', [], null)] }
  if (mode !== 'worst') return null
  const states = Array.from({ length: 30 }, (_, i) => st(i + 1, i === 0 ? 'start of the session' : padTo(`Turn ${i}: rework the reconciliation layer `, 30 + i * 8),
    i === 0 ? [] : Array.from({ length: 1 + (i % 6) }, (_, j) => ({ path: j === 0 ? LONG_PATH + '/file.ts' : `src/part${j}.ts`, status: 'MAD'[j % 3], added: i * 7 + j, removed: i + j })), i === 0 ? null : i))
  return { at: NOW, cursor: 15, states }
}
