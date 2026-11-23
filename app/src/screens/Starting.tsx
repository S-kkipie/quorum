import { useEffect, useState } from 'react'
import { timedOut, type Pending } from '../lib/launch'

/** "Arrancando Claude en <máquina>…": la app navega sola a la sesión cuando el hub avisa. */
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
        <p className="text-sm text-zinc-400">No hay un lanzamiento en curso.</p>
      ) : pending.error ? (
        <p role="alert" className="text-sm text-red-400">{pending.error}</p>
      ) : late ? (
        <p role="alert" className="text-sm text-amber-400">Claude no se registró en 60 s</p>
      ) : (
        <>
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" aria-hidden />
          <p className="text-sm text-zinc-200">Arrancando Claude en {pending.machine}…</p>
        </>
      )}
      <div className="flex gap-2">
        {pending?.pane && late && terminal && (
          <button onClick={() => onViewTerminal?.(pending.machine, pending.pane!)} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">Ver en terminal</button>
        )}
        <button onClick={onBack} className="rounded bg-zinc-800 px-3 py-1.5 text-sm">Volver</button>
      </div>
    </div>
  )
}
