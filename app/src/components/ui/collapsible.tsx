"use client"

import { cn } from "@/lib/utils"

import { Collapsible as CollapsiblePrimitive } from "radix-ui"

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

/**
 * Opens and closes by animating its measured height (Radix sets --radix-collapsible-content-height):
 * 200 ms in, 150 ms out, strong ease-out; instant under reduced motion. Keep padding on a child, since
 * a padded box cannot shrink to 0.
 */
function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        "overflow-hidden duration-200 ease-out data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up data-[state=closed]:duration-150 motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
