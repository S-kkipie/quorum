import { useRef, useState, type KeyboardEvent } from 'react'
import { clearDraft, loadDraft, saveDraft, useDraft } from '../lib/drafts'
import { ArrowUp, ChevronUp, ListPlus, Zap } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PromptInput, PromptInputButton, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@/components/ai-elements/prompt-input'
import { runCommand, sendPrompt, type PromptMode } from '../lib/api'
import { blockReason, commandsReported, filterCommands, parseSlash, selectable, slashQuery } from '../lib/slash'
import SlashMenu, { optionId } from './SlashMenu'
import type { SessionCommand, SessionCommands, SessionInfo } from '../proto.gen'

export function composerBlock(s: SessionInfo): string {
  if (s.role === 'service') return 'Service session'
  if (s.state === 'closed') return 'Session closed'
  return ''
}

export default function Composer({ session, commands }: {
  session: SessionInfo
  /** the session's slash commands (undefined: never reported, an older mod) */
  commands?: SessionCommands
}) {
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
  const box = useRef<HTMLTextAreaElement>(null)

  // "/" typeahead: open while the text starts with "/" and the caret is in the command name
  const [caret, setCaret] = useState(text.length)
  const [escaped, setEscaped] = useState<string | null>(null)
  const [hint, setHint] = useState('')
  const [activeName, setActiveName] = useState<string | null>(null)
  const reported = commandsReported(commands)
  const query = block ? null : slashQuery(text, caret)
  const menuOpen = query !== null && escaped !== text
  const groups = menuOpen && reported ? filterCommands(commands.commands, query) : []
  const rows = groups.flatMap((g) => g.items)
  const runnable = rows.filter(selectable)
  // the highlighted row: the one moved to, else the first name that starts with the query (any group)
  const active = runnable.find((c) => c.name === activeName)
    ?? runnable.find((c) => c.name.toLowerCase().startsWith((query ?? '').toLowerCase())) ?? runnable[0]

  function edit(v: string, at = v.length) {
    setText(v)
    setCaret(at)
    setHint('')
  }

  function complete(c: SessionCommand) {
    if (!selectable(c)) { setHint('Only in the terminal'); return }
    const v = '/' + c.name + ' '
    edit(v)
    setActiveName(null)
    requestAnimationFrame(() => { box.current?.focus(); box.current?.setSelectionRange(v.length, v.length) })
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!menuOpen) return
    if (e.key === 'Escape') { e.preventDefault(); setEscaped(text); return }
    if (!runnable.length) return
    const i = active ? runnable.indexOf(active) : 0
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = runnable.length
      setActiveName(runnable[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n].name)
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey)) {
      e.preventDefault()
      if (active) complete(active)
    }
  }

  async function go(mode: PromptMode) {
    const t = text.trim()
    if (!t || busy || block) return
    const slash = parseSlash(text)
    let run: { name: string; args: string } | null = null
    if (slash) {
      const c = reported ? commands.commands.find((x) => x.name === slash.name) : undefined
      if (!c) { setError(`Unknown command /${slash.name.slice(0, 60)}. Start with a space to send it as text.`); return }
      const why = blockReason(c, slash.args)
      if (why) { setError(`/${c.name}: ${why}`); return }
      run = slash
    }
    setBusy(true)
    setError('')
    try {
      if (run) await runCommand(session.id, run.name, run.args)
      // a leading space keeps text that starts with "/" a plain prompt (it is not a command)
      else await sendPrompt(session.id, /^\s+\//.test(text) ? ' ' + t : t, mode)
      clearText()
      setCaret(0)
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
  return (
    <div className="relative border-t border-line bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {menuOpen && <SlashMenu groups={groups} reported={reported} active={active?.name} hint={hint} onPick={complete} />}
      {block && <p className="px-1 pb-1 text-xs text-muted-foreground">{block}</p>}
      {error && <p role="alert" className="px-1 pb-1 text-xs text-danger">{error}</p>}
      {/* Send is the submit button; the draft lives in useDraft, not in the form */}
      <PromptInput onSubmit={() => go(send)} className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:border-line [&_[data-slot=input-group]]:bg-surface [&_[data-slot=input-group]]:shadow-none">
        <PromptInputTextarea
          ref={box}
          value={text}
          disabled={!!block}
          onChange={(e) => edit(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? 'slash-menu' : undefined}
          aria-activedescendant={menuOpen && active ? optionId(rows.indexOf(active)) : undefined}
          submitOn="mod-enter"
          rows={2}
          placeholder="Type a message or / for commands"
          className="min-h-14 px-3 py-2 text-sm text-ink placeholder:text-muted-foreground disabled:opacity-40"
        />
        <PromptInputFooter className="justify-end gap-2 px-2 pb-2">
          <PromptInputSubmit disabled={off} aria-label="Send" size="sm" className={`${btn} bg-accent font-medium text-on-accent hover:bg-accent/90`}><ArrowUp size={14} aria-hidden />Send</PromptInputSubmit>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <PromptInputButton variant="secondary" size="sm" aria-label="More send options" title="More send options" className={`${btn} size-11 shrink-0 bg-chip px-0 text-ink hover:bg-line`}><ChevronUp size={16} aria-hidden /></PromptInputButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuItem className="min-h-11 gap-2.5 px-3" disabled={off} onSelect={() => go('queue')}><ListPlus size={14} aria-hidden className="text-muted-foreground" />Queue</DropdownMenuItem>
              <DropdownMenuItem className="min-h-11 gap-2.5 px-3 text-warning" disabled={off} onSelect={() => go('interrupt')}><Zap size={14} aria-hidden />Interrupt and send</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </PromptInputFooter>
      </PromptInput>
    </div>
  )
}
