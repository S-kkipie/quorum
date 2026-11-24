/** Helpers for the better-claude `after` plugin's task queue. */

export interface QueueItem { id: number; text: string }
export interface AfterQueueState { items: QueueItem[]; running: QueueItem | null; paused: boolean }

export const TASK_TEXT_ERROR = 'Use one line that does not start with /'

/** '' when the text can be queued, else the message to show. */
export function taskTextError(text: string): string {
  const t = text.trim()
  return !t || /[\r\n]/.test(t) || t.startsWith('/') ? TASK_TEXT_ERROR : ''
}

/**
 * Args that queue `text` literally. The plugin parses anything else: a task such as "edit the README"
 * or a lone "undo" would run as a subcommand, and free text goes through a model resolver. Everything
 * after `-- ` is queued as is.
 */
export const addArgs = (text: string) => `-- ${text.trim()}`

const isItem = (x: unknown): x is QueueItem => !!x && typeof x === 'object' && typeof (x as QueueItem).text === 'string'

/** The plugin's `queue:<sid>` JSON, tolerating missing fields; null when it is not a queue at all. */
export function parseQueue(raw: unknown): AfterQueueState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pick = (x: QueueItem) => ({ id: x.id, text: x.text })
  return {
    items: Array.isArray(r.items) ? r.items.filter(isItem).map(pick) : [],
    running: isItem(r.running) ? pick(r.running) : null,
    paused: r.paused === true,
  }
}
