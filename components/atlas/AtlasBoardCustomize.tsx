'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ATLAS_CARD_FIELD_KEYS, type AtlasBoardColumn, type AtlasCardFieldKey, type AtlasCardFields } from '@/types'
import { ATLAS_CARD_FIELD_LABELS, moveColumn, nextColumnPosition, safeColor, sortColumns } from '@/lib/atlasStages'

interface Props {
  columns: AtlasBoardColumn[]
  /** Cards currently showing in each stage (unfiltered), so delete can say how many move. */
  countsByColumn: Map<string, number>
  fields: AtlasCardFields
  /**
   * Takes an updater, not an array: a write resolving late (or a rollback) has
   * to apply to the latest columns, not the ones it was started from.
   */
  onColumnsChange: (update: (prev: AtlasBoardColumn[]) => AtlasBoardColumn[]) => void
  onFieldsChange: (fields: AtlasCardFields) => void
  autoMove: AutoMove
  onAutoMoveChange: (next: AutoMove) => void
  /** Moves the stage's cards to `targetId`, then deletes the stage. Resolves to an error message or null. */
  onDeleteColumn: (columnId: string, targetId: string) => Promise<string | null>
  onOpenBackground: () => void
  onClose: () => void
}

/** Stage ids the DB trigger moves cards to; null = don't move. See add_atlas_board_automove.sql. */
export interface AutoMove {
  review: string | null
  changes: string | null
}

const SWATCHES = ['#0075a9', '#38b6ff', '#73308a', '#f59e0b', '#ef4444', '#22c55e', '#14b8a6', '#94a3b8']

