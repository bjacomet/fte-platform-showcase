export interface QuarterOption {
  key: string
  label: string
  year: number
  quarter: string
}

export const ALL_QUARTERS = 'all'

export function quarterKey(quarter: string, year: number): string {
  return `${year}-${quarter}`
}

// Every quarter that has at least one card, newest first. Cards with no quarter
// contribute nothing here — they show only under "All quarters".
export function quarterOptions(
  cards: { atlas_quarter?: string | null; atlas_year?: number | null }[],
): QuarterOption[] {
  const seen = new Map<string, QuarterOption>()
  for (const c of cards) {
    if (!c.atlas_quarter || !c.atlas_year) continue
    const key = quarterKey(c.atlas_quarter, c.atlas_year)
    if (!seen.has(key)) seen.set(key, { key, label: `${c.atlas_quarter} ${c.atlas_year}`, year: c.atlas_year, quarter: c.atlas_quarter })
  }
  return [...seen.values()].sort((a, b) => b.year - a.year || b.quarter.localeCompare(a.quarter))
}

// The stored choice wins when it still names a quarter that has cards; otherwise
// default to the newest quarter, or to everything when no card has a quarter yet.
export function effectiveQuarter(stored: string | null, options: QuarterOption[]): string {
  if (stored === ALL_QUARTERS) return ALL_QUARTERS
  if (stored && options.some((o) => o.key === stored)) return stored
  return options[0]?.key ?? ALL_QUARTERS
}

export function filterByQuarter<T extends { atlas_quarter?: string | null; atlas_year?: number | null }>(
  cards: T[],
  quarter: string,
): T[] {
  if (quarter === ALL_QUARTERS) return cards
  return cards.filter((c) => !!c.atlas_quarter && !!c.atlas_year && quarterKey(c.atlas_quarter, c.atlas_year) === quarter)
}
