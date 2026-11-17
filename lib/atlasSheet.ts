/**
 * Parser for a single row pasted from the Atlas "Copy Plan" Google Sheet.
 *
 * A row copied from Google Sheets arrives as tab-separated cells; any cell that
 * contains tabs/newlines/quotes is wrapped in double quotes with internal quotes
 * doubled (standard TSV quoting). The multi-line "AP" cell holds five labeled
 * copy fields; the H / I / AU / AW cells hold URLs and Box build links.
 *
 * Column map (0-based): H=7, I=8, AP=41, AU=46, AW=48.
 */

import { normalizeFocus } from '@/lib/atlasFocus'

export interface ParsedCopyPlanRow {
  social_copy: string | null
  social_headline: string | null
  social_subhead: string | null
  graphic_headline: string | null
  graphic_subhead: string | null
  facebook_url: string | null           // col H  — FB ad URL w/ UTMs
  display_url: string | null            // col I  — Display ad URL w/ UTMs
  social_build_box_link: string | null  // col AW — MP4 build folder
  display_build_box_link: string | null // col AU — HTML5 build folder
}

export type ParseResult =
  | { ok: true; data: ParsedCopyPlanRow }
  | { ok: false; error: string }

// One row in the CSV-import preview (built client-side by buildPullRows).
export interface CopyPlanPullRow {
  sheetRow: number                                   // 1-based sheet row (reference only)
  locationName: string                               // raw col-A name (forward-filled)
  focusImportance: string | null                     // col B — 'Primary' | 'Secondary' (forward-filled)
  matchedLocationId: string | null                   // best atlas_locations match
  matchConfidence: 'exact' | 'fuzzy' | 'none'
  focusType: string                                  // col C
  parsed: ParsedCopyPlanRow
  alreadyImported: boolean                           // exists for location+focus+quarter+year
  /** Set when the copy looks like a note or an unfilled stub — see copyNoteReason. */
  suspectCopy: string | null
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// Reconcile a sheet location name ("Atlas Lakeside") to an atlas_locations row
// ("Atlas - Lakeside Cancer Center"). Exact normalized match wins; otherwise the
// sheet name is usually a shortened form, so match on substring either direction
// and prefer the longest app name that contains it.
export function matchAtlasLocation(
  sheetName: string,
  locations: { id: string; name: string }[],
): { id: string | null; confidence: 'exact' | 'fuzzy' | 'none' } {
  const target = normalizeName(sheetName)
  if (!target) return { id: null, confidence: 'none' }

  for (const l of locations) {
    if (normalizeName(l.name) === target) return { id: l.id, confidence: 'exact' }
  }

  let best: { id: string; len: number } | null = null
  for (const l of locations) {
    const n = normalizeName(l.name)
    if (n.includes(target) || target.includes(n)) {
      if (!best || n.length > best.len) best = { id: l.id, len: n.length }
    }
  }
  return best ? { id: best.id, confidence: 'fuzzy' } : { id: null, confidence: 'none' }
}

const COL = { H: 7, I: 8, AP: 41, AU: 46, AW: 48 } as const

const AP_LABELS = [
  'Social Copy',
  'Social Headline',
  'Social Subhead',
  'Graphic Headline',
  'Graphic Subhead',
] as const

function labelKey(label: string): keyof ParsedCopyPlanRow {
  return label.toLowerCase().replace(/\s+/g, '_') as keyof ParsedCopyPlanRow
}

// Split one pasted row into cells. Respects Google Sheets' double-quote quoting
// (a quoted cell can contain tabs and newlines; "" is an escaped quote). Stops
// at the first unquoted newline so a trailing line break doesn't add a cell.
function splitRow(raw: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === '\t') {
      cells.push(cur); cur = ''
    } else if (ch === '\n') {
      break
    } else if (ch === '\r') {
      // ignore
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells
}

function cell(cells: string[], idx: number): string | null {
  const v = cells[idx]?.trim()
  return v ? v : null
}

// Pull the five labeled copy fields out of the AP cell. Values run from the end
// of one label to the start of the next (labels can appear in any order).
function parseApCell(ap: string | null): Pick<
  ParsedCopyPlanRow,
  'social_copy' | 'social_headline' | 'social_subhead' | 'graphic_headline' | 'graphic_subhead'
> {
  const out = {
    social_copy: null as string | null,
    social_headline: null as string | null,
    social_subhead: null as string | null,
    graphic_headline: null as string | null,
    graphic_subhead: null as string | null,
  }
  if (!ap) return out

  const pattern = AP_LABELS.map((l) => l.replace(/\s+/g, '\\s+')).join('|')
  const re = new RegExp(`(${pattern})\\s*:?\\s*`, 'gi')
  const matches = [...ap.matchAll(re)]
  if (matches.length === 0) {
    // No labels found — treat the whole cell as the body copy.
    out.social_copy = ap.trim() || null
    return out
  }

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? ap.length) : ap.length
    const value = ap.slice(start, end).trim()
    const key = labelKey(m[1].replace(/\s+/g, ' ')) as keyof typeof out
    if (key in out) out[key] = value || null
  }

  // Text sitting BEFORE the first label used to be dropped on the floor. Two very
  // different things appear there in the real sheet, and they are told apart by
  // whether a "Social Copy:" label exists anywhere in the cell:
  //   - with one, the leading text is a category heading ("Prostate", "Skin") and
  //     the labelled body is authoritative — leave it alone;
  //   - without one, the author wrote the body copy first and only labelled the
  //     headline and subhead, so that leading text IS the body and was being lost.
  // Measured over all six periods of the Sep 2026 workbook: 63 rows of the first
  // kind, 6 of the second, no ambiguous cases.
  if (!out.social_copy) {
    const lead = ap.slice(0, matches[0].index ?? 0).trim()
    if (lead) out.social_copy = lead
  }

  return out
}

