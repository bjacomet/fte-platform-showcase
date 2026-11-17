'use client'

import type { CardFlight, Card } from '@/types'

interface GanttRow {
  card: Card
  flights: CardFlight[]
}

interface Props {
  rows: GanttRow[]
  minDate: Date
  maxDate: Date
  onOpenCard?: (card: Card) => void
}

function pct(date: Date, min: Date, max: Date) {
  const range = max.getTime() - min.getTime()
  if (range === 0) return 0
  return Math.max(0, Math.min(100, ((date.getTime() - min.getTime()) / range) * 100))
}

function formatMonth(d: Date) {
  return d.toLocaleString(undefined, { month: 'short', year: '2-digit' })
}

function buildMonthTicks(min: Date, max: Date) {
  const ticks: { label: string; pct: number }[] = []
  const cursor = new Date(min.getFullYear(), min.getMonth(), 1)
  while (cursor <= max) {
    ticks.push({ label: formatMonth(cursor), pct: pct(cursor, min, max) })
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return ticks
}

export default function GanttChart({ rows, minDate, maxDate, onOpenCard }: Props) {
  const today = new Date()
  const effectiveMax = maxDate > today ? maxDate : today
  const ticks = buildMonthTicks(minDate, effectiveMax)
  const todayPct = pct(today, minDate, effectiveMax)

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-gray-500">
        No flight history found for the selected filters.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: 600 }}>
        {/* Month tick labels */}
        <div className="relative h-6 mb-1 ml-40">
          {ticks.map((tick, i) => (
            <span
              key={i}
              className="absolute text-[10px] text-gray-500 -translate-x-1/2"
              style={{ left: `${tick.pct}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>

        {/* Rows */}
        <div className="space-y-1.5">
          {rows.map(({ card, flights }) => (
            <div key={card.id} className="flex items-center gap-2">
              {/* Card label */}
              <button
                onClick={() => onOpenCard?.(card)}
                className="flex-none w-40 text-left text-xs text-gray-300 hover:text-white truncate pr-2 transition-colors"
                title={card.title}
              >
                {card.title}
              </button>

              {/* Bar track */}
              <div className="relative flex-1 h-6 bg-gray-800/60 rounded overflow-hidden">
                {/* Today line */}
                {todayPct >= 0 && todayPct <= 100 && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-blue-400/60 z-10"
                    style={{ left: `${todayPct}%` }}
                  />
                )}

                {/* Flight bars */}
                {flights.map((flight) => {
                  const startPct = pct(new Date(flight.went_live_at), minDate, effectiveMax)
                  const endDate = flight.went_dark_at ? new Date(flight.went_dark_at) : today
                  const endPct = pct(endDate, minDate, effectiveMax)
                  const widthPct = Math.max(0.5, endPct - startPct)
                  const isLive = !flight.went_dark_at && !flight.voided

                  return (
                    <div
                      key={flight.id}
                      className={`absolute top-1 bottom-1 rounded transition-all ${
                        flight.voided
                          ? 'bg-gray-600/50 border border-gray-500/30'
                          : isLive
                            ? 'bg-green-500/70 border border-green-400/50'
                            : 'bg-blue-500/70 border border-blue-400/30'
                      }`}
                      style={{ left: `${startPct}%`, width: `${widthPct}%` }}
                      title={`${new Date(flight.went_live_at).toLocaleDateString()} → ${flight.went_dark_at ? new Date(flight.went_dark_at).toLocaleDateString() : 'Still live'}`}
                    >
                      {isLive && (
                        <span className="absolute right-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse" />
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-4 ml-40 text-[10px] text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2 rounded-sm bg-green-500/70 border border-green-400/50 inline-block" /> Currently live
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2 rounded-sm bg-blue-500/70 border border-blue-400/30 inline-block" /> Past flight
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2 rounded-sm bg-gray-600/50 border border-gray-500/30 inline-block" /> Voided
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-px h-3 bg-blue-400/60 inline-block" /> Today
          </span>
        </div>
      </div>
    </div>
  )
}
