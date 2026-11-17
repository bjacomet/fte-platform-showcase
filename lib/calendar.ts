// Helpers for the Content Calendar feature.
// - Month math (prev/next, format, bounds)
// - SSR: build the public URL for a card_files.file_url path

import { POST_STYLE_MEDIA_TYPES } from '@/types'

export { POST_STYLE_MEDIA_TYPES }

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

export function formatMonth(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`
}

export function monthShortName(month: number): string {
  return MONTH_NAMES[month - 1].slice(0, 3)
}

export function prevMonth(year: number, month: number): { year: number; month: number } {
  if (month === 1) return { year: year - 1, month: 12 }
  return { year, month: month - 1 }
}

export function nextMonth(year: number, month: number): { year: number; month: number } {
  if (month === 12) return { year: year + 1, month: 1 }
  return { year, month: month + 1 }
}

/** Clamp a year-month to the current month if not provided or invalid. */
export function normalizeMonth(
  year: unknown,
  month: unknown
): { year: number; month: number } {
  const now = new Date()
  const y = Number.isFinite(Number(year)) ? Number(year) : now.getFullYear()
  const m = Number.isFinite(Number(month)) ? Number(month) : now.getMonth() + 1
  if (m < 1 || m > 12) {
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  }
  return { year: y, month: m }
}

/** Start and (exclusive) end ISO date strings for a year-month — use for SQL filters. */
export function monthBounds(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const next = nextMonth(year, month)
  const end = `${next.year}-${String(next.month).padStart(2, '0')}-01`
  return { start, end }
}

/** Format an ISO date (YYYY-MM-DD) for display. Returns "Tuesday, May 5" style. */
export function formatPostDate(iso: string | null): string {
  if (!iso) return ''
  // Parse as local-date-only to avoid timezone slippage
  const [y, m, d] = iso.split('T')[0].split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

// ── Grid view helpers ──────────────────────────────────────────────────────

export interface GridDay {
  /** YYYY-MM-DD string for the cell. */
  iso: string
  /** Day-of-month number (1-31). */
  day: number
  /** True when this date falls inside the displayed month. */
  inMonth: boolean
  /** True when this date is "today" in the viewer's locale. */
  isToday: boolean
}

/**
 * Build a 7-column x 6-row month grid for the given (year, month).
 * Grid always starts on Sunday and includes leading days from the previous
 * month + trailing days from the next month, so a render loop can just walk
 * the array. Always returns 42 cells.
 */
export function buildMonthGridDays(year: number, month: number): GridDay[] {
  const firstOfMonth = new Date(year, month - 1, 1)
  const startWeekday = firstOfMonth.getDay() // 0 (Sun) - 6 (Sat)
  const daysInMonth = new Date(year, month, 0).getDate()

  const today = new Date()
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const cells: GridDay[] = []
  // Leading days from prior month.
  const prevMonthDays = new Date(year, month - 1, 0).getDate()
  for (let i = startWeekday - 1; i >= 0; i--) {
    const d = prevMonthDays - i
    const pm = prevMonth(year, month)
    const iso = `${pm.year}-${String(pm.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({ iso, day: d, inMonth: false, isToday: iso === todayYmd })
  }
  // Current month.
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({ iso, day: d, inMonth: true, isToday: iso === todayYmd })
  }
  // Trailing days from next month to reach 42.
  const nm = nextMonth(year, month)
  let trailing = 1
  while (cells.length < 42) {
    const iso = `${nm.year}-${String(nm.month).padStart(2, '0')}-${String(trailing).padStart(2, '0')}`
    cells.push({ iso, day: trailing, inMonth: false, isToday: iso === todayYmd })
    trailing++
  }
  return cells
}

/**
 * Group cards by their flight_start_date (YYYY-MM-DD). Cards with no
 * flight_start_date are dropped — they shouldn't appear on the calendar.
 */
export function groupCardsByDay<T extends { flight_start_date: string | null }>(
  cards: T[]
): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const c of cards) {
    if (!c.flight_start_date) continue
    const iso = c.flight_start_date.split('T')[0]
    if (!out[iso]) out[iso] = []
    out[iso].push(c)
  }
  return out
}

/** Format ISO date as a short weekday name ("Tue"). */
export function formatDayOfWeekShort(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('T')[0].split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' })
}

/** Format ISO date as "Apr 15". */
export function formatMonthDayShort(iso: string | null): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('T')[0].split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}
