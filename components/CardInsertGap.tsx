'use client'

import { useState } from 'react'

interface Props {
  onClick: () => void
  isDragging: boolean
}

export default function CardInsertGap({ onClick, isDragging }: Props) {
  const [hovered, setHovered] = useState(false)

  // Hold the resting gap height during drag so cards don't twitch vertically on pickup
  if (isDragging) return <div style={{ height: 6 }} />

  return (
    <div
      className="relative mx-2 flex items-center justify-center cursor-pointer"
      style={{ height: hovered ? 28 : 6, transition: 'height 120ms ease' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      {hovered && (
        <>
          {/* Sleek dashed horizontal line via SVG for dash control */}
          <svg className="absolute inset-x-0 top-1/2 -translate-y-px w-full pointer-events-none" height="1" xmlns="http://www.w3.org/2000/svg">
            <line x1="0" y1="0.5" x2="100%" y2="0.5" stroke="rgba(0,117,169,0.55)" strokeWidth="1" strokeDasharray="5 10" />
          </svg>
          {/* FTE gradient plus button */}
          <button
            type="button"
            className="relative z-10 w-6 h-6 rounded-full flex items-center justify-center text-white text-sm font-bold shadow-lg hover:scale-110 transition-transform"
            style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
            onClick={(e) => { e.stopPropagation(); onClick() }}
          >
            +
          </button>
        </>
      )}
    </div>
  )
}
