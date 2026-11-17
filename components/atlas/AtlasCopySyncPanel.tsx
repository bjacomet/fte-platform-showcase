'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { buildPullRows, findHeaderRowIndex, type CopyBlock } from '@/lib/atlasSheet'
import {
  buildAtlasCopyDiff, ATLAS_COPY_FIELDS, ATLAS_LINK_FIELDS,
  type AtlasCopyCard, type AtlasCopyArchivedCard, type AtlasCopyDiffRow, type AtlasCopyDiffResult, type AtlasLinkCardField,
} from '@/lib/atlasCopySync'
import type { AtlasCreativeRefresh, AtlasLocation, AtlasQuarter } from '@/types'

/**
 * Copy sync confirm screen — push edited Copy Plan copy, and the two Box
 * build links, onto existing cards.
 *
 * Update-only: it never creates a card and never archives one. Nothing is
 * written until Apply, and rows where nothing differs are not shown at all, so a
 * re-run against an unedited export is an empty screen.
 */

const CARD_SELECT =
  'id, title, atlas_location_id, archived, adpiler_preview_url, fb_body_text, fb_headline, ' +
  'fb_subheadline, heading, subheading, landing_page_url, build_link, display_build_link'

type RowState = AtlasCopyDiffRow & {
  /** Copy fields — all or nothing, as before. */
  selected: boolean
  /**
   * Box links — ticked one by one, because a row can carry a plain fill on one
   * link and a hand-pasted conflict on the other.
   */
  linkPicked: Partial<Record<AtlasLinkCardField, boolean>>
  /** Which card to write to — preset for a single candidate, chosen for a pair. */
  chosenCardId: string | null
  result?: 'done' | { error: string }
}

interface Props {
  csvRows: string[][]
  block: CopyBlock
  locations: AtlasLocation[]
  refreshRows: AtlasCreativeRefresh[]
  quarter: AtlasQuarter
  year: number
  userEmail: string
  onApplied: () => void
}

