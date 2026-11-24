import type { ToolUIPart } from 'ai'
import type { Item, ReadsItem, ToolItem, ToolKind, ToolState } from './timeline'

/** What a tool row shows in its header. */
export type ToolView = { title: string; icon: ToolKind; state: 'running' | 'done' | 'error' | 'denied'; meta?: string }

const STATE: Record<ToolState, ToolView['state']> = { running: 'running', ok: 'done', error: 'error', denied: 'denied' }

/** Header data of a tool row (single tool or merged reads). */
export function toolView(item: ToolItem | ReadsItem): ToolView {
  const v: ToolView = { title: item.title, icon: item.t === 'reads' ? 'read' : item.kind, state: STATE[item.state] }
  if (item.t === 'tool' && item.diff) v.meta = `+${item.diff.add} −${item.diff.del}`
  return v
}

/** The AI SDK tool-part state the vendored Tool components expect. */
export function toolPartState(s: ToolView['state']): ToolUIPart['state'] {
  switch (s) {
    case 'running': return 'input-available'
    case 'done': return 'output-available'
    case 'error': return 'output-error'
    case 'denied': return 'output-denied'
  }
}

/** Who a timeline item belongs to: info lines are system notes, actions are the assistant's. */
export function messageRole(item: Item): 'user' | 'assistant' | 'system' {
  if (item.t === 'user') return 'user'
  if (item.t === 'info') return 'system'
  return 'assistant'
}
