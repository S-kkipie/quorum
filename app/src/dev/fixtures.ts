import type { AccountUsage, Checkout, Conversation, Event, ModelOption, Project, Proposal, SessionCommand, SessionCommands, SessionInfo, SessionState, Workspace } from '../proto.gen'
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
  launchReq: '', herdrPane: '', herdrWorkspace: '', account: '', accountKey: '', configDir: '', plugins: [], contextEstimate: false, tokens: { in: 0, out: 0, cache: 0 }, rateLimits: [], usageAt: 0, imagesDir: '', background: { tasks: 0, wakeAt: 0 }, unread: false, effort: '', modelOptions: [], effortOptions: [], ...o,
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

// --- slash commands, models and effort (Plan 8) ---

const cmd = (name: string, group: string, description: string, o: Partial<SessionCommand> = {}): SessionCommand => ({
  name, description, source: group === 'session' ? 'builtin' : group === 'mcp' ? 'mcp' : group === 'skill' ? 'user' : 'plugin', plugin: '', group, terminalOnly: false, ...o,
})
/** Every group, terminal-only rows, bare-only after/timeline, long names and descriptions. */
const COMMANDS: SessionCommand[] = [
  cmd('clear', 'session', 'Clear the conversation history and free up context'),
  cmd('compact', 'session', 'Summarize the conversation and free context'),
  cmd('recap', 'session', 'Summarize what happened in this session'),
  cmd('model', 'session', 'Switch the model', { terminalOnly: true }),
  cmd('effort', 'session', 'Set the reasoning effort', { terminalOnly: true }),
  cmd('config', 'session', 'Open the settings', { terminalOnly: true }),
  cmd('resume', 'session', 'Resume a previous conversation', { terminalOnly: true }),
  cmd('init', 'session', 'Initialize a CLAUDE.md file with codebase documentation'),
  cmd('brainstorming', 'skill', 'You MUST use this before any creative work', { source: 'plugin', plugin: 'superpowers' }),
  cmd('superpowers:systematic-debugging', 'skill', 'Use when encountering any bug, test failure, or unexpected behavior', { source: 'plugin', plugin: 'superpowers' }),
  cmd('agent-browser', 'skill', 'Drive a real, visible browser for end-to-end checks'),
  cmd('an-extraordinarily-long-skill-name-that-keeps-going-and-going-for-the-layout', 'skill', padTo('Stress test: a description that is far longer than one line of a phone screen and keeps going so the row must truncate it cleanly ', 260)),
  cmd('after', 'plugin', 'Queue a task to run after the current turn', { plugin: 'after' }),
  cmd('timeline', 'plugin', 'Jump to a saved state of this session', { plugin: 'time-machine' }),
  cmd('Überprüfung-日本語', 'plugin', 'Non-Latin command name', { plugin: 'i18n-tools' }),
  cmd('mcp__database__run_query_against_the_reporting_replica', 'mcp', 'Run a read-only SQL query'),
  cmd('mcp__github__create_issue', 'mcp', ''),
]
const hugeCommands = (): SessionCommand[] => [
  ...COMMANDS,
  ...Array.from({ length: 120 }, (_, i) => cmd(`plugin-${String(i).padStart(3, '0')}:command-${i}`, (['skill', 'plugin', 'mcp'] as const)[i % 3], `Generated command number ${i + 1}`, { plugin: `plugin-${String(i).padStart(3, '0')}` })),
]
const MODELS: ModelOption[] = [
  { value: 'default', label: 'Default', description: 'The recommended model for this account' },
  { value: 'opus', label: 'Opus', description: 'Most capable, for complex work' },
  { value: 'opus[1m]', label: 'Opus (1M context)', description: 'Most capable, for complex work, 1M-token context' },
  { value: 'sonnet', label: 'Sonnet', description: 'Fast and capable, for everyday work' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest, for quick answers' },
  { value: 'a-custom-model-alias-with-an-unusually-long-name', label: padTo('A custom model alias with an unusually long label ', 80), description: padTo('Long description of a custom model that does not fit ', 140) },
]
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const withCommands = (s: AppState, ids: string[], list: () => SessionCommand[]): AppState => ({
  ...s, commands: { ...s.commands, ...Object.fromEntries(ids.map((id) => [id, { session: id, commands: list(), hash: 'h-' + id }])) },
})
/** Command cards in every status: queued, done (short and long output), failed. */
const commandEvents = (id: string): Event[] => [
  ev(id, 'command', { id: 'c1', name: 'model', args: 'sonnet', origin: 'device', status: 'done', text: 'Set model to Sonnet' }),
  ev(id, 'command', { id: 'c2', name: 'insights', args: '', origin: 'device', status: 'done', text: Array.from({ length: 14 }, (_, i) => `Insight ${i + 1}: ${padTo('a long observation about the session ', 90)}`).join('\n') }),
  ev(id, 'command', { id: 'c3', name: 'init', args: '', origin: 'device', status: 'failed', error: 'Waiting for an answer in the terminal.' }),
  ev(id, 'command', { id: 'c4', name: 'an-extraordinarily-long-skill-name-that-keeps-going-and-going-for-the-layout', args: padTo('with arguments that are also long enough to wrap ', 160), origin: 'device', status: 'queued' }),
]

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

const STATES: SessionState[] = ['working', 'needs_you', 'background', 'idle', 'closed', 'background', 'idle']

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
    recap: i === 0 ? longTitle(200, 'Recap') : i === 1 ? 'x' : i === 2 ? 'Überprüfung 日本語' : '', name: i === 3 ? longTitle(200, 'Name') : '', contextPct: [0, 55, 99, 100, 7, 42, 88][i], account: i % 2 ? 'personal-test' : 'work', accountKey: i % 2 ? 'b'.repeat(16) : 'a'.repeat(16), contextEstimate: i % 2 === 1, tokens: { in: 12_000 * (i + 1), out: 3_000 * (i + 1), cache: 40_000 }, branch: i === 0 ? 'feature/' + 'very-long-branch-name-'.repeat(8) : 'main',
  }))
  // background with tasks (s3), background with a wake-up only (s6), done unread (s7)
  sessions[2].background = { tasks: 3, wakeAt: NOW + 30 * MIN }
  sessions[5].background = { tasks: 0, wakeAt: NOW + 90 * MIN }
  sessions[6].unread = true
  sessions.forEach((x, i) => {
    if (x.state === 'closed') return
    x.plugins = ['after', 'time-machine']
    x.model = i === 1 ? 'claude-opus-4-6[1m]' : 'claude-opus-5-5'
    x.modelOptions = MODELS
    x.effortOptions = EFFORTS
    x.effort = i === 1 ? 'xhigh' : 'high'
  })
  sessions.push(session('s6-unassigned', { state: 'working', projectId: '', root: '/work/scratch', cwd: '/work/scratch', name: 'scratch' }))
  const events: Record<string, Event[]> = {}
  for (const x of sessions.slice(0, 2)) events[x.id] = [...worstEvents(x.id, x.root), ...commandEvents(x.id)]
  // a pending permission with a long script: the card clamps it and keeps Allow / Deny in reach
  const first = sessions[0]!
  events[first.id] = [...events[first.id]!, ev(first.id, 'ask', {
    askId: 'ask-long-bash', kind: 'permission', tool: 'Bash', detail: '',
    summary: Array.from({ length: 40 }, (_, i) => `node scripts/migrate-step-${i}.mjs --batch ${i * 250} --dry-run=false && echo "step ${i} done"`).join('\n'),
  })]
  return withCommands(finish({ machines, workspaces, projects, checkouts, sessions, proposals: [proposal('pr1', 't1'), proposal('pr2', 't2'), proposal('pr3', 't3')], convs: () => conversations(40, true), events,
    usage: [usage('a'.repeat(16), 'work', 97, 41, 1, 25, 30), usage('b'.repeat(16), 'personal-test', 58, 22, 2, 260, 150), usage('c'.repeat(16), padTo('an-extremely-long-account-alias-', 60), 12, 85, 180)] }),
  sessions.filter((x) => x.state !== 'closed' && x.id !== 's6-unassigned').map((x) => x.id), () => COMMANDS)
}

