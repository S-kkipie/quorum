import * as React from 'react'
import { Progress as ProgressPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/** shadcn Progress (new-york), with an `indicatorClassName` so callers can tone the bar. */
function Progress({ className, value, indicatorClassName, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }) {
  return (
    <ProgressPrimitive.Root data-slot="progress" className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-chip', className)} {...props}>
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn('h-full w-full flex-1 bg-accent transition-transform motion-reduce:transition-none', indicatorClassName)}
        style={{ transform: `translateX(-${100 - Math.min(100, Math.max(0, value || 0))}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
