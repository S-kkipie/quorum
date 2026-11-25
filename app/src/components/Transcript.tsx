import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronsUp, Loader2 } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Conversation, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { PathLinksProvider } from '@/components/ai-elements/pathLinks'
import { Shimmer } from '@/components/ai-elements/shimmer'
import type { Ask, Event } from '../proto.gen'
import { formatTokens } from '../lib/meters'
import { buildTimeline, type OpenOpts } from '../lib/timeline'
import { askingAgents, partitionTimeline, shownKey, type Shown } from '../lib/subagents'
import { agentPhase, live as isLive } from './timeline/AgentCard'
import ArtifactCard from './timeline/ArtifactCard'
import CommandCard from './timeline/CommandCard'
import PastedImages from './timeline/PastedImages'
import UploadedFiles from './timeline/UploadedFiles'
import { splitUploads } from '../lib/attachments'
import ToolItem from './timeline/ToolItem'
import AgentCard from './timeline/AgentCard'
import AgentScreen from './timeline/AgentScreen'
import VirtualRows from './timeline/VirtualRows'
import TaskCard from './TaskCard'

/**
 * Conversation sticks to the bottom on its own; this adds what it lacks: loading earlier
 * events when the reader scrolls near the top, keeping the position when they arrive, and telling
 * the session whether the reader is at the bottom (memory is trimmed only then).
 */
function HistoryLoader({ firstKey, hasMore, autoLoad, onLoadMore, onAtBottom }: {
  firstKey?: string; hasMore?: boolean; autoLoad: boolean; onLoadMore?: () => void; onAtBottom?: (at: boolean) => void
}) {
  const { scrollRef, state, isAtBottom } = useStickToBottomContext()
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

  // Earlier rows were prepended while reading near the top: keep the same content in view.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prevH.current && !state.isAtBottom && el.scrollTop < 40) el.scrollTop = el.scrollHeight - prevH.current
    prevH.current = el.scrollHeight
  }, [firstKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { prevH.current = scrollRef.current?.scrollHeight ?? 0 })
  useEffect(() => { onAtBottom?.(isAtBottom) }, [isAtBottom, onAtBottom])
  return null
}

/**
 * StickToBottom.Content with a ScrollArea as the scroll element: the Radix viewport takes the
 * stick-to-bottom scroll ref, so the virtualizer, the loader and the stick all work on it.
 */
function TranscriptScroll({ className, children }: { className?: string; children: ReactNode }) {
  const { scrollRef, contentRef } = useStickToBottomContext()
  return (
    <ScrollArea className="size-full" viewportRef={scrollRef}>
      <div ref={contentRef} className={cn('flex flex-col', className)}>{children}</div>
    </ScrollArea>
  )
}

/** A row of the virtual list: a timeline item, the collapsed earlier conversation, or the top row. */
type Row = { key: string } & ({ kind: 'item'; item: Shown } | { kind: 'earlier'; count: number } | { kind: 'head' })

/** A request to scroll to a row by its key; a new `n` asks again for the same key. */
export type Focus = { key: string; n: number }

const pad2 = (n: number) => String(n).padStart(2, '0')
/** Local wall-clock time, HH:MM. */
export const hhmm = (ms: number) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

/**
 * Claude's answers: Newsreader at 15.5 px / 1.6, capped near 70 characters a line on wide screens
 * (code inside stays monospace; index.css tunes Streamdown's code blocks).
 */
const answer = 'w-full max-w-[70ch] break-words font-serif text-[15.5px] leading-[1.6] text-ink'