// Build a parsed row from an already-split cell array (0-based columns per COL).
// Shared by the paste path (after splitRow) and the auto-pull path, where the
// Sheets API already returns each row as an array of cell values.
export function parseCopyPlanCells(cells: string[], block?: CopyBlock): ParsedCopyPlanRow {
  // Without a block, fall back to the historical fixed columns (AP/AU/AW) — that
  // is what the single-row PASTE path uses, since a pasted row carries no header
  // to detect from. The CSV path always passes a detected block.
  const copyCol = block ? block.copyCol : COL.AP
  const socialBoxCol = block ? block.socialBoxCol : COL.AW
  const displayBoxCol = block ? block.displayBoxCol : COL.AU
  return {
    ...parseApCell(cell(cells, copyCol)),
    facebook_url: cell(cells, COL.H),
    display_url: cell(cells, COL.I),
    social_build_box_link: socialBoxCol === null ? null : cell(cells, socialBoxCol),
    display_build_box_link: displayBoxCol === null ? null : cell(cells, displayBoxCol),
  }
}

/**
 * Why a row's "copy" should not be trusted as ad copy, or null when it reads fine.
 *
 * The existing empty-cell guard in buildPullRows is sound but can only see
 * blank vs non-blank, and the two ways this sheet goes wrong both produce a
 * NON-blank cell:
 *
 *   1. A reuse note typed into the copy column — "Still Good" at sheet rows 23
 *      and 98. Both were imported as real cards on 2026-09-14, each carrying
 *      the note as its Facebook caption with no headline and no subheader.
 *   2. An unfilled template stub — the literal "Primary:/Headline:/Description:"
 *      skeleton with nothing after the colons. Ten of these sit in the Q3 band
 *      right now (several practices across the network,
 *      for example). None has been imported yet; nothing was stopping them.
 *
 * Advisory, never a hard block: this returns a reason so the import preview can
 * badge the row and leave it unticked. A human can still tick it — the sheet is
 * theirs and a short caption might one day be deliberate.
 */
// Every label that can appear inside a copy cell, as one regex. Built from
// AP_LABELS rather than a second hardcoded list, because the two vocabularies
// are the whole problem: parseApCell CONSUMES the AP_LABELS labels, so a stub
// written with the sheet's own labels ("Social Copy:/Social Headline:" and
// nothing after them) parses to all-null and never reaches a check that only
// looked for the `Primary:/Headline:/Description:` shape. The heuristic caught
// one vocabulary and silently passed the other — and it exists because bogus
// live cards shipped twice.
const COPY_LABEL_RE = new RegExp(
  // Longest first, so "Social Headline" is consumed before "headline" can eat
  // half of it and leave "social " behind as apparent copy.
  [...AP_LABELS.map((l) => l.toLowerCase()), 'primary', 'description', 'headline', 'subhead', 'social copy']
    .sort((a, b) => b.length - a.length)
    .map((l) => l.replace(/\s+/g, '\\s+'))
    .join('|'),
  'gi',
)

