'use client'

import { useState, useEffect, useRef } from 'react'
import type { Card, Client, Column, PsInventoryUnit } from '@/types'
import { TEMPLATE_OPTIONS } from '@/types'
import { createClient } from '@/lib/supabase/client'
import { modalInputClass, modalLabelClass } from '@/lib/formStyles'
import InventoryPicker from './InventoryPicker'

interface Props {
  defaultColumnId: string
  columns: Column[]
  clients: Client[]
  onClose: () => void
  onCreated: (card: Card) => void
  insertAtPosition?: number
}

function buildInventoryDescription(unit: PsInventoryUnit): string {
  const lines: string[] = []
  if (unit.year || unit.make || unit.model) {
    lines.push(`${[unit.year, unit.make, unit.model, unit.trim].filter(Boolean).join(' ')}`)
  }
  if (unit.condition) lines.push(`Condition: ${unit.condition.charAt(0).toUpperCase() + unit.condition.slice(1)}`)
  if (unit.category) lines.push(`Category: ${unit.category.toUpperCase()}`)
  if (unit.price != null) {
    lines.push(`Price: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(unit.price)}`)
  }
  if (unit.msrp != null) {
    lines.push(`MSRP: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(unit.msrp)}`)
  }
  if (unit.stock_number) lines.push(`Stock #: ${unit.stock_number}`)
  if (unit.color) lines.push(`Color: ${unit.color}`)
  if (unit.mileage != null) lines.push(`Mileage: ${unit.mileage.toLocaleString()}`)
  if (unit.listing_url) lines.push(`Listing: ${unit.listing_url}`)
  return lines.join('\n')
}

export default function AddCardModal({ defaultColumnId, columns, clients, onClose, onCreated, insertAtPosition }: Props) {
  const [template, setTemplate] = useState<string>('')
  const [title, setTitle] = useState('')
  const [clientId, setClientId] = useState('')
  const [columnId, setColumnId] = useState(defaultColumnId)
  const [description, setDescription] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // Inventory picker state
  const [showInventoryPicker, setShowInventoryPicker] = useState(false)
  const [selectedUnit, setSelectedUnit] = useState<PsInventoryUnit | null>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleUnitSelect(unit: PsInventoryUnit | null) {
    setSelectedUnit(unit)

    if (!unit) {
      // Clear auto-filled fields if unit is deselected
      setTitle('')
      setDescription('')
      return
    }

    // Auto-fill title: "{Client}: {Year} {Make} {Model}"
    const unitLabel = [unit.year, unit.make, unit.model].filter(Boolean).join(' ')
    const selectedClient = clients.find((c) => c.id === clientId)
    const clientPrefix = selectedClient ? `${selectedClient.name}: ` : ''
    setTitle(`${clientPrefix}${unitLabel}`)

    // Auto-fill description with spec block
    setDescription(buildInventoryDescription(unit))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setError(null)
    setLoading(true)

    const supabase = createClient()

    let nextPosition: number

    if (insertAtPosition !== undefined) {
      // Inserting at a specific position — shift all cards at that position or below down by 1
      const { data: cardsToShift } = await supabase
        .from('cards')
        .select('id, position')
        .eq('column_id', columnId)
        .gte('position', insertAtPosition)
      if (cardsToShift && cardsToShift.length > 0) {
        await Promise.all(
          cardsToShift.map((c) =>
            supabase.from('cards').update({ position: c.position + 1 }).eq('id', c.id)
          )
        )
      }
      nextPosition = insertAtPosition
    } else {
      // Append to end of column (default behavior)
      const { data: existing } = await supabase
        .from('cards')
        .select('position')
        .eq('column_id', columnId)
        .order('position', { ascending: false })
        .limit(1)
      nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 0
    }

    const { data: newCard, error: insertError } = await supabase
      .from('cards')
      .insert({
        title: title.trim(),
        client_id: clientId || null,
        column_id: columnId,
        media_type: template || null,
        description: description.trim() || null,
        position: nextPosition,
        archived: false,
        inventory_unit_id: selectedUnit?.id ?? null,
        // New cards start at their client's tier (clients.tier); still editable on the card.
        ...(clients.find((c) => c.id === clientId)?.tier ? { tier: clients.find((c) => c.id === clientId)?.tier } : {}),
      })
      .select('*, clients(id, name, abbreviation, adpiler_campaign_code, fb_page_logo_url, utm_config)')
      .single()

    if (insertError || !newCard) {
      setError(insertError?.message ?? 'Failed to create card')
      setLoading(false)
      return
    }

    // Record who created the card so the creator shows in the card history feed.
    const { data: { user } } = await supabase.auth.getUser()
    const creatorEmail = user?.email ?? null
    await supabase.from('card_activity').insert({
      card_id: newCard.id,
      actor: creatorEmail ?? 'Team',
      actor_email: creatorEmail,
      action: 'created',
      detail: 'Card created',
    })

    setLoading(false)
    onCreated(newCard as Card)
  }

  const inputClass = modalInputClass
  const labelClass = modalLabelClass

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 shrink-0">
          <h2 className="text-base font-semibold text-white">New Card</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {/* Template selector */}
          <div>
            <label className={labelClass}>Template</label>
            <select
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className={inputClass}
            >
              <option value="">Select a template…</option>
              {TEMPLATE_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Inventory Picker */}
          <div className="border border-gray-700 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setShowInventoryPicker((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-750 hover:bg-gray-700 transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span className="text-sm font-medium text-gray-200">
                  {selectedUnit
                    ? `Linked: ${[selectedUnit.year, selectedUnit.make, selectedUnit.model].filter(Boolean).join(' ')}`
                    : 'Browse Inventory'}
                </span>
                {selectedUnit && (
                  <span className="text-[10px] bg-blue-900/60 text-blue-300 px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide">
                    Linked
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selectedUnit && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); handleUnitSelect(null) }}
                    onKeyDown={(e) => e.key === 'Enter' && handleUnitSelect(null)}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-0.5 rounded hover:bg-red-900/30 transition-colors cursor-pointer"
                  >
                    Unlink
                  </span>
                )}
                <svg
                  className={`w-4 h-4 text-gray-400 transition-transform ${showInventoryPicker ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>

            {showInventoryPicker && (
              <div className="p-4 border-t border-gray-700 bg-gray-900/40">
                <InventoryPicker
                  onSelect={handleUnitSelect}
                  selectedUnitId={selectedUnit?.id}
                />
              </div>
            )}
          </div>

          {/* Title */}
          <div>
            <label className={labelClass}>
              Title <span className="text-red-400">*</span>
            </label>
            <input
              ref={titleRef}
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Client Name: Description Ad Type"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-500">Format: Client Name: Description Ad Type</p>
          </div>

          {/* Client + Column (side by side) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Client</label>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className={inputClass}
              >
                <option value="">No client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={labelClass}>Column</label>
              <select
                value={columnId}
                onChange={(e) => setColumnId(e.target.value)}
                className={inputClass}
              >
                {columns.map((col) => (
                  <option key={col.id} value={col.id}>{col.title}</option>
                ))}
              </select>
            </div>
          </div>

          {/* TODO: assignee lookup — Phase 2 */}

          {/* Description */}
          <div>
            <label className={labelClass}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Add details, specs, or context…"
              className={`${inputClass} resize-none`}
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm bg-red-950/40 border border-red-800/50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 bg-gray-700 hover:bg-gray-600 text-gray-200 font-medium rounded-lg transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title.trim()}
              className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors text-sm"
            >
              {loading ? 'Creating…' : 'Create Card'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
