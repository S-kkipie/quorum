import { KindTaskEnd, type Event, type TaskEnd } from '../proto.gen'

/**
 * The background tasks that ended in the loaded history, newest first. A synthetic end (the mod's
 * guess that a task left) is replaced by a real end of the same task and never replaces one.
 */
export function endedTasksOf(events: Event[]): TaskEnd[] {
  const byTask = new Map<string, { at: number; end: TaskEnd }>()
  events.forEach((e, at) => {
    if (e.kind !== KindTaskEnd || !e.data?.taskId) return
    const end = e.data as TaskEnd
    const prev = byTask.get(end.taskId)
    if (prev && !prev.end.synthetic && end.synthetic) return
    byTask.set(end.taskId, { at, end })
  })
  return [...byTask.values()].sort((a, b) => b.at - a.at).map((v) => v.end)
}
