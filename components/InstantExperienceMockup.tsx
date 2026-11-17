'use client'

import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IEBlock, IECarouselBlock } from '@/types'
import { isVideoUrl } from '@/lib/mediaKind'

// Shared, presentational render of a Facebook Instant Experience — a phone frame
// with a vertically-scrolling stack of blocks (header, text, image, inner carousel,
// video, button). Muted-autoplay video; swipeable inner carousel. Used by both the
// Card Drawer editor (live preview, no pins) and the Adviewer preview (with per-block
// pin overlays injected via the `pinLayer` render-prop). Purely visual — no data writes.

interface IEMockupProps {
  blocks: IEBlock[]
  cover?: {
    imageUrl?: string | null
    pageName?: string | null
    logoUrl?: string | null
    bodyText?: string | null
  } | null
  /**
   * Optional per-block overlay (Adviewer injects a PinOverlay here). Rendered
   * absolutely-positioned over each block. Omit for a plain display preview.
   */
  pinLayer?: (block: IEBlock) => ReactNode
  className?: string
}

function MutedVideo({ src }: { src: string }) {
  return (
    <video
      src={src}
      muted
      autoPlay
      loop
      playsInline
      className="w-full h-auto block bg-black"
    />
  )
}

// Inner image carousel — swipeable horizontal strip with scroll-snap + arrows.
// Center-peek: each slide is slightly narrower than the frame so the edge of the
// next (and previous) image peeks in, signalling there's more to swipe. Borrowed
// from the Carousel Ad mockup's center-peek treatment; native scroll-snap keeps the
// swipe feeling real. A dots + "1 / N" row and a one-time "Swipe →" hint make it
// unmistakably a set rather than a single image.
function InnerCarousel({ block }: { block: IECarouselBlock }) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [idx, setIdx] = useState(0)
  const [showHint, setShowHint] = useState(true)
  const images = block.images.filter((im) => im.url)

  const go = (dir: 1 | -1) => {
    const track = trackRef.current
    if (!track) return
    setShowHint(false)
    const next = Math.max(0, Math.min(images.length - 1, idx + dir))
    setIdx(next)
    const child = track.children[next] as HTMLElement | undefined
    child?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }

  if (!images.length) {
    return <div className="w-full aspect-square bg-gray-200 flex items-center justify-center text-[11px] text-gray-500">Image carousel (no images yet)</div>
  }

  const multi = images.length > 1

  return (
    <div className="bg-black">
      <div className="relative">
        <div
          ref={trackRef}
          className="flex overflow-x-auto snap-x snap-mandatory no-scrollbar"
          // Padding lets the first/last slide reach the frame's center (center-peek);
          // scroll-snap-center pulls each slide true-center on release.
          style={{ scrollbarWidth: 'none', ...(multi ? { paddingInline: '7%', scrollPaddingInline: '7%' } : {}) }}
          onScroll={(e) => {
            if (showHint) setShowHint(false)
            // Nearest-to-center detection (getBoundingClientRect) — robust to the
            // narrower slides, unlike scrollLeft/clientWidth rounding.
            const el = e.currentTarget
            const mid = el.getBoundingClientRect().left + el.clientWidth / 2
            let nearest = 0, best = Infinity
            Array.from(el.children).forEach((c, i) => {
              const r = (c as HTMLElement).getBoundingClientRect()
              const d = Math.abs((r.left + r.width / 2) - mid)
              if (d < best) { best = d; nearest = i }
            })
            if (nearest !== idx) setIdx(nearest)
          }}
        >
          {images.map((im) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={im.id} src={im.url as string} alt="" className={`flex-none snap-center object-cover aspect-square ${multi ? 'w-[86%]' : 'w-full'}`} />
          ))}
        </div>
        {multi && (
          <>
            {idx > 0 && (
              <button onClick={(e) => { e.stopPropagation(); go(-1) }} className="absolute left-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/55 text-white flex items-center justify-center text-sm z-10">‹</button>
            )}
            {idx < images.length - 1 && (
              <button onClick={(e) => { e.stopPropagation(); go(1) }} className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/55 text-white flex items-center justify-center text-sm z-10">›</button>
            )}
            <div className={`pointer-events-none absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-black/60 text-white text-[10px] font-semibold transition-opacity duration-700 ${showHint ? 'opacity-100' : 'opacity-0'}`}>Swipe →</div>
          </>
        )}
      </div>
      {multi && (
        <div className="flex items-center justify-center gap-2 py-1.5 bg-white">
          <div className="flex items-center gap-1">
            {images.map((im, i) => (
              <span key={im.id} className={`h-1.5 rounded-full transition-all duration-200 ${i === idx ? 'w-4 bg-gray-800' : 'w-1.5 bg-gray-300'}`} />
            ))}
          </div>
          <span className="text-[10px] text-gray-500 tabular-nums">{idx + 1} / {images.length}</span>
        </div>
      )}
    </div>
  )
}

