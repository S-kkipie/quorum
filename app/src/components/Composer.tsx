import { useRef, useState } from 'react'
import { clearDraft, loadDraft, saveDraft, useDraft } from '../lib/drafts'
import { ArrowUp, ChevronUp, ListPlus, Zap } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PromptInput, PromptInputButton, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { sendPrompt, type PromptMode } from '../lib/api'
import type { SessionInfo } from '../proto.gen'

export function composerBlock(s: SessionInfo): string {
  if (s.role === 'service') return 'Service session'
  if (s.state === 'closed') return 'Session closed'
  return ''
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

  async function go(mode: PromptMode) {
    const t = text.trim()
    if (!t || busy || block) return
    setBusy(true)
    setError('')
    try {
      await sendPrompt(session.id, t, mode)
      clearText()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not send')
    } finally {
      setBusy(false)
    }
  }

  const off = !!block || busy || !text.trim()
  const send: PromptMode = session.state === 'idle' ? 'queue' : 'now'
  const btn = 'min-h-11 gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40'
  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {block && <p className="px-1 pb-1 text-xs text-zinc-500">{block}</p>}
      {error && <p role="alert" className="px-1 pb-1 text-xs text-red-400">{error}</p>}
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
              <DropdownMenuItem className="min-h-11 gap-2.5 px-3" disabled={off} onSelect={() => go('queue')}><ListPlus size={14} aria-hidden className="text-zinc-400" />Queue</DropdownMenuItem>
              <DropdownMenuItem className="min-h-11 gap-2.5 px-3 text-amber-300" disabled={off} onSelect={() => go('interrupt')}><Zap size={14} aria-hidden />Interrupt and send</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
