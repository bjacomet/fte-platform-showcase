import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildImportSummary, formatSummaryText, periodMismatch, skipReason, type ImportRowOutcome, type SkipCandidate } from './atlasImportSummary'
import { effectiveQuarter, filterByQuarter, quarterOptions } from './atlasQuarterFilter'

const base: SkipCandidate = { sheetRow: 1, locationName: 'X', focusType: 'Y', selected: false, alreadyImported: false, suspectCopy: null, locationId: 'loc' }

test('skipReason precedence', () => {
  assert.equal(skipReason({ ...base, alreadyImported: true, suspectCopy: 'note' }, 'Q1 2027'), 'already imported for Q1 2027')
  assert.equal(skipReason({ ...base, suspectCopy: 'reads as a note' }, 'Q1 2027'), 'flagged: reads as a note')
  assert.equal(skipReason({ ...base, locationId: '' }, 'Q1 2027'), 'no location match')
  assert.equal(skipReason(base, 'Q1 2027'), 'not selected')
})

test('summary totals add up and a gap is shown, not hidden', () => {
  const o = (kind: ImportRowOutcome['kind'], n: number): ImportRowOutcome => ({ sheetRow: n, label: `L${n}`, kind, reason: 'r', cardIds: [] })
  const full = buildImportSummary([o('created', 1), o('reused', 2), o('skipped', 3), o('failed', 4)], 4, 'Q1 2027')
  assert.equal(full.gap, 0)
  const short = buildImportSummary([o('created', 1)], 3, 'Q1 2027')
  assert.equal(short.gap, 2)
  assert.match(formatSummaryText(short), /WARNING: 2 rows unaccounted for/)
  assert.match(formatSummaryText(full), /Row 4 · L4 — r/)
})

test('periodMismatch', () => {
  assert.equal(periodMismatch('Q1 2027', 'Q1', 2027), null)
  assert.equal(periodMismatch('Q1 2027', 'Q4', 2026), 'Pulled from Q1 2027 — saving into Q4 2026. Is that right?')
  assert.equal(periodMismatch('Q1 2027', 'Q1', 2026), 'Pulled from Q1 2027 — saving into Q1 2026. Is that right?')
  assert.equal(periodMismatch('Unlabelled period (columns AX–BE)', 'Q1', 2027), null)
  assert.equal(periodMismatch('Q4 - 10/1-11/15', 'Q4', 2026), null)
})

test('quarter options, default and filter', () => {
  const cards = [
    { atlas_quarter: 'Q4', atlas_year: 2026 }, { atlas_quarter: 'Q1', atlas_year: 2027 },
    { atlas_quarter: 'Q1', atlas_year: 2027 }, { atlas_quarter: null, atlas_year: null }, {},
  ]
  const opts = quarterOptions(cards)
  assert.deepEqual(opts.map((o) => o.label), ['Q1 2027', 'Q4 2026'])
  assert.equal(effectiveQuarter(null, opts), '2027-Q1')
  assert.equal(effectiveQuarter('2026-Q4', opts), '2026-Q4')
  assert.equal(effectiveQuarter('2025-Q2', opts), '2027-Q1')
  assert.equal(effectiveQuarter('all', opts), 'all')
  assert.equal(effectiveQuarter(null, []), 'all')
  assert.equal(filterByQuarter(cards, '2027-Q1').length, 2)
  assert.equal(filterByQuarter(cards, 'all').length, 5)
})

test('legacy Atlas select drops only the quarter columns', async () => {
  const { ATLAS_BOARD_CARD_SELECT, ATLAS_BOARD_CARD_SELECT_NO_QUARTER } = await import('./cardQueries')
  assert.match(ATLAS_BOARD_CARD_SELECT, /atlas_quarter, atlas_year/)
  assert.doesNotMatch(ATLAS_BOARD_CARD_SELECT_NO_QUARTER, /atlas_quarter|atlas_year/)
  assert.match(ATLAS_BOARD_CARD_SELECT_NO_QUARTER, /atlas_column_id, display_build_link/)
})

test('a drawer edit keeps the card quarter and year', async () => {
  const { toAtlasBoardCard } = await import('./atlasBoardCard')
  const prev = { id: 'c1', atlas_quarter: 'Q1', atlas_year: 2027, atlas_column_id: 's1', card_files: [] } as unknown as import('@/types').AtlasBoardCard
  const noQuarter = { id: 'c1', title: 't', clients: null } as unknown as import('@/types').Card
  const kept = toAtlasBoardCard(noQuarter, prev)
  assert.equal(kept.atlas_quarter, 'Q1')
  assert.equal(kept.atlas_year, 2027)
  const edited = toAtlasBoardCard({ ...noQuarter, atlas_quarter: 'Q2', atlas_year: 2027 } as import('@/types').Card, prev)
  assert.equal(edited.atlas_quarter, 'Q2')
  assert.equal(toAtlasBoardCard(noQuarter).atlas_quarter, null)
})
