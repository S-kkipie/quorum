import type { AccountUsage, BackgroundItem, Meeting, MeetingAction, MeetingItem, MeetingSegment, Pending, Ticket, Checkout, Conversation, Event, ModelOption, Project, Proposal, SessionCommand, SessionCommands, SessionInfo, SessionState, TranscriptPage, Workspace } from '../proto.gen'
import { addEvents, initialState, setConversations, setProjectsData, setUsage, type AppState } from '../lib/store'
import type { Briefing, Machine } from '../lib/api'
import type { MeetingQuery, MeetingSettings } from '../lib/meetingsApi'
import type { DevPendings, PendingPatch } from '../lib/pendingsApi'

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

/**
 * Three subagents launched together (one card): a finished audit, a mapper that spawns a nested
 * subagent of its own, and one still running in the background; their work is tagged with `agent`.
 */
function subagentEvents(id: string, root: string): Event[] {
  const call = (tid: string, description: string, type: string, prompt: string, agent = '') =>
    ev(id, 'tool_start', { id: tid, name: 'Agent', summary: '', agent, input: { description, subagent_type: type, prompt } })
  const spawn = (agentId: string, tid: string, description: string, type: string, agent?: string) =>
    ev(id, 'agent_start', { id: agentId, type, description, tool: tid, ...(agent ? { agent } : {}) })
  const step = (tid: string, name: string, input: any, output: string, agent: string): Event[] => [
    ev(id, 'tool_start', { id: tid, name, summary: '', agent, input }),
    ev(id, 'tool_end', { id: tid, ok: true, ms: 120, output, agent }),
  ]
  const finish = (agentId: string, tid: string, answer: string, tokens: number, agent = ''): Event[] => [
    ev(id, 'agent_end', { id: agentId, status: 'completed', answer }),
    ev(id, 'tool_end', { id: tid, ok: true, ms: 9000, output: `${answer}\n{"totalTokens": ${tokens}}`, agent }),
  ]
  return [
    call('sa1', 'Audit every caller of the event reducer for ordering assumptions', 'Explore', 'Find every caller of reduceEvents() and say whether any assumes events arrive in seq order. ' + 'Be thorough. '.repeat(20)),
    call('sa2', 'Map the reconnect path of the hub', 'general-purpose', 'Trace what happens from a dropped socket to the first replayed event.'),
    call('sa3', 'Watch the flaky sync test', 'general-purpose', 'Run the sync test in a loop and report the first failure.'),
    spawn('ag1', 'sa1', 'Audit every caller of the event reducer for ordering assumptions', 'Explore'),
    spawn('ag2', 'sa2', 'Map the reconnect path of the hub', 'general-purpose'),
    spawn('ag3', 'sa3', 'Watch the flaky sync test', 'general-purpose'),
    ev(id, 'tool_end', { id: 'sa3', ok: true, ms: 40, output: 'Async agent launched', background: { taskId: 'ag3' } }),
    ...step('g1', 'Grep', { pattern: 'reduceEvents\\(', path: root + '/src' }, 'src/lib/store.ts\nsrc/lib/live.ts\nsrc/lib/history.ts', 'ag1'),
    ...step('g2', 'Read', { file_path: root + '/src/lib/store.ts' }, 'ok', 'ag1'),
    ...step('h1', 'Bash', { command: 'rg -n "reconnect" internal/hub', description: 'Find the reconnect code' }, 'internal/hub/ws.go:88: func reconnect', 'ag2'),
    call('sa4', 'Check the backfill ordering', 'Plan', 'Read the backfill code and say whether pages can arrive out of order.', 'ag2'),
    spawn('ag4', 'sa4', 'Check the backfill ordering', 'Plan', 'ag2'),
    ...step('n1', 'Read', { file_path: root + '/internal/hub/backfill.go' }, 'ok', 'ag4'),
    ev(id, 'assistant', { text: 'Pages are requested one at a time, so they cannot arrive out of order.', agent: 'ag4' }),
    ...finish('ag4', 'sa4', 'Pages cannot arrive out of order.', 9_800, 'ag2'),
    ...step('g3', 'Read', { file_path: root + '/src/lib/live.ts' }, 'ok', 'ag1'),
    ev(id, 'assistant', { text: 'Found 3 callers; none assume ordering. ' + 'Details. '.repeat(40), agent: 'ag1' }),
    ...finish('ag1', 'sa1', 'Found 3 callers; none assume ordering.', 41_200),
    ...step('w1', 'Bash', { command: 'for i in $(seq 50); do go test ./internal/sync -run TestSync || break; done', run_in_background: false }, 'ok 1/50', 'ag3'),
    ev(id, 'assistant', { text: 'The reconnect path re-subscribes, then backfills from the last seen seq.', agent: 'ag2' }),
    ...finish('ag2', 'sa2', 'The reconnect path re-subscribes, then backfills from the last seen seq.', 27_500),
  ]
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
    ...subagentEvents(id, root),
    ...tool(id, 'a1', 'Write', { file_path: doc, content: '<h1>Summary</h1>' }, 'ok'),
    ev(id, 'assistant', { text: 'Done. The report is above.' }),
    ev(id, 'turn_end', { reason: 'end', outputTokens: 340, tokens: { in: 1200, out: 340, cache: 4100 }, model: 'claude-haiku-5-5' }),
    // pasted images: in dev the hub refuses the link, so the thumbnails show their placeholders
    ev(id, 'user', { text: 'And the follow-up? See [Image #1] [Image #2] [Image #3] [Image #4] [Image #5] [Image #6]', images: [1, 2, 3, 4, 5, 6].map((n) => ({ n, path: `/tmp/claude-1000/-dev/${id}/images/${n}.png` })) }),
    ev(id, 'assistant', { text: 'Nothing else to add.' }),
    ev(id, 'turn_end', { reason: 'end', outputTokens: 12, tokens: { in: 12_345_678, out: 999, cache: 1_200_000 }, model: 'claude-opus-4' }),
  ]
}