export default function AtlasCopySyncPanel({
  csvRows, block, locations, refreshRows, quarter, year, userEmail, onApplied,
}: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [diff, setDiff] = useState<AtlasCopyDiffResult | null>(null)
  const [rows, setRows] = useState<RowState[]>([])
  const [summary, setSummary] = useState<string | null>(null)

  const scopedRefresh = useMemo(
    () => refreshRows.filter((r) => r.quarter === quarter && r.year === year),
    [refreshRows, quarter, year],
  )

  const compute = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSummary(null)
    // Archived cards are fetched too — not to write to, but to tell a location+
    // focus that was deliberately retired apart from one that never had a card.
    const { data, error: cardErr } = await supabase
      .from('cards')
      .select(CARD_SELECT)
      .not('atlas_location_id', 'is', null)
      .eq('media_type', 'Social Ad Request')

    if (cardErr) {
      setError(`Could not read the Atlas cards: ${cardErr.message}`)
      setLoading(false)
      return
    }

    const all = (data ?? []) as unknown as (AtlasCopyCard & { archived: boolean })[]
    const cards: AtlasCopyCard[] = all.filter((c) => !c.archived)
    const archivedCards: AtlasCopyArchivedCard[] = all
      .filter((c) => c.archived)
      .map((c) => ({ id: c.id, title: c.title, atlas_location_id: c.atlas_location_id }))
    const importedKeys = new Set(
      scopedRefresh.map((r) => `${r.location_id}::${r.focus_type.trim().toLowerCase()}`),
    )
    const headerIdx = findHeaderRowIndex(csvRows)
    const { rows: pull } = buildPullRows(csvRows, {
      block,
      locations: locations.map((l) => ({ id: l.id, name: l.name })),
      importedKeys,
      dataStartIndex: headerIdx >= 0 ? headerIdx + 1 : 2,
    })

    const result = buildAtlasCopyDiff(
      pull, cards, scopedRefresh, locations.map((l) => ({ id: l.id, name: l.name })), archivedCards,
    )
    setDiff(result)
    setRows(result.rows.map((r) => ({
      ...r,
      // A plain change is pre-selected. A conflict is not — it overwrites a
      // hand-edit, so it has to be ticked deliberately. Copy and links are
      // judged separately: a hand-pasted link must not untick a clean copy
      // edit, and a copy conflict must not untick a link fill.
      selected: !r.candidates[0].fields.some((f) => f.kind === 'copy' && f.conflict),
      linkPicked: Object.fromEntries(
        r.candidates[0].fields
          .filter((f) => f.kind === 'link')
          .map((f) => [f.field, !f.conflict]),
      ) as Partial<Record<AtlasLinkCardField, boolean>>,
      chosenCardId: r.candidates.length === 1 ? r.candidates[0].cardId : null,
    })))
    setLoading(false)
  }, [supabase, csvRows, block, locations, scopedRefresh])

  // Deferred with queueMicrotask so the first setState doesn't run synchronously
  // inside the effect (same reason Board.tsx defers its card open).
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) void compute() })
    return () => { cancelled = true }
  }, [compute])

  /** The fields this row would actually write on Apply, given what is ticked. */
  function pickedFields(row: RowState) {
    const fields = row.candidates.find((c) => c.cardId === row.chosenCardId)?.fields ?? []
    return {
      copy: row.selected ? fields.filter((f) => f.kind === 'copy') : [],
      links: fields.filter((f) => f.kind === 'link' && row.linkPicked[f.field as AtlasLinkCardField]),
    }
  }

  const applicable = rows.filter((r) => {
    if (!r.chosenCardId || r.result === 'done') return false
    const { copy, links } = pickedFields(r)
    return copy.length > 0 || links.length > 0
  })

  function patchRow(key: string, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  async function apply() {
    if (applicable.length === 0) return
    setApplying(true)
    setError(null)
    let ok = 0
    let failed = 0
    let filled = 0
    let replaced = 0

    for (const row of applicable) {
      const candidate = row.candidates.find((c) => c.cardId === row.chosenCardId)
      if (!candidate) continue
      const { copy, links } = pickedFields(row)
      const written = [...copy, ...links]
      if (written.length === 0) continue

      // Only the ticked fields that actually differ, and only for the chosen card.
      const updates: Record<string, string | null> = {}
      for (const f of written) updates[f.field] = f.sheet
      // Copy changed under a client mid-review — send it back to pending, the
      // same as replacing the creative file does. A Box link is not something
      // the client sees, so a link-only write leaves the review where it is.
      const resets = candidate.resetsApproval && copy.length > 0
      if (resets) updates.approval_status = 'pending'

      const { error: cardErr } = await supabase
        .from('cards')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', candidate.cardId)

      if (cardErr) {
        patchRow(row.key, { result: { error: cardErr.message } })
        failed += 1
        continue
      }

      await supabase.from('card_activity').insert({
        card_id: candidate.cardId,
        actor: userEmail,
        actor_email: userEmail,
        action: 'updated',
        detail:
          `synced ${copy.length > 0 ? (links.length > 0 ? 'copy and Box links' : 'copy') : 'Box links'} ` +
          `from the Copy Plan sheet — ${written.map((f) => f.label).join(', ')}` +
          (resets ? ' (reset to pending review)' : ''),
      })

      // Move the baseline forward so the NEXT sheet edit is attributed correctly:
      // leaving it stale would make this card read as hand-edited next time.
      if (row.refreshRowId) {
        const refreshPatch: Record<string, string | null> = {}
        for (const spec of [...ATLAS_COPY_FIELDS, ...ATLAS_LINK_FIELDS]) {
          const changed = written.find((f) => f.field === spec.card)
          if (changed) refreshPatch[spec.sheet] = changed.sheet
        }
        if (Object.keys(refreshPatch).length > 0) {
          await supabase
            .from('atlas_creative_refresh')
            .update({ ...refreshPatch, updated_at: new Date().toISOString() })
            .eq('id', row.refreshRowId)
        }
      }

      for (const f of links) {
        if (f.card && f.card.trim()) replaced += 1
        else filled += 1
      }
      patchRow(row.key, { result: 'done', selected: false, linkPicked: {} })
      ok += 1
    }

    const linkNote = filled + replaced > 0
      ? ` — ${filled} link${filled === 1 ? '' : 's'} filled${replaced ? `, ${replaced} replaced` : ''}`
      : ''
    setSummary(`Updated ${ok} card${ok === 1 ? '' : 's'}${linkNote}${failed ? `, ${failed} failed` : ''}.`)
    setApplying(false)
    if (ok > 0) onApplied()
  }

  const changeRows = rows.filter((r) => r.status === 'change')
  const conflictRows = rows.filter((r) => r.status === 'conflict')

  return (
    <div className="rounded-xl border border-white/15 bg-black/30 p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-white">Update copy and build links on existing cards</h3>
        <p className="text-[11px] text-gray-400 mt-0.5">
          The sheet is the source of truth for copy and Box build links. Only rows where the sheet differs from the card
          appear here — this never creates or archives a card, and nothing is written until you press Apply.
          A link is never blanked: if the sheet has none, the card keeps its own.
        </p>
      </div>

      {loading && <p className="text-xs text-gray-400">Comparing the sheet against the cards…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {summary && <p className="text-xs text-teal-300">{summary}</p>}

      {diff && !loading && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-300 border-t border-white/10 pt-3">
            <span>{diff.totals.examined} imported rows checked</span>
            <span className="text-white/20">|</span>
            <span className="text-teal-300">{diff.totals.changed} changed</span>
            <span className="text-amber-300">{diff.totals.conflicts} conflict</span>
            <span className="text-gray-500">{diff.totals.unchanged} unchanged</span>
            {diff.totals.noCard > 0 && (
              <span className="text-amber-300" title="No card has ever existed for this location and focus — something may be missing">
                {diff.totals.noCard} no card
              </span>
            )}
            {diff.totals.archivedCard > 0 && (
              <span className="text-gray-500" title="A card exists but was deliberately archived">
                {diff.totals.archivedCard} archived
              </span>
            )}
            {diff.totals.stillGood > 0 && <span className="text-gray-600">{diff.totals.stillGood} “Still Good” skipped</span>}
            {diff.totals.ambiguous > 0 && (
              <span className="text-amber-300">{diff.totals.ambiguous} skipped — several cards share a location and focus</span>
            )}
            <span className="text-white/20">|</span>
            <span className="text-teal-300" title="Card has no link and the sheet has one">
              {diff.totals.linksToFill} link{diff.totals.linksToFill === 1 ? '' : 's'} to fill
            </span>
            {diff.totals.linksToReplace > 0 && (
              <span className="text-gray-300" title="Card has a different link than the sheet">
                {diff.totals.linksToReplace} to replace
              </span>
            )}
            <span
              className={diff.totals.missingSocial + diff.totals.missingDisplay > 0 ? 'text-amber-300' : 'text-gray-500'}
              title="Cards with no link that the sheet cannot fill either — the selected period has none for that row. Applying everything above will not change these."
            >
              still missing: {diff.totals.missingSocial} social · {diff.totals.missingDisplay} display
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="text-xs text-gray-400">
              Nothing to update — every imported row already matches its card.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-gray-400">
                  {applicable.length} card{applicable.length === 1 ? '' : 's'} will be updated.
                  {' '}Link-only changes do not reset client review.
                </p>
                <button
                  onClick={() => void apply()}
                  disabled={applying || applicable.length === 0}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-teal-600 hover:bg-teal-500 disabled:opacity-50 transition-colors"
                >
                  {applying ? 'Updating…' : `Apply to ${applicable.length} card${applicable.length === 1 ? '' : 's'}`}
                </button>
              </div>

              <CopyGroup
                title="Changed in the sheet"
                tone="teal"
                rows={changeRows}
                onPatch={patchRow}
              />
              <CopyGroup
                title="Conflict — the card was edited by hand since the last sync"
                tone="amber"
                note="The sheet wins, but these overwrite someone's edit — copy edited in the drawer, or a Box link pasted by hand. Tick each one you mean to replace."
                rows={conflictRows}
                onPatch={patchRow}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

function CopyGroup({
  title, tone, note, rows, onPatch,
}: {
  title: string
  tone: 'teal' | 'amber'
  note?: string
  rows: RowState[]
  onPatch: (key: string, patch: Partial<RowState>) => void
}) {
  if (rows.length === 0) return null
  const head = tone === 'teal' ? 'text-teal-300' : 'text-amber-300'

  return (
    <div className="space-y-2">
      <h4 className={`text-xs font-semibold ${head}`}>{title} — {rows.length}</h4>
      {note && <p className="text-[11px] text-gray-500">{note}</p>}
      {rows.map((row) => {
        const fields = row.candidates[0].fields
        const copyFields = fields.filter((f) => f.kind === 'copy')
        const linkFields = fields.filter((f) => f.kind === 'link')
        const done = row.result === 'done'
        return (
          <div key={row.key} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
            <div className="flex items-start gap-2.5">
              {/* Row checkbox = the copy changes. Link-only rows have none; each link has its own. */}
              {copyFields.length > 0 ? (
                <input
                  type="checkbox"
                  checked={row.selected}
                  disabled={done}
                  onChange={(e) => onPatch(row.key, { selected: e.target.checked })}
                  className="mt-1 flex-none"
                  title="Apply the copy changes on this row"
                />
              ) : (
                <span className="w-[13px] flex-none" />
              )}
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-white font-medium">{row.locationName}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-300">{row.focusType}</span>
                  <span className="text-[10px] text-gray-600">sheet row {row.sheetRow}</span>
                  {row.candidates.some((c) => c.resetsApproval) && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30">
                      resets client review to pending
                    </span>
                  )}
                  {row.result === 'done' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">✓ updated</span>
                  )}
                  {row.result && row.result !== 'done' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">{row.result.error}</span>
                  )}
                </div>

                {/* Before / after for the card that would actually be written. */}
                {copyFields.map((f) => (
                  <div key={f.field} className="rounded border border-white/[0.06] bg-black/20 p-2 space-y-1">
                    <p className="text-[10px] font-semibold text-gray-400">
                      {f.label}
                      {f.conflict && <span className="ml-1.5 text-amber-300">· card hand-edited since last sync</span>}
                    </p>
                    <p className="text-[11px] text-red-300/80 whitespace-pre-wrap break-words">− {f.card ?? '(empty)'}</p>
                    <p className="text-[11px] text-emerald-300/90 whitespace-pre-wrap break-words">+ {f.sheet ?? '(empty)'}</p>
                    {f.conflict && (
                      <p className="text-[10px] text-gray-500 whitespace-pre-wrap break-words">
                        at last sync: {f.lastSync ?? '(empty)'}
                      </p>
                    )}
                  </div>
                ))}

                {/* Box links: same before/after, but ticked one by one. */}
                {linkFields.map((f) => {
                  const field = f.field as AtlasLinkCardField
                  return (
                    <label key={f.field} className="flex items-start gap-2 rounded border border-sky-400/15 bg-sky-500/[0.04] p-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!row.linkPicked[field]}
                        disabled={done}
                        onChange={(e) => onPatch(row.key, { linkPicked: { ...row.linkPicked, [field]: e.target.checked } })}
                        className="mt-0.5 flex-none"
                      />
                      <span className="flex-1 min-w-0 space-y-1">
                        <span className="block text-[10px] font-semibold text-gray-400">
                          {f.label}
                          <span className="ml-1.5 font-normal text-gray-500">
                            · {f.card ? 'replace' : 'fill'} · no review reset
                          </span>
                          {f.conflict && <span className="ml-1.5 text-amber-300">· card link pasted by hand since last sync</span>}
                        </span>
                        <span className="block text-[11px] text-red-300/80 break-all">− {f.card ?? '(empty)'}</span>
                        <span className="block text-[11px] text-emerald-300/90 break-all">+ {f.sheet}</span>
                        {f.conflict && (
                          <span className="block text-[10px] text-gray-500 break-all">at last sync: {f.lastSync ?? '(empty)'}</span>
                        )}
                      </span>
                    </label>
                  )
                })}

              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