function BlockBody({ block }: { block: IEBlock }) {
  switch (block.type) {
    case 'header':
      if (!block.media_url) return <Placeholder label={block.media_kind === 'video' ? 'Header video' : 'Header image'} tall />
      return block.media_kind === 'video' || isVideoUrl(block.media_url)
        ? <MutedVideo src={block.media_url} />
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={block.media_url} alt="" className="w-full h-auto block" />
    case 'text':
      return (
        <p className="px-4 py-3 text-[13px] leading-relaxed text-gray-800 whitespace-pre-wrap"
          style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
          {block.text || <span className="text-gray-400">Text block…</span>}
        </p>
      )
    case 'image':
      return block.media_url
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={block.media_url} alt="" className="w-full h-auto block" />
        : <Placeholder label="Image" />
    case 'image_carousel':
      return <InnerCarousel block={block} />
    case 'video':
      return block.media_url ? <MutedVideo src={block.media_url} /> : <Placeholder label="Video" tall />
    case 'button':
      return (
        <div className="px-4 py-3">
          <div className="w-full text-center bg-[#1877f2] text-white text-[13px] font-semibold rounded-md py-2.5 px-4 truncate">
            {block.label || 'Button'}
          </div>
        </div>
      )
    default:
      return null
  }
}

function Placeholder({ label, tall }: { label: string; tall?: boolean }) {
  return (
    <div className={`w-full ${tall ? 'aspect-[9/16] max-h-72' : 'aspect-video'} bg-gray-200 flex items-center justify-center text-[11px] text-gray-500`}>
      {label} — no media yet
    </div>
  )
}

export default function InstantExperienceMockup({ blocks, cover, pinLayer, className }: IEMockupProps) {
  const pageName = cover?.pageName?.trim() || 'Your Page'
  return (
    <div className={`mx-auto ${className ?? ''}`} style={{ width: 320 }}>
      {/* Phone frame */}
      <div className="rounded-[2.2rem] border-[10px] border-gray-900 bg-gray-900 shadow-2xl overflow-hidden">
        {/* Notch */}
        <div className="relative bg-black h-6">
          <div className="absolute left-1/2 -translate-x-1/2 top-1.5 w-24 h-3 bg-black rounded-b-xl" />
        </div>
        {/* Scrollable canvas */}
        <div className="bg-white h-[560px] overflow-y-auto no-scrollbar" style={{ scrollbarWidth: 'none' }}>
          {/* Cover header — the outer feed ad that opens the experience */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
            {cover?.logoUrl
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={cover.logoUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
              : <div className="w-8 h-8 rounded-full bg-[#1877f2] text-white flex items-center justify-center text-xs font-bold">{pageName.slice(0, 1).toUpperCase()}</div>}
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-gray-900 truncate">{pageName}</div>
              <div className="text-[10px] text-gray-500">Sponsored · Instant Experience</div>
            </div>
          </div>
          {cover?.bodyText?.trim() && (
            <p className="px-3 py-2 text-[12px] text-gray-800">{cover.bodyText}</p>
          )}

          {blocks.length === 0 && (
            <div className="p-8 text-center text-[12px] text-gray-400">Add blocks to build the experience.</div>
          )}

          {blocks.map((block) => (
            <div key={block.id} className="relative">
              <BlockBody block={block} />
              {pinLayer?.(block)}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