// The Atlas board's own settings panel. Everything here writes to Atlas-only tables
// (atlas_board_columns, atlas_board_settings), so nothing changed here can move or
// restyle the main FTE board.
export default function AtlasBoardCustomize({
  columns, countsByColumn, fields, onColumnsChange, onFieldsChange, autoMove, onAutoMoveChange, onDeleteColumn, onOpenBackground, onClose,
}: Props) {
  const supabase = useMemo(() => createClient(), [])
  const sorted = useMemo(() => sortColumns(columns), [columns])
  const [error, setError] = useState<string | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newColor, setNewColor] = useState(SWATCHES[0])
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<{ id: string; target: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // A native colour picker fires change on every pixel of a drag; saving each one
  // would be dozens of writes. Local state updates live, the write waits.
  const colorTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; color: string }>())

  // Closing the panel (or jumping to the background picker) unmounts it. A colour
  // still waiting on its timer is written now rather than dropped — cancelling it
  // left the new colour on screen and the old one in the database.
  useEffect(() => {
    const pending = colorTimers.current
    return () => {
      for (const [id, p] of pending) {
        clearTimeout(p.timer)
        void supabase.from('atlas_board_columns').update({ color: p.color }).eq('id', id)
      }
      pending.clear()
    }
  }, [supabase])

  async function saveColumn(id: string, patch: Partial<Pick<AtlasBoardColumn, 'title' | 'color'>>): Promise<boolean> {
    const { error: e } = await supabase.from('atlas_board_columns').update(patch).eq('id', id)
    if (e) setError(`Could not save column: ${e.message}`)
    return !e
  }

  async function rename(id: string, title: string) {
    const t = title.trim()
    const col = columns.find((c) => c.id === id)
    if (!col || !t || t === col.title) return
    const oldTitle = col.title
    onColumnsChange((cs) => cs.map((c) => (c.id === id ? { ...c, title: t } : c)))
    if (!(await saveColumn(id, { title: t }))) {
      onColumnsChange((cs) => cs.map((c) => (c.id === id ? { ...c, title: oldTitle } : c)))
    }
  }

  function recolor(id: string, color: string) {
    const safe = safeColor(color)
    onColumnsChange((cs) => cs.map((c) => (c.id === id ? { ...c, color: safe } : c)))
    const timers = colorTimers.current
    const prev = timers.get(id)
    if (prev) clearTimeout(prev.timer)
    timers.set(id, {
      color: safe,
      timer: setTimeout(() => { timers.delete(id); void saveColumn(id, { color: safe }) }, 400),
    })
  }

  async function reorder(id: string, delta: -1 | 1) {
    const next = moveColumn(columns, id, delta)
    const oldPositions = new Map(columns.map((c) => [c.id, c.position]))
    const changed = next.filter((c) => oldPositions.get(c.id) !== c.position)
    if (changed.length === 0) return
    const newPositions = new Map(next.map((c) => [c.id, c.position]))
    onColumnsChange((cs) => cs.map((c) => ({ ...c, position: newPositions.get(c.id) ?? c.position })))
    const results = await Promise.all(
      changed.map((c) => supabase.from('atlas_board_columns').update({ position: c.position }).eq('id', c.id)),
    )
    const failed = results.find((r) => r.error)
    if (failed?.error) {
      // Put the rows that did save back too, so the screen and the table agree.
      await Promise.all(
        changed.map((c) => supabase.from('atlas_board_columns').update({ position: oldPositions.get(c.id) }).eq('id', c.id)),
      )
      onColumnsChange((cs) => cs.map((c) => ({ ...c, position: oldPositions.get(c.id) ?? c.position })))
      setError(`Could not save the new order: ${failed.error.message}`)
    }
  }

  async function add() {
    const title = newTitle.trim()
    if (!title) return
    setAdding(true)
    setError(null)
    const { data, error: e } = await supabase
      .from('atlas_board_columns')
      .insert({ title, color: safeColor(newColor), position: nextColumnPosition(columns) })
      .select('id, title, position, color, created_at')
      .single()
    setAdding(false)
    if (e || !data) {
      setError(`Could not add column: ${e?.message ?? 'no row returned'}`)
      return
    }
    onColumnsChange((cs) => [...cs, data as AtlasBoardColumn])
    setNewTitle('')
  }

  async function confirmDelete() {
    if (!deleting) return
    setBusy(true)
    setError(null)
    const err = await onDeleteColumn(deleting.id, deleting.target)
    setBusy(false)
    if (err) setError(err)
    else setDeleting(null)
  }

  function toggleField(key: AtlasCardFieldKey) {
    onFieldsChange({ ...fields, [key]: !fields[key] })
  }

  return (
    <div className="fixed inset-y-0 right-0 w-[340px] bg-[#1a1d23] border-l border-gray-700/60 z-50 flex flex-col shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700/60">
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Customize Atlas board</h2>
          <p className="text-[11px] text-gray-500">Changes here never touch the FTE Board.</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-200 transition-colors text-lg leading-none" aria-label="Close">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {error && <p className="text-[11px] text-red-300 rounded border border-red-400/30 bg-red-400/10 px-2 py-1.5">{error}</p>}

        {/* ── Columns ── */}
        <section>
          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Stage columns</p>
          <ul className="space-y-1.5">
            {sorted.map((col, i) => {
              const count = countsByColumn.get(col.id) ?? 0
              const isDeleting = deleting?.id === col.id
              return (
                <li key={col.id} className="rounded-lg border border-gray-700/60 bg-black/20 p-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={safeColor(col.color)}
                      onChange={(e) => recolor(col.id, e.target.value)}
                      className="w-6 h-6 flex-none rounded cursor-pointer bg-transparent border-0 p-0"
                      title="Column colour"
                    />
                    <input
                      // Keyed on the title so a rename that failed and was rolled
                      // back re-shows the saved name instead of the typed one.
                      key={`${col.id}:${col.title}`}
                      defaultValue={col.title}
                      onBlur={(e) => rename(col.id, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                      className="flex-1 min-w-0 text-xs px-2 py-1 rounded bg-black/30 border border-gray-700 text-gray-100 focus:outline-none focus:border-[#38b6ff]/60"
                    />
                    <span className="text-[10px] text-gray-500 w-6 text-right" title="Cards in this column">{count}</span>
                    <button onClick={() => reorder(col.id, -1)} disabled={i === 0} className="text-gray-400 hover:text-white disabled:opacity-25 px-1 text-xs" aria-label="Move left" title="Move left">◀</button>
                    <button onClick={() => reorder(col.id, 1)} disabled={i === sorted.length - 1} className="text-gray-400 hover:text-white disabled:opacity-25 px-1 text-xs" aria-label="Move right" title="Move right">▶</button>
                    <button
                      onClick={() => {
                        const target = sorted.find((c) => c.id !== col.id)
                        if (target) setDeleting({ id: col.id, target: target.id })
                      }}
                      disabled={sorted.length <= 1}
                      className="text-gray-500 hover:text-red-300 disabled:opacity-25 px-1 text-xs"
                      title={sorted.length <= 1 ? 'The board needs at least one column' : 'Delete column'}
                      aria-label="Delete column"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Cards are never deleted (house rule), so deleting a stage
                      always says where its cards go and moves them first. */}
                  {isDeleting && deleting && (
                    <div className="mt-2 space-y-1.5">
                      <p className="text-[11px] text-amber-200">
                        Delete “{col.title}”? {count > 0 ? `Its ${count} card${count === 1 ? '' : 's'} move to:` : 'It has no cards.'}
                      </p>
                      {count > 0 && (
                        <select
                          value={deleting.target}
                          onChange={(e) => setDeleting({ id: col.id, target: e.target.value })}
                          className="w-full text-xs px-2 py-1 rounded bg-black/30 border border-gray-700 text-gray-100"
                        >
                          {sorted.filter((c) => c.id !== col.id).map((c) => (
                            <option key={c.id} value={c.id}>{c.title}</option>
                          ))}
                        </select>
                      )}
                      <div className="flex gap-2">
                        <button onClick={confirmDelete} disabled={busy} className="px-2.5 py-1 rounded text-[11px] font-semibold bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-50">
                          {busy ? 'Deleting…' : 'Delete column'}
                        </button>
                        <button onClick={() => setDeleting(null)} className="px-2.5 py-1 rounded text-[11px] text-gray-300 hover:text-white">Cancel</button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="mt-3 rounded-lg border border-dashed border-gray-700 p-2 space-y-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
              placeholder="New column name…"
              className="w-full text-xs px-2 py-1.5 rounded bg-black/30 border border-gray-700 text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-[#38b6ff]/60"
            />
            <div className="flex items-center gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  onClick={() => setNewColor(c)}
                  className={`w-5 h-5 rounded-full border-2 ${newColor === c ? 'border-white' : 'border-transparent'}`}
                  style={{ background: c }}
                  aria-label={`Colour ${c}`}
                />
              ))}
              <button
                onClick={() => void add()}
                disabled={adding || !newTitle.trim()}
                className="ml-auto whitespace-nowrap px-2.5 py-1 rounded text-[11px] font-semibold bg-[#0075a9] text-white hover:bg-[#0088c4] disabled:opacity-40"
              >
                {adding ? 'Adding…' : 'Add column'}
              </button>
            </div>
          </div>
        </section>

        {/* ── Automatic moves ── */}
        {/* Done by a database trigger (cards_atlas_auto_stage), so every Adviewer
            path counts — corporate link, location links, drawer and bulk send.
            Client APPROVAL deliberately has no picker: approved cards are moved
            by hand (team decision, 2026-11-02). */}
        <section>
          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Automatic moves</p>
          <div className="space-y-2">
            {([
              ['review', 'Sent to Adviewer, or revision uploaded'],
              ['changes', 'Client asks for changes'],
            ] as const).map(([key, label]) => (
              <label key={key} className="block">
                <span className="text-[11px] text-gray-300">{label} →</span>
                <select
                  value={autoMove[key] ?? ''}
                  onChange={(e) => onAutoMoveChange({ ...autoMove, [key]: e.target.value || null })}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded bg-black/30 border border-gray-700 text-gray-100"
                >
                  <option value="">Don&apos;t move</option>
                  {sorted.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
              </label>
            ))}
          </div>
          <p className="text-[10px] text-gray-500 mt-1.5">
            A move applies wherever the card is, even if you placed it by hand. Approved cards are never moved automatically.
          </p>
        </section>

        {/* ── Card fields ── */}
        <section>
          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Show on cards</p>
          <div className="space-y-1">
            {ATLAS_CARD_FIELD_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2 text-xs text-gray-200 cursor-pointer py-0.5">
                <input type="checkbox" checked={fields[key]} onChange={() => toggleField(key)} className="accent-[#0075a9]" />
                {ATLAS_CARD_FIELD_LABELS[key]}
              </label>
            ))}
          </div>
          <p className="text-[10px] text-gray-500 mt-1.5">Location name only shows in the Stages view — in By location the column already says it.</p>
        </section>

        {/* ── Background ── */}
        <section>
          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Background</p>
          <button
            onClick={onOpenBackground}
            className="w-full px-3 py-2 rounded-lg text-xs font-semibold border border-gray-700 text-gray-200 hover:border-gray-500"
          >
            Change Atlas board background…
          </button>
        </section>
      </div>
    </div>
  )
}
