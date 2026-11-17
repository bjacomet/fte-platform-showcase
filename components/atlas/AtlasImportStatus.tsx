'use client'

import { type ImportRowOutcome, type ImportSummary } from '@/lib/atlasImportSummary'

interface Props {
  mismatch: string | null
  progress: { done: number; total: number; current: string } | null
  summary: ImportSummary | null
  copied: boolean
  onCopy: () => void
  onDismiss: () => void
}

export default function AtlasImportStatus({ mismatch, progress, summary, copied, onCopy, onDismiss }: Props) {
  return (
    <>
      {mismatch && (
        <p className="text-xs text-amber-300 border border-amber-400/30 bg-amber-500/10 rounded-lg px-3 py-2">⚠ {mismatch}</p>
      )}

      {progress && (
        <div className="space-y-1.5" role="status" aria-live="polite">
          <p className="text-sm text-white">Importing {Math.min(progress.done + 1, progress.total)} of {progress.total}…</p>
          <div className="h-2 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full bg-teal-500 transition-all"
              style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
            />
          </div>
          {progress.current && <p className="text-[11px] text-gray-400">{progress.current}</p>}
          <p className="text-[10px] text-gray-500">Keep this tab open — leaving stops the import.</p>
        </div>
      )}

      {summary && (
        <div className="rounded-lg border border-white/15 bg-white/[0.03] p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-semibold text-white">Import finished — {summary.periodLabel}</p>
            <div className="flex gap-2 flex-none">
              <button
                onClick={onCopy}
                className="px-2 py-1 rounded border border-white/15 text-[11px] text-gray-300 hover:border-white/30 transition-colors"
              >
                {copied ? 'Copied ✓' : 'Copy summary'}
              </button>
              <button
                onClick={onDismiss}
                className="px-2 py-1 rounded border border-white/15 text-[11px] text-gray-300 hover:border-white/30 transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
          <p className="text-sm">
            <span className="text-teal-300">✓ {summary.created.length} created</span>
            {summary.reused.length > 0 && <span className="text-sky-300"> · ↻ {summary.reused.length} reused existing shared card</span>}
            <span className="text-amber-300"> · ⚠ {summary.skipped.length} skipped</span>
            <span className="text-red-300"> · ✕ {summary.failed.length} failed</span>
            <span className="text-gray-500"> · of {summary.pulled} rows pulled</span>
          </p>
          {summary.gap !== 0 && (
            <p className="text-xs text-red-300">
              {Math.abs(summary.gap)} row{Math.abs(summary.gap) !== 1 ? 's' : ''} {summary.gap > 0 ? 'unaccounted for' : 'counted twice'} — the totals above do not add up to the rows pulled.
            </p>
          )}
          {([
            ['Created', summary.created, false, 'text-teal-300'],
            ['Reused existing shared card', summary.reused, true, 'text-sky-300'],
            ['Skipped', summary.skipped, true, 'text-amber-300'],
            ['Failed', summary.failed, true, 'text-red-300'],
          ] as [string, ImportRowOutcome[], boolean, string][]).filter(([, rows]) => rows.length > 0).map(([title, rows, withReason, tone]) => (
            <details key={title} className="rounded border border-white/10 px-2 py-1.5">
              <summary className={`text-xs cursor-pointer ${tone}`}>{title} ({rows.length})</summary>
              <ul className="mt-1.5 space-y-0.5">
                {rows.map(o => (
                  <li key={o.sheetRow} className="text-[11px] text-gray-300">
                    Row {o.sheetRow} · {o.label}
                    {withReason && o.reason && <span className="text-gray-500"> — {o.reason}</span>}
                    {o.cardIds.map((id, n) => (
                      <a key={id} href={`/card/${id}`} target="_blank" rel="noreferrer" className="ml-2 text-sky-400 hover:underline">
                        {o.cardIds.length > 1 ? `card ${n + 1}` : 'card'} ↗
                      </a>
                    ))}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </>
  )
}
