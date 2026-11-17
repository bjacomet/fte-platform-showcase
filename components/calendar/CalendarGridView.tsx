'use client'

import type { Card } from '@/types'
import { buildMonthGridDays, groupCardsByDay } from '@/lib/calendar'
import {
  deriveCardStatus,
  mediaStyle,
  statusStyle,
} from './mediaTypeStyles'

interface Props {
  cards: Card[]
  year: number
  month: number
  /** Image URL keyed by card.id (null when no image yet). */
  imageUrlByCardId: Record<string, string | null>
  /** Click on a card bar → open the card drawer. */
  onCardClick: (card: Card) => void
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export default function CalendarGridView({
  cards,
  year,
  month,
  imageUrlByCardId,
  onCardClick,
}: Props) {
  const days = buildMonthGridDays(year, month)
  const byDay = groupCardsByDay(cards)

  return (
    <div className="px-4 py-4">
      {/* Weekday header */}
      <div className="grid grid-cols-7 gap-px bg-gray-700/60 border border-gray-700/60 rounded-t-lg overflow-hidden">
        {WEEKDAYS.map((wd) => (
          <div
            key={wd}
            className="bg-[#0f1117] text-[11px] font-medium text-gray-500 text-center py-2 uppercase tracking-wider"
          >
            {wd}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-px bg-gray-700/60 border border-gray-700/60 border-t-0 rounded-b-lg overflow-hidden">
        {days.map((d) => {
          const dayCards = byDay[d.iso] ?? []
          const firstCard = dayCards[0]
          const moreCount = dayCards.length - 1

          return (
            <div
              key={d.iso}
              className={`min-h-[96px] p-1.5 ${
                d.inMonth ? 'bg-[#0f1117] hover:bg-[#161922]' : 'bg-[#0a0c12]'
              } transition-colors`}
            >
              {/* Day number, with today pill highlight */}
              <div className="flex items-start justify-between mb-1">
                <span
                  className={
                    d.isToday
                      ? 'inline-flex items-center justify-center min-w-[20px] h-[20px] rounded-full bg-blue-600 text-white text-[11px] font-semibold px-1.5'
                      : d.inMonth
                      ? 'text-[11px] font-medium text-gray-400 px-1'
                      : 'text-[11px] font-medium text-gray-700 px-1'
                  }
                >
                  {d.day}
                </span>
              </div>

              {/* First card bar */}
              {firstCard && (
                <button
                  type="button"
                  onClick={() => onCardClick(firstCard)}
                  className="w-full text-left rounded h-7 px-1.5 flex items-center gap-1 overflow-hidden hover:opacity-90 transition-opacity"
                  style={{ background: mediaStyle(firstCard.media_type).barBg }}
                  title={firstCard.title}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{
                      background: statusStyle(
                        deriveCardStatus(firstCard, Boolean(imageUrlByCardId[firstCard.id]))
                      ).dot,
                    }}
                    aria-hidden="true"
                  />
                  <span className="text-[10px] text-white/90 truncate flex-1">
                    {firstCard.title}
                  </span>
                </button>
              )}

              {/* "+N more" pill for multi-post days */}
              {moreCount > 0 && (
                <button
                  type="button"
                  onClick={() => onCardClick(dayCards[1])}
                  className="mt-1 text-[10px] text-gray-400 bg-gray-800/80 hover:bg-gray-700 hover:text-gray-200 rounded px-1.5 py-0.5 transition-colors"
                >
                  +{moreCount} more
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Legend */}
      <div className="mt-4 flex flex-wrap items-center gap-4 text-[11px] text-gray-500">
        <span className="font-medium text-gray-400">Status:</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: '#5dcaa5' }} />
          Approved
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: '#85b7eb' }} />
          Scheduled
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: '#fac775' }} />
          Needs image
        </span>
        <span className="ml-auto text-gray-600">
          Click a post to open card · drag images on Feed view to attach
        </span>
      </div>
    </div>
  )
}