// --- background work (Plan 10) ---

const LONG_LABEL = 'while true; do curl -fsS https://example.invalid/healthz/' + 'segment/'.repeat(12) + ' || exit 1; sleep 5; done ' + 'x'.repeat(120)
/** Items of every kind, with long and unbreakable labels, a loop and a cron with a next wake. */
const bgItems = (): BackgroundItem[] => [
  { id: 'c1', kind: 'command', label: 'npm test -- --watch', startedAt: NOW - 4 * MIN },
  { id: 'c2', kind: 'command', label: LONG_LABEL, startedAt: NOW - 3 * 3_600_000 },
  { id: 'm1', kind: 'monitor', label: 'Watch the deploy log for "error" lines', startedAt: NOW - 30_000 },
  { id: 'a1', kind: 'subagent', label: padTo('Audit every caller of the event reducer for ordering assumptions and report back ', 260), startedAt: NOW - 12 * MIN },
  { id: 'l1', kind: 'loop', label: 'Check the CI run and fix what fails', startedAt: NOW - 25 * MIN, nextWake: NOW + 20 * MIN },
  { id: 'k1', kind: 'cron', label: 'Summarise open pull requests', startedAt: NOW - 2 * 86_400_000, nextWake: NOW + 6 * 3_600_000 },
]
/** A background start still running, and task ends of every status (one without an exit code, one with a long tail). */
function backgroundEvents(id: string): Event[] {
  const start = (tid: string, name: string, input: any, taskId: string): Event[] => [
    ev(id, 'tool_start', { id: tid, name, summary: '', agent: '', input }),
    ev(id, 'tool_end', { id: tid, ok: true, ms: 80, output: 'Command running in background with ID: ' + taskId, background: { taskId } }),
  ]
  const end = (taskId: string, kind: string, status: string, summary: string, o: { exitCode?: number; outputTail?: string } = {}) => ev(id, 'task_end', { taskId, kind, summary, status, ...o })
  const tail = Array.from({ length: 24 }, (_, i) => `test ${String(i + 1).padStart(2, '0')} ... ok ${'.'.repeat(30)}`).join('\n')
  return [
    ev(id, 'user', { text: 'Run the tests and the type check in the background' }),
    ...start('bg-run', 'Bash', { command: 'npm run dev', run_in_background: true }, 'bg-run'),
    ...start('bg-ok', 'Bash', { command: 'npm test', run_in_background: true }, 'bg-ok'),
    end('bg-ok', 'command', 'completed', 'npm test', { exitCode: 0, outputTail: tail }),
    ...start('bg-fail', 'Bash', { command: 'npm run typecheck', run_in_background: true }, 'bg-fail'),
    end('bg-fail', 'command', 'failed', 'npm run typecheck', { exitCode: 2, outputTail: 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.' }),
    ...start('bg-kill', 'Bash', { command: 'sleep 600', run_in_background: true }, 'bg-kill'),
    end('bg-kill', 'command', 'killed', 'sleep 600'),
    ...start('bg-stop', 'Monitor', { description: 'Watch the deploy log' }, 'bg-stop'),
    end('bg-stop', 'monitor', 'stopped', 'Watch the deploy log'),
    end('bg-agent', 'subagent', 'completed', padTo('Audit every caller of the event reducer ', 240)),
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
  const machines = [machine('vps-1'), machine('laptop', { os: 'darwin', online: false, caps: { herdr: true, terminal: true, root: false, meetingWorker: 'no_gpu' } }), machine('desktop-wsl', { os: 'linux', caps: { herdr: true, terminal: true, root: false, transcribe: true, meetingWorker: 'ready' } })]
  const workspaces = [
    workspace('w1', 'Platform', '#2563eb'),
    workspace('w2', padTo('Customer research and long-term experimentation programme ', 90), '#16a34a'),
    workspace('w3', 'Équipe Ünïcödé 日本語ワークスペース', '#d97706'),
    workspace('w4', 'Q', '#9333ea'),
  ]
  const projects = [
    project('p1', 'w1', padTo('Next-generation synchronisation and offline-first reconciliation layer ', 120), { summary: longTitle(600, 'Summary'), progress: { done: 1, total: 1 }, syncError: padTo('connector: 502 from upstream while listing tickets ', 300), connector: { kind: 'moontech', settings: { product: 'Acme', person: 'Ana', username: 'ana' }, hasToken: true, intervalMin: 5 } }),
    project('p2', 'w2', 'Ünïcödé 日本語 résumé', { progress: { done: 0, total: 0 } }),
    project('p3', 'w3', 'Z', { progress: { done: 999, total: 1200 }, connector: { kind: 'github', settings: { repo: 'acme/z' }, hasToken: false, intervalMin: 5 } }),
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
  sessions[2].background = { tasks: 6, wakeAt: NOW + 20 * MIN, items: bgItems() }
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
  events[sessions[2]!.id] = backgroundEvents(sessions[2]!.id)
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
  const x = session('s1-onlyone', { state: 'background', background: { tasks: 2, wakeAt: 0, items: bgItems().slice(0, 2) }, projectId: 'p1', recap: 'Only session', plugins: ['after', 'time-machine'] })
  return finish({
    machines: [machine('vps-1')], workspaces: [workspace('w1', 'Platform', '#2563eb')], projects: [project('p1', 'w1', 'Only project', { progress: { done: 1, total: 2 } })],
    checkouts: [checkout('k1', 'p1', 'vps-1', '/work/app')], sessions: [x], proposals: [proposal('pr1', 't1')], convs: () => conversations(1), usage: [usage('a'.repeat(16), 'work', 58, 22)],
    events: { [x.id]: [ev(x.id, 'user', { text: 'Hi' }), ev(x.id, 'assistant', { text: 'Hello.' }), ...backgroundEvents(x.id).slice(1)] },
  })
}

// --- a long session (Plan 10): 1,500 events and 3 compacts, the oldest 500 only on its machine ---

/** The huge mode's first session carries the long history. */
export const LONG_SESSION = 'h000-live'
const LONG_TURNS = 300
const HISTORY_EVENTS = 500
/** Events of a turn: user, tool_start, tool_end, assistant, turn_end (a compact in place of three turn_ends). */
const COMPACT_TURNS = new Set([40, 180, 290])

/** Hub events (seq 1..1000, in memory and served by fixtureEvents) and machine history (no seq, keyed). */
function longHistory(): { hub: Event[]; machine: Event[] } {
  const all: Omit<Event, 'seq'>[] = []
  const t0 = NOW - LONG_TURNS * 5 * MIN
  for (let turn = 0; turn < LONG_TURNS; turn++) {
    const ts = t0 + turn * 5 * MIN
    const at = (k: number) => ts + k * 1000
    const session = LONG_SESSION
    all.push({ session, ts: at(0), kind: 'user', data: { text: turn % 7 === 0 ? padTo(`Turn ${turn + 1}: a longer request that wraps over a few lines on a phone screen `, 240) : `Turn ${turn + 1}: next step` } })
    all.push({ session, ts: at(1), kind: 'tool_start', data: { id: `lt${turn}`, name: turn % 3 ? 'Read' : 'Bash', summary: '', agent: '', input: turn % 3 ? { file_path: `/work/app/src/file-${turn % 40}.ts` } : { command: `npm test -- step-${turn}` } } })
    all.push({ session, ts: at(2), kind: 'tool_end', data: { id: `lt${turn}`, ok: turn % 11 !== 5, ms: 300 + turn, output: `output of step ${turn}` } })
    all.push({ session, ts: at(3), kind: 'assistant', data: { text: turn % 5 === 0 ? `Step ${turn + 1} done.\n\n${codeBlock(6 + (turn % 9))}` : `Step ${turn + 1} done.` } })
    all.push(COMPACT_TURNS.has(turn)
      ? { session, ts: at(4), kind: 'compact', data: turn === 40 ? { trigger: 'manual' } : { at: at(4), trigger: 'auto', preTokens: 150_000 + turn } }
      : { session, ts: at(4), kind: 'turn_end', data: { reason: 'end', tokens: { in: 1000 + turn, out: 200, cache: 40_000 }, model: 'claude-sonnet-5-5' } })
  }
  const machine = all.slice(0, HISTORY_EVENTS).map((e, i) => ({ ...e, seq: 0, key: `line-${i}/0` }))
  const hub = all.slice(HISTORY_EVENTS).map((e, i) => ({ ...e, seq: i + 1 }))
  return { hub, machine }
}

function huge(): AppState {
  const names = ['vps-1', 'vps-2', 'vps-3', 'laptop', 'desktop-wsl']
  const machines = names.map((n) => machine(n))
  const checkouts = names.map((n, i) => checkout('k' + i, 'p1', n, '/work/app'))
  const sessions = Array.from({ length: 200 }, (_, i) => session(`h${String(i).padStart(3, '0')}-live`, {
    machine: names[i % 5], projectId: 'p1', state: (['working', 'needs_you', 'background', 'idle'] as SessionState[])[i % 4], unread: i % 8 === 3, background: i % 4 === 2 ? { tasks: (i % 3) + 1, wakeAt: i % 8 === 2 ? NOW + 20 * MIN : 0 } : { tasks: 0, wakeAt: 0 }, recap: `Live session ${i + 1}`, updatedAt: NOW - i * MIN,
  }))
  for (const x of sessions) Object.assign(x, { model: 'claude-sonnet-5-5', modelOptions: MODELS, effortOptions: EFFORTS, effort: 'medium' })
  sessions[0].recap = 'Long session: 1,500 events, 3 compacts'
  return withCommands(finish({
    machines, workspaces: [workspace('w1', 'Platform', '#2563eb')], projects: [project('p1', 'w1', 'Busy project')], checkouts, sessions,
    convs: (m) => (m === 'vps-1' ? conversations(1000, false, 'big') : []),
    events: { [LONG_SESSION]: longHistory().hub },
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

/** Replacement for listEvents: the long session's hub events, newest first, before a seq (0 = newest). */
export function fixtureEvents(mode: FixtureMode): (id: string, before: number, limit: number) => Promise<Event[]> {
  const hub = mode === 'huge' ? longHistory().hub : []
  return async (id, before, limit) => (id !== LONG_SESSION ? [] : hub.filter((e) => !before || e.seq < before).reverse().slice(0, limit))
}

/**
 * Replacement for history: the long session's machine pages of 100, oldest first. The first page is
 * empty and not done, as when the hub filters out what it already holds.
 */
export function fixtureHistory(mode: FixtureMode): (id: string, cursor: string) => Promise<TranscriptPage> {
  const machine = mode === 'huge' ? longHistory().machine : []
  return async (id, cursor) => {
    if (id !== LONG_SESSION || !machine.length) return { events: [], cursor: '', done: true }
    if (!cursor) return { events: [], cursor: String(machine.length), done: false }
    const end = Math.max(0, Math.min(machine.length, Number(cursor) || 0))
    const start = Math.max(0, end - 100)
    return { events: machine.slice(start, end), cursor: start ? String(start) : '', done: start === 0 }
  }
}

/** Replacement for listCommands: the fixture's own list, or an empty one with no hash (an older mod). */
export function fixtureCommands(mode: FixtureMode): (id: string) => Promise<SessionCommands> {
  const s = fixtureState(mode)
  return async (id) => s.commands[id] ?? { session: id, commands: [], hash: '' }
}

// --- Project briefing (Plan 13): made-up product Acme, people Ana and Ben ---

const DAY = 24 * 60 * MIN
const bTicket = (id: string, title: string, o: Partial<Ticket> = {}): Ticket => ({
  id, projectId: 'p1', externalId: id, title, status: 'todo', rawStatus: 'por_hacer', assignee: 'Ana', url: '', body: '', comments: [], updatedAt: NOW, ...o,
})
const item = (text: string, noteTitle = 'Weekly with Ben', date = '2027-01-14'): MeetingItem => ({ text, noteTitle, date })
const noBriefing = (): Briefing => ({ whereLeftOff: null, newSince: [], pendings: [], myTickets: [], meetings: { decisions: [], openPoints: [], actions: [] }, pinned: [], sessions: [], seenAt: 0, prevSeenAt: 0 })

// --- Pending items (Plan 15): an in-memory list per mode, shared by the briefing and the project list ---

const pend = (id: string, text: string, o: Partial<Pending> = {}): Pending => ({
  id, projectId: 'p1', text, detail: '', note: '', source: 'manual', sourceRef: '', status: 'open', createdAt: NOW, updatedAt: NOW, doneAt: 0, ...o,
})
const pendingStore: Partial<Record<FixtureMode, Pending[]>> = {}
function pendingsFor(mode: FixtureMode): Pending[] {
  const made = pendingStore[mode]
  if (made) return made
  const t = Date.now()
  let list: Pending[] = []
  if (mode === 'one') list = [pend('pd1', 'Ask Ben about the staging certificate', { createdAt: t - 3 * DAY })]
  else if (mode === 'huge') list = Array.from({ length: 200 }, (_, i) => pend('pd' + i, `Pending item ${i + 1}`, { createdAt: t - (200 - i) * 60 * MIN, source: i % 3 === 0 ? 'agent' : 'manual' }))
  else if (mode === 'worst') {
    list = [
      pend('pw1', longTitle(300, 'Pending'), { detail: longTitle(4000, 'Detail'), createdAt: t - 5 * DAY }),
      pend('pw2', LONG_PATH, { source: 'agent', createdAt: t - DAY }),
      pend('pw3', 'Überprüfung der Synchronisierung 日本語', { source: 'meeting', createdAt: t - 4 * DAY, sourceRef: 'mt1' }),
      pend('pw4', 'x', { createdAt: t - 6 * DAY }),
      pend('pw5', 'Already done', { status: 'done', note: 'Shipped on Friday', doneAt: t - DAY, createdAt: t - 7 * DAY }),
      pend('pw6', 'Dropped for now', { status: 'dropped', createdAt: t - 8 * DAY }),
      ...Array.from({ length: 54 }, (_, i) => pend('pwx' + i, `Pending item ${i + 1}`, { createdAt: t - (54 - i) * 60 * MIN, source: i % 4 === 0 ? 'agent' : 'manual' })),
    ]
  } else if (mode !== 'empty') {
    list = [
      pend('pd1', 'Ask Ben about the staging certificate', { createdAt: t - 4 * DAY }),
      pend('pd2', 'Review the export spec', { detail: 'Sections 3 and 4 still need an owner.', source: 'meeting', createdAt: t - 3 * DAY }),
      pend('pd3', 'Check why the nightly import is slow', { source: 'agent', createdAt: t - 60 * MIN }),
      pend('pd4', 'Send the invoice', { status: 'done', note: 'Sent', doneAt: t - DAY, createdAt: t - 9 * DAY }),
    ]
  }
  return (pendingStore[mode] = list)
}
const openPendings = (mode: FixtureMode) => pendingsFor(mode).filter((p) => p.status === 'open')

/** Dev fixture pending items: list, add, edit and delete, kept in memory for the page's lifetime. */
export function fixturePendings(mode: FixtureMode): DevPendings {
  const all = pendingsFor(mode)
  return {
    list: async (_projectId, every) => (every ? [...all] : openPendings(mode)),
    add: async (projectId, b) => {
      const dup = all.find((p) => p.status === 'open' && p.text === b.text)
      if (dup) return dup
      const p = pend('pn' + all.length + '-' + Date.now(), b.text, { projectId, detail: b.detail ?? '', createdAt: Date.now(), updatedAt: Date.now() })
      all.push(p)
      return p
    },
    patch: async (id, b: PendingPatch) => {
      const i = all.findIndex((p) => p.id === id)
      if (i < 0) throw new Error('no such item')
      const now = Date.now()
      all[i] = { ...all[i], ...b, updatedAt: now, doneAt: b.status === 'done' ? now : b.status === 'open' ? 0 : all[i].doneAt }
      return all[i]
    },
    remove: async (id) => { const i = all.findIndex((p) => p.id === id); if (i >= 0) all.splice(i, 1) },
  }
}

/** Briefings per mode, relative to the real clock (the overdue check compares with today). */
export function fixtureBriefing(mode: FixtureMode): (projectId: string) => Promise<Briefing> {
  const s = fixtureState(mode)
  return async (projectId) => {
    const t = Date.now()
    const sessions = Object.values(s.sessions).filter((x) => x.projectId === projectId)
    if (mode === 'empty') return { ...noBriefing(), pendings: openPendings(mode) }
    if (mode === 'one') {
      return {
        ...noBriefing(), sessions, pendings: openPendings(mode), prevSeenAt: t - 2 * DAY, seenAt: t,
        whereLeftOff: { text: 'You were wiring the Acme export.', at: t - DAY, sessions: 1 },
        newSince: [{ kind: 'session', title: 'Session finished: Only session', detail: 'vps-1', at: t - DAY, ref: sessions[0]?.id ?? '' }],
        myTickets: [bTicket('a1', 'Acme · export', { plannedEnd: t + 3 * DAY })],
        meetings: { decisions: [item('Ship the export first')], openPoints: [], actions: [] },
        pinned: [{ id: 'n1', text: 'Staging is vps-1.', at: t }],
      }
    }
    if (mode === 'huge') {
      return {
        ...noBriefing(), sessions: sessions.slice(0, 50), pendings: openPendings(mode), prevSeenAt: t - 3 * DAY, seenAt: t,
        whereLeftOff: { text: 'You were load-testing the Acme solver on five machines; two runs still fail on vps-3.', at: t - DAY, sessions: 3 },
        newSince: Array.from({ length: 20 }, (_, i) => ({ kind: (['session', 'ticket', 'note'] as const)[i % 3], title: `Change ${i + 1}`, detail: i % 3 === 1 ? 'To do → In progress' : '', at: t - i * 60 * MIN, ref: sessions[i]?.id ?? 'x' + i })),
        myTickets: Array.from({ length: 60 }, (_, i) => bTicket('h' + i, `Acme · task ${i + 1}`, { plannedEnd: i % 4 ? t + (i - 10) * DAY : undefined, status: i % 5 === 0 ? 'in_progress' : 'todo' })),
        meetings: { decisions: Array.from({ length: 15 }, (_, i) => item('Decision ' + (i + 1))), openPoints: Array.from({ length: 15 }, (_, i) => item('Open point ' + (i + 1))), actions: Array.from({ length: 10 }, (_, i) => item('Ana: action ' + (i + 1))) },
        pinned: Array.from({ length: 30 }, (_, i) => ({ id: 'n' + i, text: 'Pinned note ' + (i + 1), at: t })),
      }
    }
    // worst: long and unbroken text, unicode, overdue and parked tickets, every kind of item
    return {
      ...noBriefing(), sessions, pendings: openPendings(mode), prevSeenAt: t - 3 * DAY, seenAt: t,
      whereLeftOff: { text: longTitle(480, 'You were finishing the importer at ' + LONG_PATH + ' and'), at: t - DAY, sessions: 3 },
      newSince: [
        { kind: 'session', title: 'Session finished: ' + longTitle(200, 'Recap'), detail: 'vps-1', at: t - DAY, ref: sessions[0]?.id ?? '' },
        { kind: 'ticket', title: 'Ticket moved: Überprüfung der Synchronisierung 日本語', detail: 'To do → In progress', at: t - 2 * DAY, ref: 'w1' },
        { kind: 'note', title: 'Meeting ' + 'x'.repeat(160), detail: '2 decisions · 3 open points', at: t - 3 * DAY, ref: 'note-1' },
        { kind: 'ticket', title: 'x', detail: '', at: t - 4 * DAY, ref: 'w2' },
      ],
      myTickets: [
        bTicket('w1', padTo('Acme · Überprüfung der Synchronisierung und Offline-Abgleich ', 180), { status: 'in_progress', rawStatus: 'en_curso', plannedEnd: t - 2 * DAY }),
        bTicket('w2', 'Acme · ' + LONG_PATH, { plannedStart: t + DAY, plannedEnd: t + 5 * DAY }),
        bTicket('w3', 'Acme · parked', { status: 'blocked', rawStatus: 'aparcado', plannedEnd: t - 9 * DAY }),
        bTicket('w4', 'Q'),
      ],
      meetings: {
        decisions: [item(longTitle(300, 'Decision')), item('Use 日本語 labels')],
        openPoints: [item('Who owns the backups? ' + LONG_PATH)],
        actions: [item('Ana: send the report to Ben', padTo('A meeting title that goes on and on ', 140))],
      },
      pinned: [{ id: 'n1', text: 'x'.repeat(500), at: t }, { id: 'n2', text: 'Staging is on vps-1, never test on prod.', at: t }],
    }
  }
}

// --- Meetings (Plan 14): made-up content, every status ---

const mtg = (id: string, o: Partial<Meeting> = {}): Meeting => ({
  id, projectId: 'p1', title: 'Weekly sync', startedAt: NOW - DAY, durationS: 1800, language: 'en', status: 'ready', progress: 100, error: '',
  provider: 'local', createdAt: NOW - DAY, updatedAt: NOW - DAY, hasAudio: true, audioBytes: 12_000_000, channels: '', speakerCount: 0, ...o,
})
const LINES = [
  'Good morning, shall we start with the export?', 'The export is almost done; the CSV part works.', 'Then we ship it on Monday.',
  'Who owns the backups now?', 'Nobody yet, we should decide that next week.', 'I will send the report by Friday.',
]
const segs = (n: number, people = 3, long = false): MeetingSegment[] => Array.from({ length: n }, (_, i) => {
  const label = `Speaker ${(i % people) + 1}`
  return { startMs: i * 7000, endMs: i * 7000 + 6000, label, speaker: i % people === 1 ? 'Ben' : label, text: long && i === 2 ? 'w'.repeat(400) : LINES[i % LINES.length] }
})
const acts = (long = false): MeetingAction[] => [
  { id: 'a1', text: 'Write the release notes', owner: 'Ben', due: '', mine: false, tsMs: 14_000 },
  { id: 'a2', text: long ? longTitle(300, 'Send the report') : 'Send the report', owner: 'Ana', due: 'Friday', mine: true, tsMs: 35_000 },
  { id: 'a3', text: long ? 'https://example.com/' + 'y'.repeat(200) : 'Book the room', owner: '', due: '', mine: false, issueUrl: long ? 'https://github.com/acme/z/issues/7' : undefined },
]
const readyMeeting = (id: string, o: Partial<Meeting> = {}, long = false, n = 24): Meeting => mtg(id, {
  summary: {
    title: 'Weekly sync', summary: long ? longTitle(600, 'The team reviewed the export') : 'The team reviewed the export and agreed to ship it on Monday. Backups still need an owner.',
    topics: long ? ['Export', 'Backups', 'x'.repeat(120), '日本語'] : ['Export', 'Backups'],
    decisions: [{ text: long ? longTitle(300, 'Ship the export') : 'Ship the export on Monday', tsMs: 14_000 }],
    openPoints: [{ text: long ? 'Who owns the backups? ' + LONG_PATH : 'Who owns the backups?' }],
    attendees: long ? ['Ana', 'Ben', 'Zoë Ünïcödé', 'x'.repeat(80)] : ['Ana', 'Ben'],
  },
  actions: acts(long), segments: segs(n, 3, long), speakers: { 'Speaker 2': 'Ben' }, ...o,
})

function meetingsFor(mode: FixtureMode): Meeting[] {
  if (mode === 'empty') return []
  if (mode === 'one') return [readyMeeting('mt1')]
  if (mode === 'huge') {
    return [readyMeeting('mt0', { title: 'Two-hour planning', durationS: 7200 }, false, 1500),
      ...Array.from({ length: 80 }, (_, i) => mtg('mh' + i, { title: `Meeting ${i + 1}`, startedAt: NOW - i * DAY, status: i % 9 === 0 ? 'failed' : 'ready', error: i % 9 === 0 ? 'The machine stopped responding.' : '' }))]
  }
  return [
    mtg('mu', { status: 'uploaded', title: '', progress: 0, durationS: 0 }),
    mtg('mq', { status: 'queued', title: padTo('A meeting title that goes on and on without stopping ', 200), progress: 0 }),
    mtg('mt', { status: 'transcribing', progress: 40, speakerCount: 4, segments: [] }),
    mtg('ms', { status: 'summarising', progress: 0, segments: segs(12) }),
    readyMeeting('mr', {}, true),
    readyMeeting('mg', { projectId: 'p3', title: 'GitHub project meeting' }),
    mtg('mn', { status: 'ready', title: 'Silent recording', summary: { title: '', summary: '', topics: [], decisions: [], openPoints: [], attendees: [] }, actions: [], segments: [], hasAudio: false }),
    mtg('mf', { status: 'failed', progress: 0, error: 'CUDA error: out of memory while loading the model on desktop-wsl. Close other GPU programs and press Retry.' }),
    mtg('mx', { projectId: '', title: 'Hallway chat (unassigned)', status: 'ready' }),
    mtg('my', { projectId: '', title: 'Ünïcödé 日本語 recording', status: 'queued', progress: 0 }),
  ]
}

/** Dev fixture meetings: list (by project or the inbox), detail and settings. */
export function fixtureMeetings(mode: FixtureMode): { list: (q: MeetingQuery) => Promise<Meeting[]>; get: (id: string) => Promise<Meeting>; settings: () => Promise<MeetingSettings> } {
  const all = meetingsFor(mode)
  const row = ({ summary: _s, segments: _g, actions: _a, speakers: _p, ...m }: Meeting): Meeting => m
  return {
    list: async (q) => all.filter((m) => (q.unassigned ? !m.projectId : q.projectId ? m.projectId === q.projectId : true)).map(row),
    get: async (id) => {
      const m = all.find((x) => x.id === id)
      if (!m) throw new Error('no such meeting')
      return m
    },
    settings: async () => ({ provider: 'local', model: '', baseUrl: '', language: 'es', aliases: mode === 'worst' ? ['Ana', 'x'.repeat(64)] : ['Ana'], hasKey: false }),
  }
}
