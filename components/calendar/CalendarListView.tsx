'use client'

import type { Card, Client } from '@/types'
import {
  formatDayOfWeekShort,
  formatMonthDayShort,
} from '@/lib/calendar'
import {
  deriveCardStatus,
  mediaStyle,
  statusStyle,
} from './mediaTypeStyles'

interface Props {
  cards: Card[]
  /** Image URL keyed by card.id (null when no image yet). */
  imageUrlByCardId: Record<string, string | null>
  /** Lookup of client by id, for showing client name on each row. */
  clientsById: Record<string, Client | null | undefined>
  onCardClick: (card: Card) => void
}

export default function CalendarListView({
  cards,
  imageUrlByCardId,
  clientsById,
  onCardClick,
}: Props) {
  // Sort by flight_start_date so the list reads top-down through the month.
  const sorted = [...cards].sort((a, b) => {
    const ad = a.flight_start_date ?? ''
    const bd = b.flight_start_date ?? ''
    return ad.localeCompare(bd)
  })

  // Summary line
  const summary = (() => {
    let approved = 0
    let needsImage = 0
    let scheduled = 0
    for (const c of sorted) {
      const s = deriveCardStatus(c, Boolean(imageUrlByCardId[c.id]))
      if (s === 'approved') approved++
      else if (s === 'needs_image') needsImage++
      else scheduled++
    }
    const parts: string[] = [`${sorted.length} post${sorted.length === 1 ? '' : 's'}`]
    if (approved) parts.push(`${approved} approved`)
    if (scheduled) parts.push(`${scheduled} scheduled`)
    if (needsImage) parts.push(`${needsImage} need image${needsImage === 1 ? '' : 's'}`)
    return parts.join(' · ')
  })()

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] uppercase tracking-wider font-medium text-gray-500">
          Posts this month
        </p>
        <p className="text-xs text-gray-400">{summary}</p>
      </div>

      <div className="border border-gray-700/60 rounded-lg overflow-hidden divide-y divide-gray-700/60">
        {sorted.map((card) => {
          const ms = mediaStyle(card.media_type)
          const hasImage = Boolean(imageUrlByCardId[card.id])
          const status = deriveCardStatus(card, hasImage)
          const ss = statusStyle(status)
          const client = card.client_id ? clientsById[card.client_id] : null

          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onCardClick(card)}
              className="w-full flex items-center gap-3 px-3 py-2.5 bg-[#0f1117] hover:bg-[#161922] transition-colors text-left"
            >
              {/* Date column */}
              <div className="w-16 flex-shrink-0">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">
                  {formatDayOfWeekShort(card.flight_start_date)}
                </div>
                <div className="text-sm font-medium text-gray-200">
                  {formatMonthDayShort(card.flight_start_date)}
                </div>
              </div>

              {/* Thumbnail */}
              <div className="w-11 h-11 flex-shrink-0 rounded-md overflow-hidden bg-gray-800 border border-gray-700 flex items-center justify-center">
                {hasImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrlByCardId[card.id] ?? ''}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <svg
                    className="w-4 h-4 text-gray-600"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                )}
              </div>

              {/* Title + client */}
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-gray-500 truncate">
                  {client?.name ?? ' '}
                </div>
                <div className="text-sm font-medium text-gray-200 truncate">
                  {card.title || '(Untitled)'}
                </div>
              </div>

              {/* Media-type pill */}
              <span
                className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium flex-shrink-0"
                style={{ background: ms.pillBg, color: ms.pillText }}
              >
                {ms.label}
              </span>

              {/* Status pill */}
              <span
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium flex-shrink-0"
                style={{ background: ss.pillBg, color: ss.pillText }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: ss.dot }}
                  aria-hidden="true"
                />
                {ss.label}
              </span>

              {/* Chevron */}
              <svg
                className="w-4 h-4 text-gray-600 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )
        })}
      </div>
    </div>
  )
}