/** Strips label words and their colons, leaving only what a human typed. */
function stripCopyLabels(text: string): string {
  return text.replace(COPY_LABEL_RE, '').replace(/[:\s]+/g, ' ').trim()
}

export function copyNoteReason(data: ParsedCopyPlanRow): string | null {
  const copy = (data.social_copy ?? '').trim()

  // Every copy field empty. With the sheet's own labels this is what an unfilled
  // stub looks like AFTER parsing — parseApCell ate the labels and found nothing
  // under them — so it is a template row, not a blank row. rowHasAnyContent still
  // decides whether the row is worth showing at all; this decides whether it
  // arrives pre-ticked.
  const anyCopy = data.social_copy || data.social_headline || data.social_subhead ||
    data.graphic_headline || data.graphic_subhead
  if (!anyCopy) return 'unfilled template — labels but no copy under them'

  if (!copy) return null

  // Template skeleton in the other vocabulary: labels survive in the cell
  // because they are not AP_LABELS, so nothing consumed them.
  const stripped = stripCopyLabels(copy)
  if (!stripped) return 'unfilled template — only the labels, no copy'

  // A reuse note. Real ad copy for these placements runs 240–380 characters;
  // the shortest genuine cell in the Sep 2026 export is well over 200.
  //
  // 60 → 120, and graphic copy joins the gate. "Still good — keep running the
  // August creative and copy here." is 60 characters and slipped through at the
  // old threshold; a row carrying only graphic copy plus a short social caption
  // was flagged when it should not have been.
  const hasRealCompanionCopy = !!(
    data.social_headline || data.social_subhead || data.graphic_headline || data.graphic_subhead
  )
  if (stripped.length < 120 && !hasRealCompanionCopy) {
    return `looks like a note, not copy — "${copy.replace(/\s+/g, ' ').slice(0, 40)}"`
  }

  return null
}

// True when a parsed row carries any copy or link — used to skip blank sheet rows.
export function rowHasAnyContent(data: ParsedCopyPlanRow): boolean {
  return !!(
    data.social_copy || data.social_headline || data.social_subhead ||
    data.graphic_headline || data.graphic_subhead ||
    data.facebook_url || data.display_url ||
    data.social_build_box_link || data.display_build_box_link
  )
}

export function parseCopyPlanRow(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Nothing pasted.' }

  // A tab-less paste is just the AP copy cell on its own (multi-line); a full row
  // is tab-separated with the AP cell quoted, so split it into columns.
  const hasTabs = raw.includes('\t')
  const data: ParsedCopyPlanRow = hasTabs
    ? parseCopyPlanCells(splitRow(raw))
    : {
        ...parseApCell(raw.trim()),
        facebook_url: null,
        display_url: null,
        social_build_box_link: null,
        display_build_box_link: null,
      }

  if (!rowHasAnyContent(data)) {
    return { ok: false, error: 'Could not find any copy or links in the pasted row. Paste a full Copy Plan row (or at least the AP copy cell).' }
  }

  return { ok: true, data }
}

// ── CSV import (a tab downloaded from the Copy Plan sheet as .csv) ─────────

// Column positions for the whole-row layout (0-based). COL (H/I/AP/AU/AW) covers
// copy + links; these add the fields the pull needs to place a row.
const LOCATION_COL = 0   // A — location name (merged: only its top row carries a value)
const IMPORTANCE_COL = 1 // B — Primary/Secondary (merged in blocks within a location)
const FOCUS_TYPE_COL = 2 // C — focus type

// One campaign period in the sheet. The Copy Plan tab grows a NEW 8-column
// block each period (Social Copy / Graphic Copy / Spec Adpiler / Location Adpiler /
// Approved / Display Build Box / [Uploaded to TTD] / Social Build Box), so the
// period's copy is never at a fixed column — as of Sep 2026 there are six blocks
// starting at J, R, Z, AH, AP and AX, and their internal offsets are NOT uniform
// (the J block's Display link sits one column further along than the rest).
// Blocks are therefore detected from the header row by header TEXT, never by offset.
export interface CopyBlock {
  label: string            // row-1 banner ("Q4 - 10/1-11/15") or a column-range fallback
  copyCol: number          // "Social Copy"
  socialBoxCol: number | null   // "Social Build Box Link" — the MP4 build
  displayBoxCol: number | null  // "Display Build Box Link" — the HTML5 build
  startCol: number
  endCol: number           // exclusive
}

