import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { factLine, getTaskOutput, type TaskFacts } from '../../lib/taskOutput'
import type { TaskEnd } from '../../proto.gen'

const OUTPUT_MS = 2000

/**
 * One background task's output: a desktop dialog or a full-screen phone sheet with a monospace tail
 * that sticks to the bottom. A live task is re-read every 2 s while this view is mounted; an ended
 * one shows the tail its end carried.
 */
export default function TaskOutputView({ sessionId, task, title, ended, phone, onClose }: {
  sessionId: string
  task: string
  title: string
  ended?: TaskEnd
  phone: boolean
  onClose: () => void
}) {
  const [facts, setFacts] = useState<TaskFacts>()
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (ended) return
    let stop = false
    const poll = () => getTaskOutput(sessionId, task).then(
      (f) => { if (!stop) { setFacts(f); setError(''); setNow(Date.now()) } },
      (e) => { if (!stop) setError(e instanceof Error ? e.message : 'could not read the output') },
    )
    poll()
    const t = setInterval(poll, OUTPUT_MS)
    return () => { stop = true; clearInterval(t) }
  }, [sessionId, task, ended])

  const tail = ended ? (ended.outputTail ?? '') : (facts?.tail ?? '')
  const pre = useRef<HTMLPreElement>(null)
  const stuck = useRef(true)
  useLayoutEffect(() => {
    const el = pre.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [tail])
  const line = ended ? (ended.exitCode === undefined ? ended.status : `${ended.status} · exit ${ended.exitCode}`) : error || (facts ? factLine(facts, now) : 'Loading…')
  const text = tail || (ended ? 'No output was captured.' : facts ? (facts.found ? '' : 'No output yet.') : '')

  const content = (
    <>
      <div className="min-w-0 pr-8">
        {phone ? <SheetTitle className="truncate font-mono text-sm text-ink">{title}</SheetTitle> : <DialogTitle className="truncate font-mono text-sm text-ink">{title}</DialogTitle>}
        {phone ? <SheetDescription className="text-xs">{line}</SheetDescription> : <DialogDescription className="text-xs">{line}</DialogDescription>}
      </div>
      <pre ref={pre} onScroll={(e) => { const el = e.currentTarget; stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-3 font-mono text-xs text-ink">{text}</pre>
    </>
  )
  return phone ? (
    <Sheet open onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="bottom" className="h-dvh max-h-dvh gap-3 p-4 pt-[max(1rem,env(safe-area-inset-top))]">{content}</SheetContent>
    </Sheet>
  ) : (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[80dvh] w-[720px] max-w-[calc(100%-2rem)] flex-col sm:max-w-[720px]">{content}</DialogContent>
    </Dialog>
  )
}
