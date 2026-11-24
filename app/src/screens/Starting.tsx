import { useEffect, useState } from 'react'
import { timedOut, type Pending } from '../lib/launch'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

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
          <Spinner className="size-6 text-blue-500" />
          <p className="text-sm text-zinc-200">Starting Claude on {pending.machine}…</p>
        </>
      )}
      <div className="flex gap-2">
        {pending?.pane && late && terminal && (
          <Button className="min-h-11" onClick={() => onViewTerminal?.(pending.machine, pending.pane!)}>View in terminal</Button>
        )}
        <Button variant="secondary" className="min-h-11" onClick={onBack}>Back</Button>
      </div>
    </div>
  )
}