function colLetter(index0: number): string {
  let n = index0 + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const norm = (v: string | undefined) => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

// Find every campaign-period block in the sheet. `bannerRow` is sheet row 1 (the
// merged period titles) and `headerRow` is sheet row 2. A block runs from one
// "Social Copy" header to the next; the two Box-link columns are located inside it
// by their header text, so a block that is missing one simply yields null for it.
export function findHeaderRowIndex(rows: string[][], searchLimit = 15): number {
  // Normally sheet row 2 (index 1), but an export can carry an extra frozen or
  // spacer row, so locate the header by content instead of trusting the position.
  const limit = Math.min(rows.length, searchLimit)
  for (let r = 0; r < limit; r++) {
    if ((rows[r] ?? []).some((c) => norm(c) === 'social copy')) return r
  }
  return -1
}

export function detectCopyBlocks(rows: string[][], bannerRowIndex?: number, headerRowIndex?: number): CopyBlock[] {
  const hdrIdx = headerRowIndex ?? findHeaderRowIndex(rows)
  if (hdrIdx < 0) return []
  const banner = rows[bannerRowIndex ?? Math.max(0, hdrIdx - 1)] ?? []
  const header = rows[hdrIdx] ?? []
  const starts: number[] = []
  for (let c = 0; c < header.length; c++) {
    if (norm(header[c]) === 'social copy') starts.push(c)
  }

  return starts.map((startCol, i) => {
    const endCol = i + 1 < starts.length ? starts[i + 1] : header.length
    let socialBoxCol: number | null = null
    let displayBoxCol: number | null = null
    for (let c = startCol; c < endCol; c++) {
      const h = norm(header[c])
      if (h === 'social build box link') socialBoxCol = c
      else if (h === 'display build box link') displayBoxCol = c
    }
    // The banner is merged across the block, so on export only its first column
    // carries the text; the newest blocks often have no banner at all.
    let label = ''
    for (let c = startCol; c < endCol; c++) {
      const b = (banner[c] ?? '').trim()
      if (b) { label = b; break }
    }
    // Two of the six bands in the live sheet carry no banner at all. A bare
    // column range reads like a real period name and is easy to mis-click —
    // and a mis-click is already on record (three unticks landed on the wrong
    // rows in the Sep import). Say plainly that it is unlabelled.
    if (!label) label = `Unlabelled period (columns ${colLetter(startCol)}–${colLetter(endCol - 1)})`
    return { label, copyCol: startCol, socialBoxCol, displayBoxCol, startCol, endCol }
  })
}

// Explain, in the user's terms, why a dropped file yielded no blocks. The old
// message just said "no Social Copy column", which is true but gives the user
// nothing to act on — the two real causes are dropping the .xlsx instead of a CSV
// export, and exporting while a different tab was active (File → Download → CSV
// exports only the tab you are looking at).
export function describeCsvProblem(text: string, rows: string[][]): string {
  if (text.startsWith('PK')) {
    return 'That looks like an .xlsx workbook, not a CSV. In the sheet, open the Creative Refresh tab, then File → Download → Comma-separated values (.csv) — it exports whichever tab is active.'
  }
  const headers = (rows[0] ?? []).concat(rows[1] ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 6)
  if (headers.length === 0) {
    return 'That file appears to be empty. Export the Creative Refresh tab with File → Download → Comma-separated values (.csv).'
  }
  return `No "Social Copy" column found. The first columns in that file are: ${headers.join(', ')}. File → Download → CSV exports only the tab you are currently viewing, so open the Creative Refresh tab first and export again.`
}

// Full CSV parse → rows of cells. Handles RFC-4180 quoting: a quoted field may
// contain commas, newlines, and "" escapes — required because the AP copy cell is
// multi-line. A trailing blank line is dropped.
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cur); cur = ''
    } else if (ch === '\r') {
      // ignore — newline handling is on \n
    } else if (ch === '\n') {
      row.push(cur); cur = ''
      rows.push(row); row = []
    } else {
      cur += ch
    }
  }
  row.push(cur)
  if (!(row.length === 1 && row[0] === '')) rows.push(row)
  return rows
}

// Turn parsed CSV rows into pull-preview rows: forward-fill the merged location
// cells, select the rows whose copy cell in the CHOSEN PERIOD has content (not the
// D–G quarter checkboxes — those are empty in the live sheet), parse copy/links,
// match the location, and flag rows already imported. Pure — so it runs client-side
// and is unit-testable.
export interface PullRowsResult {
  rows: CopyPlanPullRow[]
  /**
   * Secondary rows dropped because the same location+focus also has a Primary.
   * Returned rather than discarded so the preview can say why its total shrank —
   * a count silently going 90 → 85 with no reason on screen is exactly the kind
   * of thing that costs an afternoon to work out.
   */
  skippedSecondary: { sheetRow: number; locationName: string; focusType: string }[]
}