function empty(): AppState {
  return finish({
    machines: [machine('vps-1')], workspaces: [workspace('w1', 'Platform', '#2563eb'), workspace('w2', 'Research', '#16a34a'), workspace('w3', 'Archive', '#71717a')],
    projects: [project('p1', 'w1', 'Empty project', { progress: { done: 0, total: 0 } })], checkouts: [checkout('k1', 'p1', 'vps-1', '/work/app')], sessions: [], convs: () => [],
  })
}

function one(): AppState {
  const x = session('s1-onlyone', { state: 'idle', unread: true, projectId: 'p1', recap: 'Only session', plugins: ['after', 'time-machine'] })
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
    machine: names[i % 5], projectId: 'p1', state: (['working', 'needs_you', 'background', 'idle'] as SessionState[])[i % 4], unread: i % 8 === 3, background: i % 4 === 2 ? { tasks: (i % 3) + 1, wakeAt: i % 8 === 2 ? NOW + 20 * MIN : 0 } : { tasks: 0, wakeAt: 0 }, recap: `Live session ${i + 1}`, updatedAt: NOW - i * MIN,
  }))
  for (const x of sessions) Object.assign(x, { model: 'claude-sonnet-5-5', modelOptions: MODELS, effortOptions: EFFORTS, effort: 'medium' })
  return withCommands(finish({
    machines, workspaces: [workspace('w1', 'Platform', '#2563eb')], projects: [project('p1', 'w1', 'Busy project')], checkouts, sessions,
    convs: (m) => (m === 'vps-1' ? conversations(1000, false, 'big') : []),
  }), sessions.map((x) => x.id), hugeCommands)
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

/** Replacement for listCommands: the fixture's own list, or an empty one with no hash (an older mod). */
export function fixtureCommands(mode: FixtureMode): (id: string) => Promise<SessionCommands> {
  const s = fixtureState(mode)
  return async (id) => s.commands[id] ?? { session: id, commands: [], hash: '' }
}
