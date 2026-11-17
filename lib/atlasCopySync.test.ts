import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPullRows, detectCopyBlocks } from './atlasSheet'
import { buildAtlasCopyDiff, type AtlasCopyCard } from './atlasCopySync'
import type { AtlasCreativeRefresh } from '@/types'

// Two period blocks, laid out by header text with DIFFERENT internal offsets
// (the older block's Display link sits one column further along, as in the live
// sheet). Columns: A-C fixed, J.. older block, then the newer block.
//   older: Social Copy(3) Graphic(4) x(5) x(6) x(7) Display(8) Social(9)
//   newer: Social Copy(10) Graphic(11) x(12) Display(13) Social(14)
const BANNER = ['', '', '', 'Q3', '', '', '', '', '', '', 'Q4', '', '', '', '']
const HEADER = ['Location', 'Importance', 'Focus', 'Social Copy', 'Graphic Copy', 'a', 'b', 'c',
  'Display Build Box Link', 'Social Build Box Link', 'Social Copy', 'Graphic Copy', 'a',
  'Display Build Box Link', 'Social Build Box Link']

const COPY = 'Social Copy: ' + 'x'.repeat(200) + '\nSocial Headline: Hello'

function row(loc: string, focus: string, cells: Record<number, string>): string[] {
  const r = Array.from({ length: HEADER.length }, () => '')
  r[0] = loc; r[1] = 'Primary'; r[2] = focus
  for (const [k, v] of Object.entries(cells)) r[Number(k)] = v
  return r
}

const locations = [{ id: 'L1', name: 'Atlas - Alpha' }, { id: 'L2', name: 'Atlas - Beta' }]

function card(id: string, title: string, loc: string, extra: Partial<AtlasCopyCard> = {}): AtlasCopyCard {
  return {
    id, title, atlas_location_id: loc, adpiler_preview_url: 'https://x', fb_body_text: 'x'.repeat(200),
    fb_headline: 'Hello', fb_subheadline: null, heading: null, subheading: null, landing_page_url: null,
    build_link: null, display_build_link: null, ...extra,
  }
}

function refresh(loc: string, focus: string, extra: Partial<AtlasCreativeRefresh> = {}): AtlasCreativeRefresh {
  return {
    id: `r-${loc}`, location_id: loc, focus_type: focus, quarter: 'Q4', year: 2026,
    social_copy: 'x'.repeat(200), social_headline: 'Hello', social_subhead: null, graphic_headline: null,
    graphic_subhead: null, adpiler_link: null, facebook_url: null, display_url: null,
    social_build_box_link: null, display_build_box_link: null, status: 'draft', created_at: '', updated_at: '',
    ...extra,
  }
}

test('detectCopyBlocks finds link columns by header text despite uneven offsets', () => {
  const blocks = detectCopyBlocks([BANNER, HEADER])
  assert.equal(blocks.length, 2)
  assert.deepEqual([blocks[0].displayBoxCol, blocks[0].socialBoxCol], [8, 9])
  assert.deepEqual([blocks[1].displayBoxCol, blocks[1].socialBoxCol], [13, 14])
})

test('links come from the selected period only — older blocks are never consulted', () => {
  const all = [BANNER, HEADER, row('Atlas Alpha', 'Breast', { 9: 'old-social', 8: 'old-display', 10: COPY, 14: 'new-social' })]
  const blocks = detectCopyBlocks(all)
  const pull = (b: number) => buildPullRows(all, { block: blocks[b], locations, dataStartIndex: 2, importedKeys: new Set() }).rows[0]
  // Newer block: its own social link, and NO display link even though Q3 has one.
  assert.equal(pull(1).parsed.social_build_box_link, 'new-social')
  assert.equal(pull(1).parsed.display_build_box_link, null)
  // Older block (needs copy in its own band to be a row): its own links only.
  const older = [BANNER, HEADER, row('Atlas Alpha', 'Breast', { 3: COPY, 9: 'old-social', 8: 'old-display', 14: 'new-social' })]
  const ob = detectCopyBlocks(older)
  const r = buildPullRows(older, { block: ob[0], locations, dataStartIndex: 2, importedKeys: new Set() }).rows[0]
  assert.equal(r.parsed.social_build_box_link, 'old-social')
  assert.equal(r.parsed.display_build_box_link, 'old-display')
})

function diffFor(rows: string[][], cards: AtlasCopyCard[], refreshRows: AtlasCreativeRefresh[]) {
  const all = [BANNER, HEADER, ...rows]
  const blocks = detectCopyBlocks(all)
  const { rows: pull } = buildPullRows(all, {
    block: blocks[1], locations, dataStartIndex: 2,
    importedKeys: new Set(refreshRows.map((r) => `${r.location_id}::${r.focus_type.toLowerCase()}`)),
  })
  return buildAtlasCopyDiff(pull, cards, refreshRows, locations)
}

test('link-only change: pre-selectable fill, no approval reset, selected period only', () => {
  const d = diffFor(
    [row('Atlas Alpha', 'Breast', { 10: COPY, 14: 'S1', 13: 'D1', 8: 'D-old' })],
    [card('c1', 'Atlas - Alpha — Breast (Social)', 'L1')],
    [refresh('L1', 'Breast')],
  )
  assert.equal(d.rows.length, 1)
  const c = d.rows[0].candidates[0]
  assert.equal(c.resetsApproval, false)
  assert.deepEqual(c.fields.map((f) => [f.field, f.kind, f.sheet, f.conflict]), [
    ['build_link', 'link', 'S1', false],
    ['display_build_link', 'link', 'D1', false],
  ])
  assert.equal(d.totals.linksToFill, 2)
  assert.equal(d.totals.unchanged, 0)
})

test('never blanks a link; counts cards still missing one', () => {
  const d = diffFor(
    [row('Atlas Alpha', 'Breast', { 10: COPY })],
    [card('c1', 'Atlas - Alpha — Breast (Social)', 'L1', { build_link: 'keep-me' })],
    [refresh('L1', 'Breast')],
  )
  assert.equal(d.rows.length, 0)
  assert.equal(d.totals.unchanged, 1)
  assert.equal(d.totals.missingSocial, 0)
  assert.equal(d.totals.missingDisplay, 1)
})

test('copy change on a live card still resets approval; hand-pasted link is a conflict', () => {
  const d = diffFor(
    [row('Atlas Alpha', 'Breast', { 10: COPY.replace('Hello', 'Hi there'), 14: 'S-sheet' })],
    [card('c1', 'Atlas - Alpha — Breast (Social)', 'L1', { build_link: 'S-hand' })],
    [refresh('L1', 'Breast', { social_build_box_link: null })],
  )
  const c = d.rows[0].candidates[0]
  assert.equal(c.resetsApproval, true)
  const link = c.fields.find((f) => f.field === 'build_link')
  assert.equal(link?.conflict, true)
  assert.equal(d.totals.linksToReplace, 1)
  // Card link equal to the last-sync baseline is a plain replace, not a conflict.
  const d2 = diffFor(
    [row('Atlas Alpha', 'Breast', { 10: COPY, 14: 'S-new' })],
    [card('c1', 'Atlas - Alpha — Breast (Social)', 'L1', { build_link: 'S-old' })],
    [refresh('L1', 'Breast', { social_build_box_link: 'S-old' })],
  )
  assert.equal(d2.rows[0].candidates[0].fields[0].conflict, false)
})
