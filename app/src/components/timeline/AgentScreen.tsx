import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Bot, ChevronLeft, ChevronsUp } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Conversation, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { formatTokens } from '../../lib/meters'
import { shownKey, type SessionTimeline, type Shown } from '../../lib/subagents'
import type { Ask } from '../../proto.gen'
import AskCard from '../AskCard'
import VirtualRows from './VirtualRows'
import { agentClock, agentPhase, PHASE_LABEL, PhaseIcon, steps, useNow } from './AgentCard'

/**
 * The subagents' colour: the accent tokens re-pointed to the background-state violet for this
 * subtree, so focus rings, links and accent pills read as "inside a subagent".
 */
const VIOLET = {
  '--accent': 'var(--state-background)',
  '--accent-soft': 'var(--state-background-soft)',
  '--primary': 'var(--state-background)',
  '--ring': 'var(--state-background)',
} as CSSProperties

/** Items a subagent screen renders at first; older ones come back with "Show earlier". */
export const SHOWN_MAX = 100

/** Claude's answers, as the main transcript sets them. */
const answer = 'w-full max-w-[70ch] break-words font-serif text-[15.5px] leading-[1.6] text-ink'

/** The scroll region: a ScrollArea whose viewport is the stick-to-bottom scroller. */
function Scroll({ children }: { children: ReactNode }) {
  const { scrollRef, contentRef } = useStickToBottomContext()
  return (
    <ScrollArea className="size-full" viewportRef={scrollRef}>
      <div ref={contentRef} className="flex flex-col px-3 py-2 sm:px-4">{children}</div>
    </ScrollArea>
  )
}

/**
 * A subagent's own screen, over the session (its composer and scroll stay as they were): its task,
 * its steps and its answer with the transcript's own rows, its clock and step count. Its own
 * subagents are cards that open on top (Back returns to it). Full screen on a phone, a wide side
 * sheet on a desktop. Quorum has no way to stop a single subagent, so there is no Stop here.
 */
export default function AgentScreen({ stack, tl, liveAgent, bgEnded, asking, sessionId = '', asks = [], onAskDone, render, onBack, onClose }: {
  /** the open subagents by stable key, outermost first: the last one is shown */
  stack: string[]
  /** keys of the subagents an ask waits on */
  asking?: ReadonlySet<string>
  /** the session's open asks: answerable here too, pinned under every screen */
  sessionId?: string
  asks?: Ask[]
  onAskDone?: (askId: string) => void
  tl: SessionTimeline
  /** streamed text of running subagents, by id */
  liveAgent?: Record<string, string>
  bgEnded?: (taskId: string) => boolean
  /** renders one row exactly as the main transcript does */
  render: (r: Shown) => ReactNode
  onBack: () => void
  onClose: () => void
}) {
  const id = stack[stack.length - 1]
  const a = id ? tl.agents.get(id) : undefined
  // the screen's own key: its stable key, so a card whose ids fill in later keeps its screen
  return (
    <Sheet open={!!a} onOpenChange={(o) => { if (!o) onClose() }}>
      {a && (
        <SheetContent side="right" showCloseButton={false} data-testid="agent-screen"
          className="w-full gap-0 border-line bg-background p-0 pt-[env(safe-area-inset-top,0px)] sm:max-w-none lg:w-[min(48rem,64vw)]">
          {/* the violet accent covers the subagent's own part; asks keep the session's colours */}
          <div data-testid="agent-accent" style={VIOLET} className="flex min-h-0 flex-1 flex-col">
            <Body key={a.key} id={a.key} tl={tl} live={liveAgent?.[a.id]} bgEnded={bgEnded} asking={!!asking?.has(a.key)} render={render} onBack={onBack}
              backLabel={stack.length > 1 ? 'Back to the parent subagent' : 'Back to the session'} />
          </div>
          {asks.length > 0 && (
            <div data-testid="agent-asks" className="max-h-[50dvh] shrink-0 overflow-y-auto border-t border-line pb-[env(safe-area-inset-bottom,0px)]">
              {asks.map((q) => <AskCard key={q.askId} session={sessionId} ask={q} onDone={() => onAskDone?.(q.askId)} />)}
            </div>
          )}
        </SheetContent>
      )}
    </Sheet>
  )
}

