import { useRef, useState } from 'react'
import { clearDraft, loadDraft, saveDraft, useDraft } from '../lib/drafts'
import { ArrowUp, Brain, ChevronUp, ListPlus, Zap } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PromptInput, PromptInputButton, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { pluginCommand, sendPrompt, type PromptMode } from '../lib/api'
import { addArgs, taskTextError } from '../lib/afterQueue'
import { pluginStateChanged } from '../lib/pluginBus'
import type { SessionInfo } from '../proto.gen'

export function composerBlock(s: SessionInfo): string {
  if (s.role === 'service') return 'Service session'
  if (s.state === 'closed') return 'Session closed'
  return ''
}

// use-haiku reads a leading `_`, think-hard a leading `+`. Each strips only its own mark and which
// plugin sees the text first is not under our control, so combining marks is unreliable: the chips are
// mutually exclusive and at most one prefix is added. Text already carrying the mark is left alone.
export function applyPrefixes(text: string, o: { haiku: boolean; think: boolean }): string {
  if (o.haiku) return text.startsWith('_') ? text : '_' + text
  if (o.think) return text.startsWith('+') ? text : '+' + text
  return text
}

export default function Composer({ session }: { session: SessionInfo }) {
  // A replaced session (new id, previousId = old id) keeps the same draft.
  const draftRef = useRef(session.id)
  if (draftRef.current !== session.id && session.previousId !== draftRef.current) draftRef.current = session.id
  const draftId = draftRef.current
  // A replaced session starts with its predecessor's draft (moved under the new id).
  const migrated = useRef(false)
  if (!migrated.current) {
    migrated.current = true
    if (session.previousId && !loadDraft(session.id)) {
      const old = loadDraft(session.previousId)
      if (old) { saveDraft(session.id, old); clearDraft(session.previousId) }
    }
  }
  const [text, setText, clearText] = useDraft(draftId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const block = composerBlock(session)
  const [haiku, setHaiku] = useState(false)
  const [think, setThink] = useState(false)
  const working = session.state === 'working'
  // The Haiku chip is disabled while working: un-press it instead of keeping a pressed, disabled chip.
  const [wasWorking, setWasWorking] = useState(working)
  if (working !== wasWorking) {
    setWasWorking(working)
    if (working) setHaiku(false)
  }
  const hasHaiku = (session.plugins ?? []).includes('use-haiku')
  const hasThink = (session.plugins ?? []).includes('think-hard')
  // use-haiku ignores `_` mid-turn, so no Haiku prefix is sent while Claude is working.
  const prefixes = { haiku: hasHaiku && haiku && !working, think: hasThink && think }

  // `viaAfter` is only for the explicit Queue menu item: Send on an idle session also uses mode
  // 'queue' but must stay a normal prompt (with its chip prefix).
  async function go(mode: PromptMode, queueItem = false) {
    const t = text.trim()
    if (!t || busy || block) return
    const viaAfter = queueItem && (session.plugins ?? []).includes('after')
    if (viaAfter) {
      const bad = taskTextError(t)
      if (bad) { setError(bad); return }
    }
    setBusy(true)
    setError('')
    try {
      if (viaAfter) {
        await pluginCommand(session.id, 'after', addArgs(t))
        pluginStateChanged(session.id, 'after') // the queue section reads the new task
      }
      else await sendPrompt(session.id, applyPrefixes(t, prefixes), mode)
      clearText()
      setHaiku(false)
      setThink(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not send')
    } finally {
      setBusy(false)
    }
  }

  const off = !!block || busy || !text.trim()
  // 'now' joins a running turn; with no turn running (idle, background, waiting) Send is a normal prompt
  const send: PromptMode = session.state === 'working' || session.state === 'needs_you' ? 'now' : 'queue'
  const btn = 'min-h-11 gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40'
  const chipCls = (on: boolean) => `inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm disabled:opacity-40 ${on ? 'border-blue-500 bg-blue-600/20 text-blue-200' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`
  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {block && <p className="px-1 pb-1 text-xs text-zinc-500">{block}</p>}
      {error && <p role="alert" className="px-1 pb-1 text-xs text-red-400">{error}</p>}
      {(hasHaiku || hasThink) && (
        <div className="flex flex-wrap gap-2 px-1 pb-2">
          {hasHaiku && (
            <button type="button" aria-pressed={haiku} disabled={!!block || working} title={working ? 'Haiku applies when Claude is idle' : 'Send this prompt to Haiku'} className={chipCls(haiku)} onClick={() => { setHaiku(!haiku); setThink(false) }}><Zap size={14} aria-hidden />Haiku</button>
          )}
          {hasThink && (
            <button type="button" aria-pressed={think} disabled={!!block} title="Ask for maximum effort" className={chipCls(think)} onClick={() => { setThink(!think); setHaiku(false) }}><Brain size={14} aria-hidden />Think hard</button>
          )}
        </div>
      )}
      {/* Send is the submit button; the draft lives in useDraft, not in the form */}
      <PromptInput onSubmit={() => go(send)} className="[&_[data-slot=input-group]]:rounded-xl [&_[data-slot=input-group]]:border-zinc-800 [&_[data-slot=input-group]]:bg-zinc-900">
        <PromptInputTextarea
          value={text}
          disabled={!!block}
          onChange={(e) => setText(e.target.value)}
          submitOn="mod-enter"
          rows={2}
          placeholder="Type a message…"
          className="min-h-14 px-3 py-2 text-sm placeholder:text-zinc-600 disabled:opacity-40"
        />
        <PromptInputFooter className="justify-end gap-2 px-2 pb-2">
          <PromptInputSubmit disabled={off} aria-label="Send" size="sm" className={`${btn} bg-blue-600 font-medium text-white hover:bg-blue-500`}><ArrowUp size={14} aria-hidden />Send</PromptInputSubmit>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <PromptInputButton variant="secondary" size="sm" aria-label="More send options" title="More send options" className={`${btn} size-11 shrink-0 bg-zinc-800 px-0 text-zinc-200 hover:bg-zinc-700`}><ChevronUp size={16} aria-hidden /></PromptInputButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuItem className="min-h-11 gap-2.5 px-3" disabled={off} onSelect={() => go('queue', true)}><ListPlus size={14} aria-hidden className="text-zinc-400" />Queue</DropdownMenuItem>
              <DropdownMenuItem className="min-h-11 gap-2.5 px-3 text-amber-300" disabled={off} onSelect={() => go('interrupt')}><Zap size={14} aria-hidden />Interrupt and send</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
