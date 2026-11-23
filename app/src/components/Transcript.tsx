import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { Event } from '../proto.gen'
import { buildTimeline } from '../lib/timeline'
import Markdown from './Markdown'
import ArtifactCard from './timeline/ArtifactCard'
import ToolItem from './timeline/ToolItem'

export default function Transcript({ events, base = '', machine = '', live, liveAgent, hasMore, autoLoad = true, onLoadMore, onOpenFile }: {
  autoLoad?: boolean
  events: Event[]
  /** session root, else cwd: decides which artifact cards can be opened */
  base?: string
  machine?: string
  live?: string
  liveAgent?: Record<string, string>
  hasMore?: boolean
  onLoadMore?: () => void
  /** opens a file of the session in the viewer */
  onOpenFile?: (path: string) => void
}) {
  const rows = useMemo(() => buildTimeline(events, base), [events, base])
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const prevH = useRef(0)
  const firstSeq = events[0]?.seq

  // When new content arrives at the bottom it sticks to the end; when history loads the position is kept.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (prevH.current && !stick.current && el.scrollTop < 40) el.scrollTop = el.scrollHeight - prevH.current
    else if (stick.current) el.scrollTop = el.scrollHeight
    prevH.current = el.scrollHeight
  }, [events.length, live, firstSeq])
  useEffect(() => { prevH.current = box.current?.scrollHeight ?? 0 })

  const onScroll = () => {
    const el = box.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 40 && hasMore && autoLoad) onLoadMore?.()
  }
  const last = events[events.length - 1]

  return (
    <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 sm:px-4">
      {hasMore && <button onClick={onLoadMore} className="mx-auto mb-2 block text-xs text-zinc-500 hover:text-zinc-300">Load earlier</button>}
      {rows.map((r) => {
        switch (r.t) {
          case 'user': return <div key={`u${r.seq}`} className="my-3 ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-blue-600/25 px-3.5 py-2 text-sm text-zinc-100">{r.text}</div>
          case 'assistant': return <div key={`m${r.seq}`} className={`my-2 ${r.agent ? 'ml-5 opacity-70' : ''}`}><Markdown text={r.text} /></div>
          case 'info': return <div key={`i${r.seq}`} className="my-2 text-center text-xs text-zinc-600">{r.text}</div>
          case 'tool': case 'reads': return <ToolItem key={`t${r.seq}`} item={r} base={base} onOpenFile={onOpenFile} />
          case 'agent': return <ToolItem key={`a${r.seq}`} item={r} live={liveAgent?.[r.id]} />
          case 'artifact': return <ArtifactCard key={`f${r.seq}`} item={r} machine={machine} base={base} onOpen={onOpenFile} />
        }
      })}
      {live && <div className="my-2"><Markdown text={live} /><span aria-hidden className="inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-zinc-400" /></div>}
      {last?.kind === 'thinking' && !live && <div className="my-1 text-xs italic text-zinc-600">thinking…</div>}
    </div>
  )
}
