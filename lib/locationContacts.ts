// Atlas location contacts → a sheet of review links to hand the team.
//
// The team keeps an "Ad Approval Recipient" sheet (Location | Name | Email, one
// row per contact, usually 2+ per location). It is uploaded once from the
// Location links panel and stored in app_settings under CONTACTS_KEY. After a
// campaign is split, "Download sheet" returns the same rows with each location's
// review link added, so nobody hunts for which link goes to whom. the designer's
// call: no email sending from the platform — they download it and send it on.

export const CONTACTS_KEY = 'atlas_location_contacts'

export type LocationContact = { location: string; name: string; email: string }
export type StoredContacts = { fileName: string; uploadedAt: string; rows: LocationContact[] }

/**
 * Normalise a location name so the sheet and the app agree. They differ in
 * predictable ways — as seen in practice:
 *   "Atlas - MetroCare North (Northside)"                 ↔ "MetroCare: North"
 *   "Atlas - Desert Radiation Oncology (Southtown)" ↔ "Desert Valley Radiation Oncology"
 *   "Atlas - Westside Cancer Center"           ↔ "Westside Cancer Centers"
 *   "Atlas - ScanCo Imaging of Metro (Ridgeview)"      ↔ "ScanCo Imaging of Metro-Northeast (Ridgeview)"
 * so: drop the "Atlas -" prefix and anything in brackets, & → and, punctuation to
 * spaces, and a trailing plural "s" on each word.
 */
export function normalizeLocation(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*atlas\s*[-–—:]\s*/, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ')
}

/**
 * Find the one app location a sheet name refers to. Exact normalised match
 * first; otherwise one name must start with the other on a word boundary
 * ("lakeside" ↔ "lakeside radiation oncology center",
 * "scanco metro northeast" ↔ "scanco metro"). If that prefix
 * rule fits more than one location the answer is null — a wrong link sent to a
 * practice is worse than a row flagged for a human to fix.
 */
export function matchLocation<L extends { name: string }>(sheetName: string, locations: L[]): L | null {
  const s = normalizeLocation(sheetName)
  if (!s) return null
  const exact = locations.filter((l) => normalizeLocation(l.name) === s)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null
  const prefix = locations.filter((l) => {
    const a = normalizeLocation(l.name)
    return (a.startsWith(s + ' ') || s.startsWith(a + ' '))
  })
  return prefix.length === 1 ? prefix[0] : null
}

/** Read Location / Name / Email columns from a parsed sheet (array of rows). Header row found by name. */
export function contactsFromRows(rows: unknown[][]): LocationContact[] {
  const cell = (v: unknown) => (v == null ? '' : String(v).trim())
  const headerIdx = rows.findIndex((r) => r.some((c) => cell(c).toLowerCase() === 'location'))
  if (headerIdx === -1) throw new Error('No "Location" column found — the sheet needs Location, Name and Email headers.')
  const header = rows[headerIdx].map((c) => cell(c).toLowerCase())
  const li = header.indexOf('location')
  const ni = header.indexOf('name')
  const ei = header.indexOf('email')
  if (ni === -1 || ei === -1) throw new Error('The sheet needs Name and Email columns next to Location.')
  // "N/A" means the practice has no contact yet; keep the row so the location
  // still gets its link in the download, just with the contact cells blank.
  const na = (v: string) => (/^n\/?a$/i.test(v) ? '' : v)
  return rows
    .slice(headerIdx + 1)
    .map((r) => ({ location: cell(r[li]), name: na(cell(r[ni])), email: na(cell(r[ei])) }))
    .filter((r) => r.location)
}

type ScopeForSheet = { token: string; atlas_location?: { name: string } | null }

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * One row per contact with that location's review link; then one row for every
 * location that has a link but no contact, so no link is left out of the sheet.
 * Rows that match no linked location are kept and say so — a contact silently
 * dropped is a practice that never gets asked.
 */
export function buildContactsCsv(contacts: LocationContact[], scopes: ScopeForSheet[], baseUrl: string): string {
  const linked = scopes
    .filter((s) => s.atlas_location?.name)
    .map((s) => ({ name: s.atlas_location!.name, url: `${baseUrl}/adviewer/c/${s.token}` }))
  const used = new Set<string>()
  const lines = [['Location', 'Name', 'Email', 'Review Link']]
  for (const c of contacts) {
    const hit = matchLocation(c.location, linked)
    if (hit) used.add(hit.name)
    lines.push([c.location, c.name, c.email, hit ? hit.url : 'No link — location not in this campaign or name not recognised'])
  }
  for (const l of linked) if (!used.has(l.name)) lines.push([l.name.replace(/^Atlas\s*-\s*/, ''), '', '', l.url])
  // Leading BOM so Excel opens it as UTF-8 (the em dash and accented names survive).
  return '\uFEFF' + lines.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