export function buildPullRows(
  rows: string[][],
  opts: {
    block: CopyBlock          // which campaign-period block to read (from detectCopyBlocks)
    locations: { id: string; name: string }[]
    importedKeys: Set<string> // `${location_id}::${focus_type_lowercased}`
    dataStartIndex?: number   // rows before this are banner/header (sheet: 2)
  },
): PullRowsResult {
  const dataStart = opts.dataStartIndex ?? 2
  const { block } = opts
  const out: CopyPlanPullRow[] = []
  let lastLocation = ''
  // Col B is merged into Primary-then-Secondary blocks INSIDE each location, so
  // it forward-fills like col A but resets when a new location starts — every
  // location's first row carries its own 'Primary'. A row with no tier at all is
  // treated as Primary, i.e. never skipped: an unknown tier must not drop copy.
  let lastImportance = ''

  for (let i = dataStart; i < rows.length; i++) {
    const cells = rows[i]
    const rawLoc = (cells[LOCATION_COL] ?? '').trim()
    if (rawLoc) { lastLocation = rawLoc; lastImportance = '' } // forward-fill merged location cell
    const rawImportance = (cells[IMPORTANCE_COL] ?? '').trim()
    if (rawImportance) lastImportance = rawImportance

    // A row belongs to this period when the period's own Social Copy cell has
    // content. The D–G "quarter" checkbox columns are NOT usable for this: they
    // are empty for every row in the live sheet (verified against the Sep 2026
    // export — 0 of 1142 rows carry a value), so filtering on them returned
    // nothing at all. Copy-presence is also self-maintaining: writing the copy
    // is what puts a location in the period.
    if (!(cells[block.copyCol] ?? '').trim()) continue

    const parsed = parseCopyPlanCells(cells, block)
    if (!rowHasAnyContent(parsed)) continue

    const focusType = (cells[FOCUS_TYPE_COL] ?? '').trim()
    const match = matchAtlasLocation(lastLocation, opts.locations)
    const alreadyImported =
      !!match.id && opts.importedKeys.has(`${match.id}::${focusType.toLowerCase()}`)

    out.push({
      sheetRow: i + 1,
      locationName: lastLocation,
      focusImportance: lastImportance || null,
      matchedLocationId: match.id,
      matchConfidence: match.confidence,
      focusType,
      parsed,
      alreadyImported,
      suspectCopy: copyNoteReason(parsed),
    })
  }

  // One card per location+focus. Column B is a TIE-BREAKER only: when the same
  // location+focus carries BOTH a Primary and a Secondary row in this period,
  // the Primary wins and the Secondary is dropped. A focus that appears only
  // under Secondary imports normally — skipping every Secondary row would drop
  // 44 rows of this export, 39 of them the only row for their focus (Lakeside
  // Lung and Prostate, every ScanCo creative, Southwest Region Urology, and more).
  //
  // In the Sep 2026 export exactly 5 Secondary rows have a Primary twin — sheet
  // rows 43, 67, 68, 83, 84 — and dropping them leaves exactly one row per
  // location+focus, which is why atlas_creative_refresh's existing unique key on
  // (location_id, focus_type, quarter, year) is correct as it stands.
  const primaryKeys = new Set(
    out.filter((r) => isPrimary(r.focusImportance))
      .map((r) => `${r.locationName}::${normalizeFocus(r.focusType)}`),
  )
  const dropped = (r: CopyPlanPullRow) =>
    isSecondary(r.focusImportance) && primaryKeys.has(`${r.locationName}::${normalizeFocus(r.focusType)}`)

  return {
    rows: out.filter((r) => !dropped(r)),
    skippedSecondary: out.filter(dropped).map((r) => ({
      sheetRow: r.sheetRow,
      locationName: r.locationName,
      focusType: r.focusType,
    })),
  }
}

function isPrimary(importance: string | null): boolean {
  // Blank counts as Primary so an untiered row is never dropped.
  return !importance || /^primary$/i.test(importance.trim())
}

function isSecondary(importance: string | null): boolean {
  return !!importance && /^secondary$/i.test(importance.trim())
}
