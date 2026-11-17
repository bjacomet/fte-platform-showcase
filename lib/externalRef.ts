// Showcase build: links to working materials (Google Sheets/Docs/Drive, Box) are
// never rendered as clickable links. They are shown as an anonymized reference
// that says what kind of thing they point to, e.g. "Box folder · display build".

export type ExternalRefKind =
  | 'Google Sheet'
  | 'Google Doc'
  | 'Google Slides'
  | 'Google Form'
  | 'Google Drive folder'
  | 'Google Drive file'
  | 'Box folder'
  | 'Box file'
  | 'Box shared link'
  | 'Box Drive file'

/** The kind of working material a URL points to, or null when it isn't one. */
export function externalRefKind(url: string | null | undefined): ExternalRefKind | null {
  const raw = (url ?? '').trim()
  if (!raw) return null
  if (/^boxapp:\/\//i.test(raw)) return 'Box Drive file'

  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const path = u.pathname.toLowerCase()

  if (host === 'docs.google.com' || host === 'sheets.google.com') {
    if (path.startsWith('/spreadsheets')) return 'Google Sheet'
    if (path.startsWith('/document')) return 'Google Doc'
    if (path.startsWith('/presentation')) return 'Google Slides'
    if (path.startsWith('/forms')) return 'Google Form'
    return 'Google Drive file'
  }
  if (host === 'drive.google.com') {
    return path.includes('/folders/') ? 'Google Drive folder' : 'Google Drive file'
  }
  if (host === 'box.com' || host.endsWith('.box.com')) {
    if (path.startsWith('/folder/')) return 'Box folder'
    if (path.startsWith('/file/')) return 'Box file'
    return 'Box shared link'
  }
  return null
}

/** "Box folder · display build". Falls back to "External file" for a non-URL. */
export function externalRefLabel(
  url: string | null | undefined,
  note?: string,
  kind?: ExternalRefKind,
): string {
  const k = kind ?? externalRefKind(url) ?? 'External file'
  return note ? `${k} · ${note}` : k
}
