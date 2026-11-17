'use client'

import { useMemo, useState } from 'react'
import type { AtlasBoxScanRow } from '@/lib/atlasBoxSync'
import { ATLAS_BOX_QUARTERS, currentAtlasBoxPeriod, type AtlasBoxQuarter } from '@/lib/atlasBoxRoots'

/**
 * Confirm screen for the Atlas ↔ Box creative sync.
 *
 * Scanning is a dry run — it walks Box and matches Build folders to cards but
 * writes nothing. Nothing reaches a card until Apply is pressed, because a
 * silent mis-attach files a client's video under the wrong centre. Every row
 * carries an editable card picker so a wrong or missing match can be corrected
 * here rather than in the database.
 */

interface RosterCard {
  id: string
  title: string
  locationName: string
  alreadyLinked: boolean
  buildLink: string | null
  displayBuildLink: string | null
}

interface ScanResponse {
  year: number
  quarter: AtlasBoxQuarter
  displayPeriodFound: boolean
  displayTreeNote: string | null
  matched: AtlasBoxScanRow[]
  needsAttention: AtlasBoxScanRow[]
  cardsWithoutBuild: { id: string; title: string }[]
  displayMissing: { rowKey: string; boxPath: string; reason: string }[]
  totals: { displayBuilds: number; buildFolders: number; cardsCovered: number; cards: number }
  roster: RosterCard[]
}

type RowState = AtlasBoxScanRow & {
  selected: boolean
  chosenCardIds: string[]
  /** Overwrite a card's existing, different Box link. Off by default. */
  replaceLinks: boolean
  result?: { ok: number; failed: number; error?: string }
}

type LinkOutcome = 'filled' | 'replaced' | 'unchanged' | 'kept'

interface ApplyResult {
  rowKey: string
  cardId: string
  ok: boolean
  error?: string
  social?: LinkOutcome
  display?: LinkOutcome
}

function toRowState(row: AtlasBoxScanRow, selected: boolean): RowState {
  return { ...row, selected, chosenCardIds: [...row.cardIds], replaceLinks: false }
}

