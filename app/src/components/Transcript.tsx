import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { ChevronsUp, Loader2 } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { PathLinksProvider } from '@/components/ai-elements/pathLinks'
import { Shimmer } from '@/components/ai-elements/shimmer'
import type { Event } from '../proto.gen'
import { formatTokens } from '../lib/meters'
import { buildTimeline, itemKey, type Item, type OpenOpts } from '../lib/timeline'
import ArtifactCard from './timeline/ArtifactCard'
import CommandCard from './timeline/CommandCard'
import PastedImages from './timeline/PastedImages'
import ToolItem from './timeline/ToolItem'
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

/** A row of the virtual list: a timeline item, the collapsed earlier conversation, or the top row. */
type Row = { key: string } & ({ kind: 'item'; item: Item } | { kind: 'earlier'; count: number } | { kind: 'head' })

/** A request to scroll to a row by its key; a new `n` asks again for the same key. */
export type Focus = { key: string; n: number }

/** A row height before it is measured. */
const ESTIMATE = 72

/**
 * The scroll element's size; one that is not laid out (hidden, or a test DOM) counts as a screenful
 * so the first rows still render.
 */
const observeRect: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (r) => cb(r.height > 0 ? r : { width: r.width, height: window.innerHeight || 800 }))

/** Renders only the rows near the viewport of the Conversation's scroll element; heights are measured. */
function VirtualRows({ rows, render, focus }: { rows: Row[]; render: (r: Row) => ReactNode; focus?: Focus }) {
  const { scrollRef } = useStickToBottomContext()
  const list = useRef<HTMLDivElement>(null)
  // the scroll element's ref is attached after this child's layout effects: render again once it is
  const [, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATE,
    getItemKey: (i) => rows[i].key,
    overscan: 6,
    scrollMargin: list.current?.offsetTop ?? 0,
    observeElementRect: observeRect,
  })
  // scroll to the requested row once it is in the list (a folded one is unfolded by the parent first)
  const done = useRef(0)
  const at = focus ? rows.findIndex((r) => r.key === focus.key) : -1
  useEffect(() => {
    if (!focus || at < 0 || done.current === focus.n) return
    done.current = focus.n
    v.scrollToIndex(at, { align: 'center' })
  }, [focus, at, v])
  const items = v.getVirtualItems()
  const margin = v.options.scrollMargin
  return (
    <div ref={list} className="relative w-full" style={{ height: v.getTotalSize() }}>
      {items.map((it) => (
        // flex column: the rows' own vertical margins stay inside the measured box
        <div key={it.key} data-index={it.index} ref={v.measureElement} className="absolute left-0 top-0 flex w-full flex-col"
          style={{ transform: `translateY(${it.start - margin}px)` }}>
          {render(rows[it.index])}
        </div>
      ))}
    </div>
  )
}

const pad2 = (n: number) => String(n).padStart(2, '0')
/** Local wall-clock time, HH:MM. */
export const hhmm = (ms: number) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

/**
 * Claude's answers: Newsreader at 15.5 px / 1.6, capped near 70 characters a line on wide screens
 * (code inside stays monospace; index.css tunes Streamdown's code blocks).
 */
const answer = 'w-full max-w-[70ch] break-words font-serif text-[15.5px] leading-[1.6] text-ink'

export default function Transcript({ events, base = '', worktrees, machine = '', sessionId = '', live, liveAgent, working, bgEnded, hasMore, autoLoad = true, loading, notice, onLoadMore, onAtBottom, onOpenFile, focus }: {
  /** scrolls to a row (the inspector's changed files) */
  focus?: Focus
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
  const items = useMemo(() => buildTimeline(events, base, wts), [events, base, wts])
  const last = events[events.length - 1]
  const thinking = last?.kind === 'thinking'
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
      for (const it of items.slice(newestCompact)) out.push({ key: itemKey(it), kind: 'item', item: it })
      return out
    }
    if (notice || loading || hasMore) out.push({ key: 'head', kind: 'head' })
    for (const it of items) out.push({ key: itemKey(it), kind: 'item', item: it })
    return out
  }, [items, collapsed, newestCompact, notice, loading, hasMore])
  // a row folded away by a compact is unfolded when the inspector asks for it
  const wantFolded = !!focus && collapsed && !rows.some((r) => r.key === focus.key) && items.some((it) => itemKey(it) === focus.key)
  const [unfoldedFor, setUnfoldedFor] = useState(0)
  if (wantFolded && focus && unfoldedFor !== focus.n) { setUnfoldedFor(focus.n); setExpanded(true) }
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
  const linkBase = onOpenFile ? base : ''

  const renderItem = (r: Item): ReactNode => {
    switch (r.t) {
      case 'user': return r.command ? (
        <Message from="user" role="article" aria-label="You" className="my-3 max-w-[85%]">
          <MessageContent data-testid="command-prompt" className="whitespace-pre-wrap break-all font-mono text-xs text-ink group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-bubble group-[.is-user]:px-3 group-[.is-user]:py-1.5">
            {r.command.args ? `/${r.command.name} ${r.command.args}` : `/${r.command.name}`}
          </MessageContent>
        </Message>
      ) : (
        <Message from="user" role="article" aria-label="You" className="my-3 max-w-[85%]">
          <MessageContent className="whitespace-pre-wrap break-words text-ink group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-bubble group-[.is-user]:px-3.5 group-[.is-user]:py-2">
            {r.text}
            {r.images && <PastedImages machine={machine} sessionId={sessionId} images={r.images} onOpen={onOpenFile ? openImage : undefined} />}
          </MessageContent>
        </Message>
      )
      case 'assistant': return (
        <Message from="assistant" role="article" aria-label={r.agent ? 'Subagent' : 'Claude'} className={`my-2 max-w-full ${r.agent ? 'ml-5 w-auto opacity-70' : ''}`}>
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
      case 'agent': return <ToolItem item={r} live={liveAgent?.[r.id]} bgEnded={bgEnded} />
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
      <ConversationContent className="gap-0 px-3 py-2 sm:px-4">
        <VirtualRows rows={rows} render={renderRow} focus={focus} />
        {live && (
          <Message from="assistant" role="article" aria-label="Claude" className="my-2 max-w-full">
            <MessageContent className={answer}>
              <MessageResponse isAnimating>{live}</MessageResponse>
              <span aria-hidden className="inline-block h-3.5 w-1.5 animate-pulse motion-reduce:animate-none rounded-sm bg-muted-foreground" />
            </MessageContent>
          </Message>
        )}
        {indicator && <div role="status" className="my-2"><Shimmer as="span" className="text-xs">{indicator}</Shimmer></div>}
      </ConversationContent>
      <ConversationScrollButton aria-label="Scroll to bottom" className="size-11" />
      <HistoryLoader firstKey={firstKey} hasMore={hasMore} autoLoad={autoLoad && !collapsed && !notice && !loading} onLoadMore={loadOlder} onAtBottom={onAtBottom} />
    </Conversation>
    </PathLinksProvider>
  )
}
