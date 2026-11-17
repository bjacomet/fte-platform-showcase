'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { CardFlight } from '@/types'

interface Props {
  cardId: string
  doneColumnId: string | null
  onColumnChanged: (cardId: string, columnId: string) => void
  /** Fires after any flight edit or void — hosts that render flight data elsewhere (Copy Tracker timeline) refresh on it */
  onFlightsChanged?: () => void
}

function toLocalDatetimeValue(iso: string) {
  // Convert UTC ISO string to local datetime-local input value
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDisplay(iso: string | null) {
  if (!iso) return 'Still running'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export default function FlightsTab({ cardId, doneColumnId: _doneColumnId, onColumnChanged, onFlightsChanged }: Props) {
  const supabase = createClient()
  const [flights, setFlights] = useState<CardFlight[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<{ went_live_at: string; went_dark_at: string }>({ went_live_at: '', went_dark_at: '' })
  const [voidingId, setVoidingId] = useState<string | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchFlights = useCallback(async () => {
    const { data } = await supabase
      .from('card_flights')
      .select('*')
      .eq('card_id', cardId)
      .order('went_live_at', { ascending: false })
    setFlights(data ?? [])
    setLoading(false)
  }, [cardId, supabase])

  useEffect(() => {
    void (async () => { await fetchFlights() })()
  }, [fetchFlights])

  async function handleSaveEdit(flight: CardFlight) {
    setSaving(true)
    const updates: Partial<CardFlight> = {
      went_live_at: new Date(editValues.went_live_at).toISOString(),
    }
    if (editValues.went_dark_at) {
      updates.went_dark_at = new Date(editValues.went_dark_at).toISOString()
    } else {
      updates.went_dark_at = null
    }
    await supabase.from('card_flights').update(updates).eq('id', flight.id)
    setEditingId(null)
    setSaving(false)
    fetchFlights()
    onFlightsChanged?.()
  }

  async function handleVoid(flight: CardFlight) {
    if (!voidReason.trim()) return
    setSaving(true)

    // Void the flight
    await supabase.from('card_flights').update({
      voided: true,
      void_reason: voidReason.trim(),
      went_dark_at: flight.went_dark_at ?? new Date().toISOString(),
    }).eq('id', flight.id)

    // Snap card back to previous column if we have one
    if (flight.previous_column_id) {
      await supabase.from('cards').update({
        column_id: flight.previous_column_id,
        updated_at: new Date().toISOString(),
      }).eq('id', cardId)
      onColumnChanged(cardId, flight.previous_column_id)
    }

    setVoidingId(null)
    setVoidReason('')
    setSaving(false)
    fetchFlights()
    onFlightsChanged?.()
  }

  if (loading) {
    return <div className="p-4 text-sm text-gray-400">Loading flights…</div>
  }

  if (flights.length === 0) {
    return (
      <div className="p-6 text-center">
        <div className="w-10 h-10 rounded-full bg-gray-700/50 flex items-center justify-center mx-auto mb-3">
          <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <p className="text-sm text-gray-400">No flight history yet.</p>
        <p className="text-xs text-gray-500 mt-1">Move this card to the Live column or use the toggle above.</p>
      </div>
    )
  }

  return (
    <div className="divide-y divide-gray-700/50">
      {flights.map((flight) => (
        <div key={flight.id} className={`p-4 ${flight.voided ? 'opacity-50' : ''}`}>
          {/* Header row */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              {!flight.voided && !flight.went_dark_at && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-green-400 bg-green-950/60 border border-green-800/50 rounded-full px-2 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
                  LIVE
                </span>
              )}
              {flight.voided && (
                <span className="text-[10px] font-semibold text-red-400 bg-red-950/60 border border-red-800/50 rounded-full px-2 py-0.5">
                  VOIDED
                </span>
              )}
              <span className="text-[10px] text-gray-500">
                {flight.triggered_by === 'manual' ? 'Manual' : 'Column move'}
              </span>
            </div>
            {!flight.voided && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setEditingId(flight.id)
                    setEditValues({
                      went_live_at: toLocalDatetimeValue(flight.went_live_at),
                      went_dark_at: flight.went_dark_at ? toLocalDatetimeValue(flight.went_dark_at) : '',
                    })
                  }}
                  className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-700/50 transition-colors"
                >
                  Edit dates
                </button>
                <button
                  onClick={() => { setVoidingId(flight.id); setVoidReason('') }}
                  className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-950/40 transition-colors"
                >
                  Void
                </button>
              </div>
            )}
          </div>

          {/* Edit mode */}
          {editingId === flight.id ? (
            <div className="space-y-2 mt-2">
              <div>
                <label className="text-[10px] text-gray-400 block mb-1">Went live</label>
                <input
                  type="datetime-local"
                  value={editValues.went_live_at}
                  onChange={(e) => setEditValues((v) => ({ ...v, went_live_at: e.target.value }))}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="text-[10px] text-gray-400 block mb-1">Went dark <span className="text-gray-500">(leave blank if still running)</span></label>
                <input
                  type="datetime-local"
                  value={editValues.went_dark_at}
                  onChange={(e) => setEditValues((v) => ({ ...v, went_dark_at: e.target.value }))}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleSaveEdit(flight)}
                  disabled={saving}
                  className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1.5 rounded transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded hover:bg-gray-700/50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-300 space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500 w-16 flex-none">Live:</span>
                <span>{formatDisplay(flight.went_live_at)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500 w-16 flex-none">Dark:</span>
                <span className={!flight.went_dark_at && !flight.voided ? 'text-green-400' : ''}>
                  {formatDisplay(flight.went_dark_at)}
                </span>
              </div>
            </div>
          )}

          {/* Void mode */}
          {voidingId === flight.id && (
            <div className="mt-3 p-3 bg-red-950/20 border border-red-800/30 rounded-lg space-y-2">
              <p className="text-xs text-red-300">
                This will mark the flight as voided
                {flight.previous_column_id ? ' and snap the card back to its previous column.' : '.'}
              </p>
              <input
                type="text"
                placeholder="Reason for voiding (required)"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                className="w-full bg-gray-900 border border-red-800/50 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-red-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => handleVoid(flight)}
                  disabled={saving || !voidReason.trim()}
                  className="text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded transition-colors"
                >
                  Confirm void
                </button>
                <button
                  onClick={() => setVoidingId(null)}
                  className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded hover:bg-gray-700/50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Void reason display */}
          {flight.voided && flight.void_reason && (
            <p className="text-xs text-gray-500 mt-1">Reason: {flight.void_reason}</p>
          )}
        </div>
      ))}
    </div>
  )
}
