'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { PsDealer, PsInventoryUnit, PsCategory, PsCondition } from '@/types'

interface Props {
  onSelect: (unit: PsInventoryUnit | null) => void
  selectedUnitId?: string | null
}

const CATEGORY_LABELS: Record<PsCategory, string> = {
  motorcycle: 'Motorcycle',
  atv: 'ATV',
  utv: 'UTV',
  watercraft: 'Watercraft',
  snowmobile: 'Snowmobile',
  other: 'Other',
}

const CATEGORY_COLORS: Record<PsCategory, string> = {
  motorcycle: 'bg-blue-900/60 text-blue-300',
  atv: 'bg-green-900/60 text-green-300',
  utv: 'bg-teal-900/60 text-teal-300',
  watercraft: 'bg-cyan-900/60 text-cyan-300',
  snowmobile: 'bg-indigo-900/60 text-indigo-300',
  other: 'bg-gray-700 text-gray-300',
}

function formatPrice(price: number | null): string {
  if (price == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(price)
}

function CategoryBadge({ category }: { category: PsCategory | null }) {
  if (!category) return null
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${CATEGORY_COLORS[category]}`}>
      {CATEGORY_LABELS[category]}
    </span>
  )
}

export default function InventoryPicker({ onSelect, selectedUnitId }: Props) {
  const supabase = createClient()

  const [dealers, setDealers] = useState<PsDealer[]>([])
  const [dealerId, setDealerId] = useState<string>('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<PsCategory | ''>('')
  const [condition, setCondition] = useState<PsCondition | ''>('')
  const [units, setUnits] = useState<PsInventoryUnit[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingDealers, setLoadingDealers] = useState(true)

  // Fetch active dealers on mount
  useEffect(() => {
    async function loadDealers() {
      const { data } = await supabase
        .from('ps_dealers')
        .select('*')
        .eq('active', true)
        .order('name')
      setDealers((data as PsDealer[]) ?? [])
      if (data && data.length === 1) setDealerId(data[0].id)
      setLoadingDealers(false)
    }
    loadDealers()
  }, [])

  const search = useCallback(async () => {
    if (!dealerId) { setUnits([]); return }
    setLoading(true)

    let q = supabase
      .from('ps_inventory_units')
      .select('*, ps_dealers(id, name)')
      .eq('dealer_id', dealerId)
      .eq('status', 'active')
      .order('year', { ascending: false })
      .order('make')
      .order('model')
      .limit(80)

    if (category) q = q.eq('category', category)
    if (condition) q = q.eq('condition', condition)

    // Text search: filter by make or model containing the query string
    if (query.trim()) {
      // Use ilike on make+model — Supabase doesn't support OR ilike on separate cols
      // in a single .ilike(), so we do a .or() filter
      const term = `%${query.trim()}%`
      q = q.or(`make.ilike.${term},model.ilike.${term},trim.ilike.${term}`)
    }

    const { data } = await q
    setUnits((data as PsInventoryUnit[]) ?? [])
    setLoading(false)
  }, [dealerId, query, category, condition])

  // Auto-search when filters change
  useEffect(() => {
    const timeout = setTimeout(search, 300)
    return () => clearTimeout(timeout)
  }, [search])

  if (loadingDealers) {
    return (
      <div className="text-xs text-gray-500 py-4 text-center">Loading dealers…</div>
    )
  }

  if (dealers.length === 0) {
    return (
      <div className="text-xs text-gray-500 py-4 text-center">
        No active dealers found. Add dealers to the <code className="bg-gray-800 px-1 rounded">ps_dealers</code> table first.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Dealer selector */}
      {dealers.length > 1 && (
        <div>
          <label className="block text-[11px] text-gray-400 mb-1">Dealer</label>
          <select
            value={dealerId}
            onChange={(e) => setDealerId(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Select a dealer…</option>
            {dealers.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Search + filters */}
      {dealerId && (
        <>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search make, model, or trim…"
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          <div className="flex flex-wrap gap-2">
            {/* Category pills */}
            <button
              onClick={() => setCategory('')}
              className={`text-[11px] px-2 py-1 rounded-full font-medium transition-colors ${
                category === '' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >All</button>
            {(Object.keys(CATEGORY_LABELS) as PsCategory[]).map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat === category ? '' : cat)}
                className={`text-[11px] px-2 py-1 rounded-full font-medium transition-colors ${
                  category === cat ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}

            {/* Divider */}
            <span className="text-gray-600 self-center">|</span>

            {/* Condition pills */}
            {(['new', 'used'] as PsCondition[]).map((cond) => (
              <button
                key={cond}
                onClick={() => setCondition(cond === condition ? '' : cond)}
                className={`text-[11px] px-2 py-1 rounded-full font-medium capitalize transition-colors ${
                  condition === cond ? 'bg-orange-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {cond}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Results */}
      {dealerId && (
        <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-700 divide-y divide-gray-700/60">
          {loading && (
            <div className="text-xs text-gray-500 py-4 text-center">Searching…</div>
          )}
          {!loading && units.length === 0 && (
            <div className="text-xs text-gray-500 py-4 text-center">No units match your filters.</div>
          )}
          {!loading && units.map((unit) => {
            const isSelected = unit.id === selectedUnitId
            return (
              <button
                key={unit.id}
                type="button"
                onClick={() => onSelect(isSelected ? null : unit)}
                className={`w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors ${
                  isSelected
                    ? 'bg-blue-900/40 hover:bg-blue-900/50'
                    : 'bg-gray-900 hover:bg-gray-800'
                }`}
              >
                {/* Selection indicator */}
                <div className={`mt-0.5 shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                  isSelected ? 'border-blue-500 bg-blue-500' : 'border-gray-600'
                }`}>
                  {isSelected && (
                    <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12">
                      <path d="M10 3L5 8.5 2 5.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium text-white">
                      {[unit.year, unit.make, unit.model, unit.trim].filter(Boolean).join(' ')}
                    </span>
                    <CategoryBadge category={unit.category} />
                    {unit.condition && (
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                        unit.condition === 'new' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-amber-900/60 text-amber-300'
                      }`}>
                        {unit.condition}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-3 mt-0.5 text-xs text-gray-400">
                    <span>{formatPrice(unit.price)}</span>
                    {unit.stock_number && <span>#{unit.stock_number}</span>}
                    {unit.days_on_lot > 0 && <span>{unit.days_on_lot}d on lot</span>}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
