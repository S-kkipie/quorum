import type { Link } from './link'

/** Specs for `$.tool.register`; the host names them mcp__quorum__pending_*. */
export const PENDING_TOOLS = [
  {
    name: 'pending_add',
    description:
      'Add an item to the pending list of the Quorum project this session belongs to. Items are generic: a question for ' +
      'someone, a task, a point to raise, anything the owner must not forget. Use one item per point, a short `text` and ' +
      'the context in `detail`. Do not use it for your own to-do list. Always tell the owner what you added.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 300, description: 'Short title of the item' },
        detail: { type: 'string', maxLength: 4000, description: 'Context or details (optional)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'pending_list',
    description:
      'List the pending items of this session\'s Quorum project (questions for someone, tasks, points to raise). ' +
      'Open items by default; pass status "all" to include the done ones.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'all'] } },
    },
  },
  {
    name: 'pending_done',
    description:
      'Mark a pending item of this session\'s Quorum project as done, by its id (see pending_list), with an optional ' +
      'note on how it was resolved. Tell the owner which item you marked done.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        note: { type: 'string', maxLength: 2000 },
      },
      required: ['id'],
    },
  },
]

export type PendingResult = { ok: true; text: string; result: unknown } | { ok: false; text: string }

const UNREACHABLE: Record<string, string> = {
  pending_add: 'Quorum hub unreachable; the item was not saved',
  pending_list: 'Quorum hub unreachable; could not list pending items',
  pending_done: 'Quorum hub unreachable; the item was not marked done',
}

function fail(r: { status: number; json: any }, tool: string): PendingResult {
  const msg = typeof r.json?.error === 'string' && r.json.error ? r.json.error : ''
  const down = UNREACHABLE[tool] ?? UNREACHABLE.pending_add!
  if (r.status === 0) return { ok: false, text: tool === 'pending_add' ? 'Quorum is not connected; the item was not saved' : down.replace('hub unreachable', 'is not connected') }
  if (r.status === 502) return { ok: false, text: down }
  if (r.status === 401 || r.status === 403) return { ok: false, text: 'Quorum rejected this machine; re-link it with `quorumd link`' }
  if (r.status === 404) {
    if (!msg) return { ok: false, text: 'This Quorum version does not support pending items yet; update quorumd and the hub' }
    if (msg.includes('unknown session')) return { ok: false, text: `${msg} (Quorum has not seen this session yet; try again in a few seconds)` }
  }
  return { ok: false, text: msg || `Quorum answered ${r.status}` }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export async function runPendingTool(
  link: Link,
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
  newKey: () => string,
): Promise<PendingResult> {
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}/pendings`
  if (name === 'pending_add') {
    const body = { text: str(input.text), detail: str(input.detail) || undefined, clientKey: newKey() }
    let r = await link.request('POST', base, body)
    let retried = false
    if (r.status === 0 || r.status === 502) { retried = true; r = await link.request('POST', base, body) } // same key: no duplicate
    if (r.status < 200 || r.status >= 300) return fail(r, name)
    const item = r.json?.item ?? {}
    const where = str(r.json?.projectName)
    // after a retry, created:false most likely means the first attempt saved it
    const label = r.json?.created === false && !retried ? 'Already pending in' : 'Added to'
    return { ok: true, text: `${label} ${where || 'the project'}: "${str(item.text)}" (id ${str(item.id)})`, result: r.json }
  }
  if (name === 'pending_list') {
    const status = input.status === 'all' ? 'all' : 'open'
    const r = await link.request('GET', `${base}?status=${status}`)
    if (r.status < 200 || r.status >= 300) return fail(r, name)
    const items: any[] = Array.isArray(r.json?.items) ? r.json.items : []
    const project = str(r.json?.projectName) || 'the project'
    if (!items.length) return { ok: true, text: `No ${status === 'all' ? '' : 'open '}pending items in ${project}.`, result: r.json }
    const lines = items.map(i => {
      const d = str(i.detail).replace(/\s+/g, ' ').trim()
      const n = str(i.note).replace(/\s+/g, ' ').trim()
      const st = str(i.status)
      return `- [${str(i.id)}]${st && st !== 'open' ? ` (${st})` : ''} ${str(i.text)}${d ? ` — ${d}` : ''}${n ? ` · Note: ${n}` : ''}`
    })
    const total = typeof r.json?.total === 'number' ? r.json.total : items.length
    if (total > items.length) lines.push(`(showing ${items.length} of ${total})`)
    return { ok: true, text: lines.join('\n'), result: r.json }
  }
  if (name === 'pending_done') {
    const id = str(input.id)
    if (!id) return { ok: false, text: 'id is required' }
    const r = await link.request('POST', `${base}/${encodeURIComponent(id)}/done`, { note: str(input.note) || undefined })
    if (r.status < 200 || r.status >= 300) return fail(r, name)
    return { ok: true, text: `Marked done: "${str(r.json?.item?.text)}"`, result: r.json }
  }
  return { ok: false, text: `Unknown tool ${name}` }
}
