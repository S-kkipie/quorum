import { useState } from 'react'
import { sendPrompt, type PromptMode } from '../lib/api'
import type { SessionInfo } from '../proto.gen'

export function composerBlock(s: SessionInfo): string {
  if (s.role === 'service') return 'Sesión de servicio'
  if (s.state === 'closed') return 'Sesión cerrada'
  return ''
}

export default function Composer({ session }: { session: SessionInfo }) {
  const [text, setText] = useState('')
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
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'no se pudo enviar')
    } finally {
      setBusy(false)
    }
  }

  const off = !!block || busy || !text.trim()
  const btn = 'rounded px-3 py-1.5 text-sm disabled:opacity-40'
  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {block && <p className="px-1 pb-1 text-xs text-zinc-500">{block}</p>}
      {error && <p role="alert" className="px-1 pb-1 text-xs text-red-400">{error}</p>}
      <textarea
        value={text}
        disabled={!!block}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="Escribe un mensaje…"
        className="w-full resize-none rounded border border-zinc-800 bg-zinc-900 p-2 text-sm disabled:opacity-40"
      />
      <div className="mt-1 flex flex-wrap justify-end gap-2">
        <button disabled={off} onClick={() => go('interrupt')} className={`${btn} bg-zinc-800 text-amber-300`}>Interrumpir y enviar</button>
        <button disabled={off} onClick={() => go('queue')} className={`${btn} bg-zinc-800`}>En cola</button>
        <button disabled={off} onClick={() => go(session.state === 'idle' ? 'queue' : 'now')} className={`${btn} bg-blue-600 text-white`}>Enviar</button>
      </div>
    </div>
  )
}
