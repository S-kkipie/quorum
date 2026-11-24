import type { PastedImage } from '../../lib/timeline'
import ViewThumb, { resetViewLinks } from './ViewThumb'

/** Test hook: forgets the cached view links. */
export const resetPastedImageLinks = resetViewLinks

/** Thumbnails (64 px) of the images the owner pasted in the terminal; a tap opens the Viewer. */
export default function PastedImages({ machine, sessionId, images, onOpen }: {
  machine: string; sessionId: string; images: PastedImage[]; onOpen?: (path: string, o: { images: true }) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((im) => (
        <ViewThumb key={`${im.n}\u0000${im.path}`} machine={machine} sessionId={sessionId} path={im.path} mode="images"
          label={`Image #${im.n}`} onOpen={onOpen ? () => onOpen(im.path, { images: true }) : undefined} />
      ))}
    </div>
  )
}