function Body({ id, tl, live, bgEnded, asking, render, onBack, backLabel }: {
  id: string; tl: SessionTimeline; live?: string; bgEnded?: (taskId: string) => boolean; asking: boolean
  render: (r: Shown) => ReactNode; onBack: () => void; backLabel: string
}) {
  const a = tl.agents.get(id)!
  const phase = agentPhase(a, bgEnded, asking)
  const working = phase === 'running' || phase === 'asking' || phase === 'background'
  const now = useNow(working && !!a.startedAt)
  const clock = agentClock(a, phase, now)
  const rows = tl.byAgent.get(id) ?? []
  const [more, setMore] = useState(0)
  const cap = SHOWN_MAX + more
  const hidden = Math.max(0, rows.length - cap)
  const list = useMemo(() => (hidden ? rows.slice(hidden) : rows).map((item) => ({ key: shownKey(item), item })), [rows, hidden])
  const answered = rows.some((r) => r.t === 'assistant')
  const parent = a.agent ? tl.agents.get(a.agent) : undefined
  return (
    <>
      <header className="flex min-w-0 items-center gap-2 border-b border-line px-1.5 py-1.5">
        <button type="button" onClick={onBack} aria-label={backLabel} title="Back"
          className="press flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-chip active:bg-chip">
          <ChevronLeft size={20} aria-hidden />
        </button>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-state-background-soft text-state-background">
          <Bot size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-sm font-medium text-ink">{a.description || 'Subagent'}</SheetTitle>
          <SheetDescription className="truncate text-xs text-muted-foreground">
            {[a.type || 'subagent', parent ? `inside ${parent.description || 'a subagent'}` : ''].filter(Boolean).join(' · ')}
          </SheetDescription>
        </div>
        <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${phase === 'asking' ? 'bg-state-needs-soft text-state-needs' : 'bg-accent-soft text-accent'}`}>
          <PhaseIcon phase={phase} />{PHASE_LABEL[phase]}
        </span>
      </header>
      <div className="flex flex-wrap gap-1.5 px-3 py-2 text-xs text-muted-foreground">
        {clock && <span className="rounded-full bg-chip px-2.5 py-1 tabular-nums">{clock}</span>}
        {(!!a.steps || working) && <span className="rounded-full bg-chip px-2.5 py-1">{steps(a.steps)}</span>}
        {!!a.tokens && <span className="rounded-full bg-chip px-2.5 py-1">{`${formatTokens(a.tokens)} tok`}</span>}
      </div>
      <Conversation className="min-h-0 flex-1" initial="instant">
        <Scroll>
          {a.prompt && (
            <Message from="user" role="article" aria-label="Task" className="my-3 max-w-[85%]">
              <MessageContent className="whitespace-pre-wrap break-words text-ink group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-bubble group-[.is-user]:px-3.5 group-[.is-user]:py-2">
                {a.prompt}
              </MessageContent>
            </Message>
          )}
          {hidden > 0 && (
            <button type="button" onClick={() => setMore((m) => m + SHOWN_MAX)}
              className="press my-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-line text-sm text-muted-foreground hover:text-ink">
              <ChevronsUp size={16} aria-hidden />{`Show earlier (${hidden})`}
            </button>
          )}
          <VirtualRows rows={list} render={(r) => render(r.item)} />
          {working && live && (
            <Message from="assistant" role="article" aria-label="Subagent" className="my-2 max-w-full">
              <MessageContent className={answer}><MessageResponse isAnimating>{live}</MessageResponse></MessageContent>
            </Message>
          )}
          {!working && a.answer && !answered && (
            <Message from="assistant" role="article" aria-label="Subagent" className="my-2 max-w-full">
              <MessageContent className={answer}><MessageResponse>{a.answer}</MessageResponse></MessageContent>
            </Message>
          )}
          {!rows.length && !live && !(a.answer && !working) && (
            <p className="my-8 text-center text-sm text-muted-foreground">
              {working ? 'Nothing from this subagent yet.' : 'This session did not record its steps.'}
            </p>
          )}
        </Scroll>
        <ConversationScrollButton aria-label="Scroll to bottom" className="size-11" />
      </Conversation>
    </>
  )
}