export default function AtlasBoxSyncPanel({ onApplied }: { onApplied: () => void }) {
  const [period, setPeriod] = useState(() => currentAtlasBoxPeriod(new Date()))
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanResponse | null>(null)
  const [rows, setRows] = useState<RowState[]>([])
  const [applySummary, setApplySummary] = useState<string | null>(null)

  const roster = useMemo<RosterCard[]>(() => scan?.roster ?? [], [scan])
  const rosterById = useMemo(() => new Map(roster.map((c) => [c.id, c])), [roster])

  // Five Atlas titles are genuinely duplicated — two "Breast" cards at MetroCare High
  // Desert, plus four more pairs — and the location is already inside the title,
  // so it cannot tell them apart. Append a short id tail, but only where the
  // title is actually ambiguous, so the common case stays readable.
  const cardLabel = useMemo(() => {
    const countByTitle = new Map<string, number>()
    for (const c of roster) countByTitle.set(c.title, (countByTitle.get(c.title) ?? 0) + 1)
    return (id: string): string => {
      const c = rosterById.get(id)
      if (!c) return id
      return (countByTitle.get(c.title) ?? 0) > 1 ? `${c.title} · ${c.id.slice(0, 8)}` : c.title
    }
  }, [roster, rosterById])

  // A row is writable when it has a Social or Display Build folder and at least
  // one chosen card. Not every row has a file: a row may carry only links.
  const applicable = rows.filter((r) => r.selected && (r.buildFolderId || r.display) && r.chosenCardIds.length > 0)
  const cardWriteCount = applicable.reduce((n, r) => n + r.chosenCardIds.length, 0)

  async function runScan() {
    setScanning(true)
    setError(null)
    setApplySummary(null)
    try {
      const res = await fetch('/api/atlas/box-sync/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: period.year, quarter: period.quarter }),
      })
      const json = (await res.json()) as ScanResponse & { error?: string }
      if (!res.ok) {
        setError(json.error ?? `Scan failed (${res.status})`)
        setScan(null)
        setRows([])
        return
      }
      setScan(json)
      // Matched rows start selected; needs-attention rows start unselected so a
      // flagged build can never be applied without someone looking at it first.
      setRows([
        ...json.matched.map((r) => toRowState(r, true)),
        ...json.needsAttention.map((r) => toRowState(r, false)),
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scan failed')
    } finally {
      setScanning(false)
    }
  }

  function patchRow(rowKey: string, patch: Partial<RowState>) {
    setRows((prev) => prev.map((r) => (r.rowKey === rowKey ? { ...r, ...patch } : r)))
  }

  function addCard(row: RowState, cardId: string) {
    if (!cardId || row.chosenCardIds.includes(cardId)) return
    patchRow(row.rowKey, { chosenCardIds: [...row.chosenCardIds, cardId] })
  }

  function removeCard(row: RowState, cardId: string) {
    patchRow(row.rowKey, { chosenCardIds: row.chosenCardIds.filter((id) => id !== cardId) })
  }

  async function apply() {
    if (applicable.length === 0) return
    setApplying(true)
    setError(null)
    try {
      const res = await fetch('/api/atlas/box-sync/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignments: applicable.map((r) => ({
            rowKey: r.rowKey,
            buildFolderId: r.buildFolderId,
            boxFileId: r.file?.id ?? null,
            fileName: r.file?.name ?? null,
            displayFolderId: r.display?.buildFolderId ?? null,
            cardIds: r.chosenCardIds,
            replaceLinks: r.replaceLinks,
          })),
        }),
      })
      const json = (await res.json()) as {
        applied?: number; failed?: number; results?: ApplyResult[]; error?: string
        links?: { created: number; reused: number }
      }
      if (!res.ok) {
        setError(json.error ?? `Apply failed (${res.status})`)
        return
      }

      const byBuild = new Map<string, { ok: number; failed: number; error?: string }>()
      let kept = 0
      for (const r of json.results ?? []) {
        if (r.social === 'kept') kept += 1
        if (r.display === 'kept') kept += 1
        const entry = byBuild.get(r.rowKey) ?? { ok: 0, failed: 0 }
        if (r.ok) entry.ok += 1
        else {
          entry.failed += 1
          entry.error = r.error
        }
        byBuild.set(r.rowKey, entry)
      }
      setRows((prev) =>
        prev.map((r) => {
          const result = byBuild.get(r.rowKey)
          // Applied rows deselect so a second press can't double-write them.
          return result ? { ...r, result, selected: result.failed > 0 } : r
        }),
      )
      const l = json.links
      setApplySummary(
        `Updated ${json.applied ?? 0} card${json.applied === 1 ? '' : 's'}${json.failed ? `, ${json.failed} failed` : ''}.` +
        (l ? ` Box links: ${l.created} created, ${l.reused} already existed.` : '') +
        (kept > 0 ? ` ${kept} card link${kept === 1 ? '' : 's'} left as they were (differs from Box — tick "Replace" to overwrite).` : ''),
      )
      onApplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Apply failed')
    } finally {
      setApplying(false)
    }
  }

  const matchedRows = rows.filter((r) => r.status === 'matched')
  const attentionRows = rows.filter((r) => r.status === 'needs_attention')
  const offSpecCount = rows.filter((r) => r.offSpec && r.file).length

  return (
    <div className="rounded-xl border border-white/15 bg-black/50 p-4 space-y-4 text-left">
      <div>
        <h3 className="text-sm font-semibold text-white">Sync creatives from Box</h3>
        <p className="text-[11px] text-gray-400 mt-0.5">
          Walks the Social Media and Banner Ads folders for the chosen quarter, matches each Build folder to its
          card, attaches the square MP4, and stores both Box shared links (Social → Build link, Banner Ads → Display
          build link). Scanning changes nothing — nothing is written until you press Apply.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={period.year}
          onChange={(e) => setPeriod((p) => ({ ...p, year: Number(e.target.value) }))}
          className="bg-gray-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white"
          aria-label="Year"
        >
          {[0, 1, 2].map((back) => {
            const y = new Date().getFullYear() + 1 - back
            return <option key={y} value={y}>{y}</option>
          })}
        </select>
        <select
          value={period.quarter}
          onChange={(e) => setPeriod((p) => ({ ...p, quarter: e.target.value as AtlasBoxQuarter }))}
          className="bg-gray-800 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white"
          aria-label="Quarter"
        >
          {ATLAS_BOX_QUARTERS.map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
        <button
          onClick={() => void runScan()}
          disabled={scanning || applying}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-teal-600 hover:bg-teal-500 disabled:opacity-50 transition-colors"
        >
          {scanning ? 'Scanning Box…' : 'Scan'}
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {applySummary && <p className="text-xs text-teal-300">{applySummary}</p>}
      {scan && scan.displayTreeNote && (
        <p className="text-[11px] text-amber-300 border border-amber-400/30 bg-amber-500/10 rounded-lg px-3 py-2">
          {scan.displayTreeNote}. Social builds can still be applied; run this again once Banner Ads has the quarter.
        </p>
      )}

      {scan && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-300 border-t border-white/10 pt-3">
            <span>{scan.totals.buildFolders} Social · {scan.totals.displayBuilds} Display Build folders</span>
            <span className="text-white/20">|</span>
            <span className="text-teal-300">{matchedRows.length} matched</span>
            <span className="text-amber-300">{attentionRows.length} need attention</span>
            <span className="text-gray-400">{scan.cardsWithoutBuild.length} cards with no build</span>
            {scan.displayMissing.length > 0 && (
              <span className="text-amber-300">{scan.displayMissing.length} with no Display build</span>
            )}
            {offSpecCount > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30">
                {offSpecCount} off-spec size
              </span>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-gray-400">
              {cardWriteCount} card{cardWriteCount === 1 ? '' : 's'} will be updated (file and/or Box links).
            </p>
            <button
              onClick={() => void apply()}
              disabled={applying || scanning || applicable.length === 0}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-teal-600 hover:bg-teal-500 disabled:opacity-50 transition-colors"
            >
              {applying ? 'Applying…' : `Apply to ${cardWriteCount} card${cardWriteCount === 1 ? '' : 's'}`}
            </button>
          </div>

          <SyncGroup
            title="Matched"
            tone="teal"
            rows={matchedRows}
            roster={roster}
            cardLabel={cardLabel}
            onToggle={(row, selected) => patchRow(row.rowKey, { selected })}
            onToggleReplace={(row, replaceLinks) => patchRow(row.rowKey, { replaceLinks })}
            onAddCard={addCard}
            onRemoveCard={removeCard}
          />

          <SyncGroup
            title="Needs attention"
            tone="amber"
            rows={attentionRows}
            roster={roster}
            cardLabel={cardLabel}
            onToggle={(row, selected) => patchRow(row.rowKey, { selected })}
            onToggleReplace={(row, replaceLinks) => patchRow(row.rowKey, { replaceLinks })}
            onAddCard={addCard}
            onRemoveCard={removeCard}
          />

          {scan.displayMissing.length > 0 && !scan.displayTreeNote && (
            <details className="rounded-lg border border-amber-400/30 bg-amber-500/[0.05] p-3">
              <summary className="text-xs font-semibold text-amber-300 cursor-pointer">
                No Display build found — {scan.displayMissing.length} Social build{scan.displayMissing.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-2 space-y-1">
                {scan.displayMissing.map((m) => (
                  <li key={m.rowKey} className="text-[11px] text-gray-300">
                    {m.boxPath} <span className="text-amber-300">— {m.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {scan.cardsWithoutBuild.length > 0 && (
            <details className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
              <summary className="text-xs font-semibold text-gray-300 cursor-pointer">
                No build yet — {scan.cardsWithoutBuild.length} card{scan.cardsWithoutBuild.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-2 space-y-1">
                {scan.cardsWithoutBuild.map((c) => (
                  <li key={c.id} className="text-[11px] text-gray-400">{c.title.replace(/\s+/g, ' ')}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}

function SyncGroup({
  title,
  tone,
  rows,
  roster,
  cardLabel,
  onToggle,
  onToggleReplace,
  onAddCard,
  onRemoveCard,
}: {
  title: string
  tone: 'teal' | 'amber'
  rows: RowState[]
  roster: RosterCard[]
  cardLabel: (id: string) => string
  onToggle: (row: RowState, selected: boolean) => void
  onToggleReplace: (row: RowState, replaceLinks: boolean) => void
  onAddCard: (row: RowState, cardId: string) => void
  onRemoveCard: (row: RowState, cardId: string) => void
}) {
  if (rows.length === 0) return null
  const headTone = tone === 'teal' ? 'text-teal-300' : 'text-amber-300'

  return (
    <div className="space-y-2">
      <h4 className={`text-xs font-semibold ${headTone}`}>{title} — {rows.length}</h4>
      {rows.map((row) => {
        const rosterById = new Map(roster.map((c) => [c.id, c]))
        const chosen = row.chosenCardIds.map((id) => rosterById.get(id)).filter((c): c is RosterCard => !!c)
        const hasExistingLink = chosen.some((c) =>
          (row.buildFolderId && c.buildLink) || (row.display && c.displayBuildLink))
        return (
        <div key={row.rowKey} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
          <div className="flex items-start gap-2.5">
            <input
              type="checkbox"
              checked={row.selected}
              onChange={(e) => onToggle(row, e.target.checked)}
              className="mt-1 flex-none"
            />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-white font-medium">{row.boxPath}</span>
                {row.file && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-300">
                    {row.file.dimensions.width}×{row.file.dimensions.height}
                  </span>
                )}
                {row.offSpec && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30">
                    off-spec size — attachable, consider a re-render
                  </span>
                )}
                {row.result && row.result.failed === 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">
                    ✓ updated {row.result.ok}
                  </span>
                )}
                {row.result && row.result.failed > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">
                    {row.result.failed} failed{row.result.error ? ` — ${row.result.error}` : ''}
                  </span>
                )}
              </div>

              {row.file
                ? <p className="text-[11px] text-gray-500 break-all">{row.file.name}</p>
                : <p className="text-[11px] text-gray-500">
                    {row.buildFolderId ? 'No attachable MP4 — only the Box links will be written.' : 'No Social build — only the Display link will be written.'}
                  </p>}

              {row.display
                ? (
                  <p className="text-[11px] text-sky-300 break-all">
                    Display: {row.display.boxPath} — {row.display.files.length} file{row.display.files.length === 1 ? '' : 's'}
                    {row.display.files.length !== 6 && <span className="text-amber-300"> (expected 6 HTML5 zips)</span>}
                  </p>
                )
                : row.buildFolderId && <p className="text-[11px] text-gray-600">No Display build in Banner Ads yet.</p>}

              {hasExistingLink && (
                <label className="flex items-center gap-1.5 text-[10px] text-gray-400">
                  <input
                    type="checkbox"
                    checked={row.replaceLinks}
                    onChange={(e) => onToggleReplace(row, e.target.checked)}
                  />
                  Replace the card&apos;s existing Box link where it differs (otherwise it is kept)
                </label>
              )}

              {row.reason && <p className="text-[11px] text-amber-300">{row.reason}</p>}

              {/* Editable card picker — chips for what will be written, plus a
                  dropdown to add any Atlas card. This is how a flagged or wrong
                  match gets corrected before anything is written. */}
              <div className="flex flex-wrap items-center gap-1.5">
                {row.chosenCardIds.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-gray-200">
                    {cardLabel(id)}
                    <button
                      onClick={() => onRemoveCard(row, id)}
                      className="text-gray-400 hover:text-white"
                      aria-label="Remove card"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {row.chosenCardIds.length === 0 && (
                  <span className="text-[10px] text-gray-500">No card chosen — this row will be skipped.</span>
                )}
              </div>

              <select
                value=""
                onChange={(e) => { onAddCard(row, e.target.value); e.target.value = '' }}
                className="w-full bg-gray-800 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white"
              >
                <option value="">Add a card…</option>
                {row.candidateCardIds.length > 0 && (
                  <optgroup label="Suggested">
                    {row.candidateCardIds.map((id) => (
                      <option key={id} value={id}>{cardLabel(id)}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="All Atlas cards">
                  {roster.map((c) => (
                    <option key={c.id} value={c.id}>
                      {cardLabel(c.id)}{c.alreadyLinked ? ' · already linked' : ''}
                    </option>
                  ))}
                </optgroup>
              </select>

              {row.skippedFiles.length > 0 && (
                <p className="text-[10px] text-gray-600 break-all">Not attached: {row.skippedFiles.join(', ')}</p>
              )}
            </div>
          </div>
        </div>
        )
      })}
    </div>
  )
}
