// Parsing logic for the /calendar/import paste-to-rows flow.
//
// Three input shapes are supported, picked automatically based on what the
// clipboard contains:
//
//   1. HTML clipboard (Word, Google Docs, Claude, any browser-rendered table).
//      We extract <tr>/<td> cells directly. Highest fidelity — preserves the
//      original column structure even when the plain-text fallback wouldn't.
//
//   2. Tab-delimited plain text (the format Word/Docs tables fall back to
//      when pasted into a textarea without HTML). One row per line, columns
//      split on \t.
//
//   3. No-delimiter stream — the worst case, where a table got flattened
//      into one long string with no separators between cells. We anchor on
//      date patterns (m/d/yyyy) and creative-cell prefixes
//      (Graphic / Image / Photo / Video) and recover the row structure by
//      walking between the anchors.

import type { PostStyleMediaType } from '@/types'
import { monthShortName } from '@/lib/calendar'

export interface ImportRow {
  id: string
  /** YYYY-MM-DD or null when the date couldn't be parsed. */
  isoDate: string | null
  /** Original date string as pasted (e.g. "7/1/2026 8:00", "Jul 1"). */
  dateInput: string
  copy: string
  creative: string
  mediaType: PostStyleMediaType
  /** Blocking error if isoDate is null, otherwise an optional warning. */
  error: string | null
}

export type ParseSource = 'html' | 'tab' | 'stream' | 'empty'

export interface ParseResult {
  rows: ImportRow[]
  source: ParseSource
}

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

// Words like "Graphic:", "Image:", "Photo:", "Video:", "Reel:" — used both
// for splitting a no-delimiter stream and for suggesting media type.
const CREATIVE_PREFIX_RE = /\b(Graphic|Image|Photo|Video|Reel|Carousel|Eblast)\s*:/gi

// "7/1/2026", "07/1/2026 8:00", "7/1/2026 17:30" — used as the row anchor
// when the stream has no delimiters.
const DATE_ANCHOR_RE = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2})?/g

let rowIdCounter = 0
function nextId(): string {
  rowIdCounter += 1
  return `row-${rowIdCounter}`
}

function looksLikeHeaderRow(cells: string[]): boolean {
  const joined = cells.join(' ').toLowerCase()
  return /\bpost\s*date\b/.test(joined) || (joined.includes('copy') && joined.includes('creative'))
}

function suggestMediaType(creative: string): PostStyleMediaType {
  const lower = creative.toLowerCase()
  if (lower.startsWith('video') || lower.startsWith('reel')) return 'Reel Request'
  if (lower.startsWith('carousel')) return 'Carousel Ad'
  if (lower.startsWith('eblast')) return 'Eblast'
  if (lower.startsWith('graphic') || lower.startsWith('image') || lower.startsWith('photo')) {
    return 'Social Ad Request'
  }
  return 'Organic Post'
}

function parseDate(
  input: string,
  selectedYear: number,
  selectedMonth: number
): { isoDate: string | null; error: string | null } {
  const s = input.trim()
  if (!s) return { isoDate: null, error: 'Missing date' }

  let day: number | null = null
  let month: number | null = null
  let year: number = selectedYear

  // "Jun 3", "June 3", "Jul. 4"
  const monthDayMatch = s.match(/^([A-Za-z]+)[\s.\-]+(\d{1,2})(?:,?\s*(\d{4}))?/)
  if (monthDayMatch) {
    month = MONTH_MAP[monthDayMatch[1].toLowerCase()] ?? null
    day = Number(monthDayMatch[2])
    if (monthDayMatch[3]) year = Number(monthDayMatch[3])
    if (!month) return { isoDate: null, error: `Unknown month "${monthDayMatch[1]}"` }
  } else {
    // "7/1/2026", "7/1", "07/01/2026 8:00"
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/)
    if (slashMatch) {
      month = Number(slashMatch[1])
      day = Number(slashMatch[2])
      if (slashMatch[3]) {
        const y = Number(slashMatch[3])
        year = y < 100 ? 2000 + y : y
      }
    } else {
      // Bare day number "3" — assume the selected month
      const dayOnlyMatch = s.match(/^(\d{1,2})$/)
      if (dayOnlyMatch) {
        day = Number(dayOnlyMatch[1])
        month = selectedMonth
      }
    }
  }

  if (!day || !month) return { isoDate: null, error: `Could not parse "${input}"` }
  if (day < 1 || day > 31) return { isoDate: null, error: `Day ${day} out of range` }
  if (month < 1 || month > 12) return { isoDate: null, error: `Month ${month} out of range` }

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const warn =
    month !== selectedMonth
      ? `${monthShortName(month)} ${day} is outside the selected month (${monthShortName(selectedMonth)}) — still importing as-is`
      : null
  return { isoDate: iso, error: warn }
}