export default function Transcript({ events, base = '', worktrees, machine = '', sessionId = '', live, liveAgent, working, bgEnded, asks, onAskDone, hasMore, autoLoad = true, loading, notice, onLoadMore, onAtBottom, onOpenFile, focus }: {
  /** scrolls to a row (the inspector's changed files) */
  focus?: Focus
  /** the session's open asks: also answerable on a subagent's screen, and shown on its card */
  asks?: Ask[]
  onAskDone?: (askId: string) => void
  autoLoad?: boolean
  events: Event[]
  /** session root, else cwd: decides which artifact cards can be opened */
  base?: string
  /** the git worktrees of the session's repo: files in them open too */
  worktrees?: readonly string[]
  machine?: string
  /** the session's id: pasted-image thumbnails ask the hub for links with it */
  sessionId?: string
  live?: string
  liveAgent?: Record<string, string>
  /** the session is working: shows an indicator while no text streams */
  working?: boolean
  hasMore?: boolean
  /** an older page is being read */
  loading?: boolean
  /** why older history cannot be read now (e.g. its machine is offline); offers Try again */
  notice?: string
  onLoadMore?: () => void
  /** whether the reader is at the bottom of the transcript */
  onAtBottom?: (at: boolean) => void
  /** opens a file of the session in the viewer (`images`: a pasted image; `read`: an image Claude read) */
  onOpenFile?: (path: string, o?: OpenOpts) => void
  /** true when a background task no longer runs although no task_end was seen (it left the session's live items) */
  bgEnded?: (taskId: string) => boolean
}) {
  // a stable list while its contents stay the same (every session update brings a new array)
  const wtKey = (worktrees ?? []).join('\u0000')
  const wts = useMemo(() => (wtKey ? wtKey.split('\u0000') : []), [wtKey])
  // the main conversation only: each subagent's work lives on its own screen (its card opens it)
  const tl = useMemo(() => partitionTimeline(buildTimeline(events, base, wts)), [events, base, wts])
  const items = tl.main
  const [openStack, setAgentStack] = useState<string[]>([])
  // a screen whose subagent left the timeline (history trimmed, session replaced) closes
  const agentStack = openStack.filter((k) => tl.agents.has(k))
  const asking = useMemo(() => askingAgents(tl, asks ?? [], (a) => isLive(agentPhase(a, bgEnded))), [tl, asks, bgEnded])
  const openAgent = useCallback((id: string) => setAgentStack((s) => (s[s.length - 1] === id ? s : [...s, id])), [])
  const last = events[events.length - 1]
  // a subagent thinking shows on its own screen, not as the session's indicator
  const thinking = last?.kind === 'thinking' && !last.data?.agent
  const indicator = live ? '' : thinking ? 'Thinking…' : working ? 'Working…' : ''

  // Everything before the newest compact folds into one row until the reader asks for it (a tap,
  // or loading older history, which they would not want folded away).
  const [expanded, setExpanded] = useState(false)
  let newestCompact = -1
  for (let i = items.length - 1; i >= 0; i--) if (items[i].t === 'compact') { newestCompact = i; break }
  // a compact newer than the one the reader unfolded folds the conversation again
  const compactSeq = newestCompact >= 0 ? items[newestCompact].seq : undefined
  const [foldedAt, setFoldedAt] = useState(compactSeq)
  if (compactSeq !== foldedAt) {
    setFoldedAt(compactSeq)
    if (foldedAt !== undefined && compactSeq !== undefined && compactSeq > foldedAt) setExpanded(false)
  }
  const collapsed = !expanded && newestCompact >= 0 && (newestCompact > 0 || !!hasMore)
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    if (collapsed) {
      if (notice || loading) out.push({ key: 'head', kind: 'head' })
      const count = items.slice(0, newestCompact).filter((r) => r.t === 'user' || (r.t === 'assistant' && !r.agent)).length
      out.push({ key: 'earlier', kind: 'earlier', count })
      // subagents still working stay in view: their cards are pinned under the fold
      for (const it of items.slice(0, newestCompact)) {
        const busy = it.t === 'agent' ? it.status === 'running' : it.t === 'agents' && it.agents.some((a) => a.status === 'running')
        if (busy) out.push({ key: shownKey(it), kind: 'item', item: it })
      }
      for (const it of items.slice(newestCompact)) out.push({ key: shownKey(it), kind: 'item', item: it })
      return out
    }
    if (notice || loading || hasMore) out.push({ key: 'head', kind: 'head' })
    for (const it of items) out.push({ key: shownKey(it), kind: 'item', item: it })
    return out
  }, [items, collapsed, newestCompact, notice, loading, hasMore])
  // a subagent's row is reached through its card in the main transcript
  const ownerKey = focus ? tl.owner.get(focus.key) : undefined
  const target = useMemo(() => (focus && ownerKey ? { key: ownerKey, n: focus.n } : focus), [focus, ownerKey])
  // a row folded away by a compact is unfolded when the inspector asks for it
  const wantFolded = !!target && collapsed && !rows.some((r) => r.key === target.key) && items.some((it) => shownKey(it) === target.key)
  const [unfoldedFor, setUnfoldedFor] = useState(0)
  if (wantFolded && target && unfoldedFor !== target.n) { setUnfoldedFor(target.n); setExpanded(true) }
  const firstKey = rows.find((r) => r.kind !== 'head')?.key

  const more = useRef(onLoadMore)
  more.current = onLoadMore
  const loadOlder = useCallback(() => { setExpanded(true); more.current?.() }, [])
  // unfolding shows what is in memory; it fetches only when nothing older than the compact is loaded
  const unfold = () => { setExpanded(true); if (newestCompact === 0) more.current?.() }

  // stable callback so answers do not re-render when the parent passes a fresh closure
  const open = useRef(onOpenFile)
  open.current = onOpenFile
  const openPath = useCallback((p: string) => open.current?.(p), [])
  const openImage = useCallback((p: string, o: { images: true }) => open.current?.(p, o), [])
  const openUpload = useCallback((p: string, o: { upload: true }) => open.current?.(p, o), [])
  const linkBase = onOpenFile ? base : ''

  const renderItem = (r: Shown): ReactNode => {
    switch (r.t) {
      case 'agents': return <AgentCard agents={r.agents} bgEnded={bgEnded} asking={asking} onOpen={openAgent} />
      case 'user': {
        // files attached from a device are mentioned as @<path> of the machine's uploads folder: shown as chips
        const cmdText = r.command ? (r.command.args ? `/${r.command.name} ${r.command.args}` : `/${r.command.name}`) : ''
        const { text: shown, files } = splitUploads(r.command ? cmdText : r.text)
        const attached = files.length > 0 && <UploadedFiles machine={machine} sessionId={sessionId} files={files} onOpen={onOpenFile ? openUpload : undefined} />
        return r.command ? (
          <Message from="user" role="article" aria-label="You" className="my-3 max-w-[85%]">
            <MessageContent data-testid="command-prompt" className="whitespace-pre-wrap break-all font-mono text-xs text-ink group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-bubble group-[.is-user]:px-3 group-[.is-user]:py-1.5">
              {shown}
              {attached}
            </MessageContent>
          </Message>
        ) : (
          <Message from="user" role="article" aria-label="You" className="my-3 max-w-[85%]">
            <MessageContent className="whitespace-pre-wrap break-words text-ink group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-bubble group-[.is-user]:px-3.5 group-[.is-user]:py-2">
              {shown}
              {attached}
              {r.images && <PastedImages machine={machine} sessionId={sessionId} images={r.images} onOpen={onOpenFile ? openImage : undefined} />}
            </MessageContent>
          </Message>
        )
      }
      case 'assistant': return (
        <Message from="assistant" role="article" aria-label={r.agent ? 'Subagent' : 'Claude'} className="my-2 max-w-full">
          <MessageContent className={answer}><MessageResponse>{r.text}</MessageResponse></MessageContent>
        </Message>
      )
      case 'turn': return (
        <div className="mb-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {r.tokens && <span>{`↑${formatTokens(r.tokens.in)} ↓${formatTokens(r.tokens.out)} · cache ${formatTokens(r.tokens.cache)}`}</span>}
          {/haiku/i.test(r.model) && <span>Answered by Haiku</span>}
        </div>
      )
      case 'info': return <Message from="system" role="note" className="my-2 max-w-full text-center text-xs text-muted-foreground">{r.text}</Message>
      case 'tool': case 'reads': return <ToolItem item={r} base={base} worktrees={wts} machine={machine} sessionId={sessionId} onOpenFile={onOpenFile} bgEnded={bgEnded} />
      case 'agent': return <AgentCard agents={[r]} bgEnded={bgEnded} asking={asking} onOpen={openAgent} />
      case 'artifact': return <ArtifactCard item={r} machine={machine} base={base} onOpen={onOpenFile} />
      case 'command': return <CommandCard item={r} />
      case 'compact': {
        const label = `Conversation compacted${r.at ? ` · ${hhmm(r.at)}` : ''}`
        return (
          <div role="separator" aria-label={label} className="my-4 flex items-center gap-2 text-xs text-muted-foreground">
            <span aria-hidden className="h-px flex-1 bg-line" />
            <span>{label}</span>
            {(r.trigger === 'auto' || r.trigger === 'manual') && <span className="rounded-md bg-chip px-1.5 py-0.5">{r.trigger}</span>}
            <span aria-hidden className="h-px flex-1 bg-line" />
          </div>
        )
      }
      case 'task_end': return <TaskCard item={r} />
    }
  }

  const renderRow = (row: Row): ReactNode => {
    if (row.kind === 'item') return renderItem(row.item)
    if (row.kind === 'earlier') return (
      <button type="button" onClick={unfold} className="press my-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-line text-sm text-muted-foreground hover:text-ink">
        <ChevronsUp size={16} aria-hidden />
        {`Earlier conversation${row.count ? ` (${row.count}${hasMore ? '+' : ''} ${row.count === 1 && !hasMore ? 'message' : 'messages'})` : ''}`}
      </button>
    )
    if (notice) return (
      <div className="mb-2 flex flex-col items-center gap-1 py-1 text-center text-xs text-muted-foreground">
        <p>{notice}</p>
        {hasMore && <button type="button" onClick={loadOlder} className="min-h-11 px-3 hover:text-ink">Try again</button>}
      </div>
    )
    if (loading) return <div role="status" className="mb-2 flex min-h-11 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} aria-hidden className="animate-spin motion-reduce:animate-none" />Loading earlier…</div>
    return <button type="button" onClick={loadOlder} className="mx-auto mb-2 block min-h-11 text-xs text-muted-foreground hover:text-ink">Load earlier</button>
  }

  return (
    <PathLinksProvider base={linkBase} worktrees={wts} onOpen={openPath}>
    <Conversation className="min-h-0" initial="instant">
      <TranscriptScroll className="px-3 py-2 sm:px-4">
        <VirtualRows rows={rows} render={renderRow} focus={target} />
        {live && (
          <Message from="assistant" role="article" aria-label="Claude" className="my-2 max-w-full">
            <MessageContent className={answer}>
              <MessageResponse isAnimating>{live}</MessageResponse>
              <span aria-hidden className="inline-block h-3.5 w-1.5 animate-pulse motion-reduce:animate-none rounded-sm bg-muted-foreground" />
            </MessageContent>
          </Message>
        )}
        {indicator && <div role="status" className="my-2"><Shimmer as="span" className="text-xs">{indicator}</Shimmer></div>}
      </TranscriptScroll>
      <ConversationScrollButton aria-label="Scroll to bottom" className="size-11" />
      <HistoryLoader firstKey={firstKey} hasMore={hasMore} autoLoad={autoLoad && !collapsed && !notice && !loading} onLoadMore={loadOlder} onAtBottom={onAtBottom} />
    </Conversation>
    <AgentScreen stack={agentStack} tl={tl} liveAgent={liveAgent} bgEnded={bgEnded} asking={asking} sessionId={sessionId} asks={asks} onAskDone={onAskDone} render={renderItem}
      onBack={() => setAgentStack(agentStack.slice(0, -1))} onClose={() => setAgentStack([])} />
    </PathLinksProvider>
  )
}
