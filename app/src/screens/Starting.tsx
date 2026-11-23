import { useEffect, useState } from 'react'
import { timedOut, type Pending } from '../lib/launch'

/** "Starting Claude on <machine>…": the app navigates to the session by itself when the hub reports it. */
export default function Starting({ pending, terminal = false, onBack, onViewTerminal }: { pending: Pending | null; terminal?: boolean; onBack: () => void; onViewTerminal?: (machine: string, pane: string) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const late = !!pending && !pending.error && timedOut(pending, now)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      {!pending ? (
        <p className="text-sm text-zinc-400">No launch in progress.</p>
      ) : pending.error ? (
        <p role="alert" className="text-sm text-red-400">{pending.error}</p>
      ) : late ? (
        <p role="alert" className="text-sm text-amber-400">Claude did not register within 60 s</p>
      ) : (
        <>
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" aria-hidden />
          <p className="text-sm text-zinc-200">Starting Claude on {pending.machine}…</p>
        </>
      )}
      <div className="flex gap-2">
        {pending?.pane && late && terminal && (
          <button onClick={() => onViewTerminal?.(pending.machine, pending.pane!)} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">View in terminal</button>
        )}
        <button onClick={onBack} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Back</button>
      </div>
    </div>
  )
}
