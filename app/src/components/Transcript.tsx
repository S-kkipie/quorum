import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Shimmer } from '@/components/ai-elements/shimmer'
import type { Event } from '../proto.gen'
import { buildTimeline } from '../lib/timeline'
import ArtifactCard from './timeline/ArtifactCard'
import ToolItem from './timeline/ToolItem'

/**
 * Conversation sticks to the bottom on its own; this adds what it lacks: loading earlier
 * events when the reader scrolls near the top, and keeping the position when they arrive.
 */
function HistoryLoader({ firstSeq, hasMore, autoLoad, onLoadMore }: {
  firstSeq?: number; hasMore?: boolean; autoLoad: boolean; onLoadMore?: () => void
}) {
  const { scrollRef, state } = useStickToBottomContext()
  const prevH = useRef(0)
  const latest = useRef({ hasMore, autoLoad, onLoadMore })
  latest.current = { hasMore, autoLoad, onLoadMore }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const l = latest.current
      if (el.scrollTop < 40 && l.hasMore && l.autoLoad) l.onLoadMore?.()
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollRef])

  // Earlier events were prepended while reading near the top: keep the same content in view.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prevH.current && !state.isAtBottom && el.scrollTop < 40) el.scrollTop = el.scrollHeight - prevH.current
    prevH.current = el.scrollHeight
  }, [firstSeq]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { prevH.current = scrollRef.current?.scrollHeight ?? 0 })
  return null
}

export default function Transcript({ events, base = '', machine = '', live, liveAgent, working, hasMore, autoLoad = true, onLoadMore, onOpenFile }: {
  autoLoad?: boolean
  events: Event[]
  /** session root, else cwd: decides which artifact cards can be opened */
  base?: string
  machine?: string
  live?: string
  liveAgent?: Record<string, string>
  /** the session is working: shows an indicator while no text streams */
  working?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  /** opens a file of the session in the viewer */
  onOpenFile?: (path: string) => void
}) {
  const rows = useMemo(() => buildTimeline(events, base), [events, base])
  const last = events[events.length - 1]
  const thinking = last?.kind === 'thinking'
  const indicator = live ? '' : thinking ? 'Thinking…' : working ? 'Working…' : ''

  return (
    <Conversation className="min-h-0" initial="instant">
      <ConversationContent className="gap-0 px-3 py-2 sm:px-4">
        {hasMore && <button type="button" onClick={onLoadMore} className="mx-auto mb-2 block min-h-11 text-xs text-zinc-500 hover:text-zinc-300">Load earlier</button>}
        {rows.map((r) => {
          switch (r.t) {
            case 'user': return (
              <Message key={`u${r.seq}`} from="user" role="article" aria-label="You" className="my-3 max-w-[85%]">
                <MessageContent className="whitespace-pre-wrap break-words text-zinc-100 group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-blue-600/25 group-[.is-user]:px-3.5 group-[.is-user]:py-2">{r.text}</MessageContent>
              </Message>
            )
            case 'assistant': return (
              <Message key={`m${r.seq}`} from="assistant" role="article" aria-label={r.agent ? 'Subagent' : 'Claude'} className={`my-2 max-w-full ${r.agent ? 'ml-5 w-auto opacity-70' : ''}`}>
                <MessageContent className="w-full break-words text-zinc-200"><MessageResponse>{r.text}</MessageResponse></MessageContent>
              </Message>
            )
            case 'info': return <Message key={`i${r.seq}`} from="system" role="note" className="my-2 max-w-full text-center text-xs text-zinc-600">{r.text}</Message>
            case 'tool': case 'reads': return <ToolItem key={`t${r.seq}`} item={r} base={base} onOpenFile={onOpenFile} />
            case 'agent': return <ToolItem key={`a${r.seq}`} item={r} live={liveAgent?.[r.id]} />
            case 'artifact': return <ArtifactCard key={`f${r.seq}`} item={r} machine={machine} base={base} onOpen={onOpenFile} />
          }
        })}
        {live && (
          <Message from="assistant" role="article" aria-label="Claude" className="my-2 max-w-full">
            <MessageContent className="w-full break-words text-zinc-200">
              <MessageResponse isAnimating>{live}</MessageResponse>
              <span aria-hidden className="inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-zinc-400" />
            </MessageContent>
          </Message>
        )}
        {indicator && <div role="status" className="my-2"><Shimmer as="span" className="text-xs">{indicator}</Shimmer></div>}
      </ConversationContent>
      <ConversationScrollButton aria-label="Scroll to bottom" className="size-11" />
      <HistoryLoader firstSeq={events[0]?.seq} hasMore={hasMore} autoLoad={autoLoad} onLoadMore={onLoadMore} />
    </Conversation>
  )
}
