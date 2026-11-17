export type ImportOutcomeKind = 'created' | 'reused' | 'skipped' | 'failed'

export interface ImportRowOutcome {
  sheetRow: number
  label: string
  kind: ImportOutcomeKind
  reason: string
  cardIds: string[]
}

export interface ImportSummary {
  periodLabel: string
  pulled: number
  created: ImportRowOutcome[]
  reused: ImportRowOutcome[]
  skipped: ImportRowOutcome[]
  failed: ImportRowOutcome[]
  /** pulled minus rows that landed in a list. Non-zero means the loop lost a row. */
  gap: number
}

export interface SkipCandidate {
  sheetRow: number
  locationName: string
  focusType: string
  selected: boolean
  alreadyImported: boolean
  suspectCopy: string | null
  locationId: string
}

export function rowLabel(r: { locationName: string; focusType: string }): string {
  return `${r.locationName || '(no location)'} — ${r.focusType || '(no focus)'}`
}

// Why a row in the pulled set was not imported. Must be evaluated on the flags as
// they were BEFORE the run: a successful import flips alreadyImported to true.
export function skipReason(r: SkipCandidate, periodLabel: string): string {
  if (r.alreadyImported) return `already imported for ${periodLabel}`
  if (r.suspectCopy) return `flagged: ${r.suspectCopy}`
  if (!r.locationId) return 'no location match'
  return 'not selected'
}

export function buildImportSummary(
  outcomes: ImportRowOutcome[],
  pulled: number,
  periodLabel: string,
): ImportSummary {
  const by = (kind: ImportOutcomeKind) => outcomes.filter((o) => o.kind === kind)
  return {
    periodLabel,
    pulled,
    created: by('created'),
    reused: by('reused'),
    skipped: by('skipped'),
    failed: by('failed'),
    gap: pulled - outcomes.length,
  }
}

function lines(title: string, rows: ImportRowOutcome[], withReason: boolean): string[] {
  if (rows.length === 0) return []
  return [
    '',
    `${title} (${rows.length})`,
    ...rows.map((o) => `Row ${o.sheetRow} · ${o.label}${withReason && o.reason ? ` — ${o.reason}` : ''}`),
  ]
}

export function formatSummaryText(s: ImportSummary): string {
  const head = `Import finished — ${s.periodLabel}: ${s.created.length} created, ${s.reused.length} reused existing shared card, ${s.skipped.length} skipped, ${s.failed.length} failed (of ${s.pulled} rows pulled)`
  return [
    head,
    ...(s.gap !== 0 ? [`WARNING: ${s.gap} row${Math.abs(s.gap) !== 1 ? 's' : ''} unaccounted for`] : []),
    ...lines('Created', s.created, false),
    ...lines('Reused existing shared card', s.reused, true),
    ...lines('Skipped', s.skipped, true),
    ...lines('Failed', s.failed, true),
  ].join('\n')
}

// "Pulled from Q1 2027 — saving into Q4 2026". The period label is whatever the
// sheet banner says, and banners are often stale or missing, so only warn when
// the label actually states a quarter (and a year, when it gives one).
export function periodMismatch(blockLabel: string, quarter: string, year: number): string | null {
  const q = /\bQ([1-4])\b/i.exec(blockLabel)
  if (!q) return null
  const y = /\b(20\d{2})\b/.exec(blockLabel)
  const labelQuarter = `Q${q[1]}`
  const labelYear = y ? Number(y[1]) : null
  if (labelQuarter === quarter && (labelYear === null || labelYear === year)) return null
  const pulled = labelYear ? `${labelQuarter} ${labelYear}` : labelQuarter
  return `Pulled from ${pulled} — saving into ${quarter} ${year}. Is that right?`
}