function makeRow(
  dateText: string,
  copy: string,
  creative: string,
  year: number,
  month: number
): ImportRow {
  const { isoDate, error } = parseDate(dateText, year, month)
  return {
    id: nextId(),
    isoDate,
    dateInput: dateText.trim(),
    copy: copy.trim(),
    creative: creative.trim(),
    mediaType: suggestMediaType(creative.trim()),
    error,
  }
}

// ── HTML clipboard path ────────────────────────────────────────────────────

function parseHtmlTable(html: string, year: number, month: number): ImportRow[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const trs = doc.querySelectorAll('tr')
  const rows: ImportRow[] = []
  trs.forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('td, th')).map(
      (c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
    if (cells.length < 3) return
    if (looksLikeHeaderRow(cells)) return
    if (!cells[0]) return
    rows.push(makeRow(cells[0], cells[1] ?? '', cells[2] ?? '', year, month))
  })
  return rows
}

// ── Tab-delimited plain-text path ──────────────────────────────────────────

function parseTabDelimited(text: string, year: number, month: number): ImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/ /g, ' ').trim())
    .filter((l) => l.length > 0)

  const rows: ImportRow[] = []
  for (const line of lines) {
    const cells = line.split('\t').map((c) => c.trim())
    if (cells.length < 3) continue
    if (looksLikeHeaderRow(cells)) continue
    if (!cells[0]) continue
    rows.push(makeRow(cells[0], cells[1], cells[2], year, month))
  }
  return rows
}

// ── No-delimiter stream path ───────────────────────────────────────────────
//
// Handles the worst case: a table that got copied into a context that
// dropped every \t and \n, producing one continuous string like
// "7/1/2026 8:00Summer road trips…Graphic: family driving7/4/2026 9:00…".
// We recover rows by:
//   1. Finding every date-anchor match (start indices).
//   2. For each anchor, the row content is text[anchor.end .. nextAnchor.start].
//   3. Inside that content, the first CREATIVE_PREFIX match splits copy
//      from creative. Text before the prefix = copy, text from the prefix
//      to the end = creative.

function parseNoDelimiterStream(text: string, year: number, month: number): ImportRow[] {
  const cleaned = text.replace(/ /g, ' ').trim()
  if (!cleaned) return []

  // Reset the regex state and collect all date matches.
  const dateMatches: Array<{ start: number; end: number; full: string }> = []
  DATE_ANCHOR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DATE_ANCHOR_RE.exec(cleaned)) !== null) {
    dateMatches.push({ start: m.index, end: m.index + m[0].length, full: m[0] })
  }
  if (dateMatches.length === 0) return []

  const rows: ImportRow[] = []
  for (let i = 0; i < dateMatches.length; i++) {
    const a = dateMatches[i]
    const next = dateMatches[i + 1]
    const segment = cleaned.slice(a.end, next ? next.start : cleaned.length).trim()

    // Find the first creative prefix inside the segment.
    CREATIVE_PREFIX_RE.lastIndex = 0
    const prefixMatch = CREATIVE_PREFIX_RE.exec(segment)
    let copy = segment
    let creative = ''
    if (prefixMatch) {
      copy = segment.slice(0, prefixMatch.index).trim()
      creative = segment.slice(prefixMatch.index).trim()
    }

    // Strip the "h:mm" trailing time from the date string if present.
    const dateOnly = a.full.replace(/\s+\d{1,2}:\d{2}\s*$/, '').trim()
    rows.push(makeRow(dateOnly, copy, creative, year, month))
  }
  return rows
}

// ── Public entry point ─────────────────────────────────────────────────────

export function parseClipboardEvent(
  event: ClipboardEvent,
  year: number,
  month: number
): ParseResult {
  const data = event.clipboardData
  if (!data) return { rows: [], source: 'empty' }

  const html = data.getData('text/html')
  if (html && /<t(?:able|r|d|h)\b/i.test(html)) {
    const rows = parseHtmlTable(html, year, month)
    if (rows.length > 0) return { rows, source: 'html' }
  }

  const text = data.getData('text/plain')
  if (!text.trim()) return { rows: [], source: 'empty' }

  if (text.includes('\t')) {
    const rows = parseTabDelimited(text, year, month)
    if (rows.length > 0) return { rows, source: 'tab' }
  }

  // Last-resort: no delimiters at all.
  return { rows: parseNoDelimiterStream(text, year, month), source: 'stream' }
}

// Exposed so the ImportPage can wipe IDs when starting a fresh paste, to
// keep React keys monotonic and avoid collisions across pastes.
export function freshRowId(): string {
  return nextId()
}
