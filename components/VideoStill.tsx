'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * A still frame from a video, mounted only once it is near the viewport.
 *
 * WHY LAZY. These are MP4 creatives, and a surface can hold a lot of them — the
 * Atlas board carries ~60 and the Lookbook grows a campaign every month. Mounting
 * every <video> at once means the browser opens that many range requests for
 * metadata, and Supabase storage does not advertise Accept-Ranges on these
 * objects, so they queue: in testing, 0 of 60 had painted a frame after 20
 * seconds. Deferring until a card is nearly on screen is what makes the frames
 * actually appear.
 *
 * The seek itself is in the `src` — see videoStillSrc / AD_STILL_SECONDS in
 * lib/mediaKind.ts. Without the media fragment a <video> paints a black box.
 *
 * Extracted from components/atlas/AtlasBoard.tsx, where it started, because the
 * Lookbook needed the same thing and a second copy is how the isVideo helpers
 * drifted apart in the first place.
 */
export default function VideoStill({ src, className = '' }: { src: string; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (show) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      // Deferred rather than set inline: a synchronous setState in an effect
      // triggers a cascading render, and the lint rule is right to flag it.
      const id = setTimeout(() => setShow(true), 0)
      return () => clearTimeout(id)
    }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) setShow(true) },
      // Start a little before it scrolls in so the frame is usually there by
      // the time the card is actually looked at.
      { rootMargin: '300px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [show])

  return (
    <div ref={ref} className={className}>
      {show && (
        <video
          src={src}
          muted
          playsInline
          preload="metadata"
          className="absolute inset-0 w-full h-full object-contain"
        />
      )}
    </div>
  )
}
