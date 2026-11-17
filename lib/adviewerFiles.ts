// Which of a board card's files the client sees in Adviewer.
//
// A card's Files tab holds two kinds of file: the finished creatives the team
// built, and the source material they were built from (client photos, logos,
// screenshots). Only the first belongs in front of a client. The team already
// names every finished creative to one convention — client prefix, optional
// location, then the month token:
//
//   EXU-M10-Campus-Band-1080x1080.png
//   PLC-M5-CTVBase2.mp3
//   DPS-Northside-M8-Ag-300x600.gif
//   Sample-M8_-xplorer-300x600.gif
//
// so the month token "M<1–2 digits>" after a short prefix is the rule. It is not
// keyed to clients.abbreviation on purpose: file prefixes often carry a location
// ("DPS-Northside") or differ from the stored abbreviation, and 6 clients have no
// abbreviation at all — matching on it would have hidden real creatives.
// Measured against prod 2026-10-05 (last 120 days, live cards): 125/125 display
// files and 122/133 social files match; the 11 social misses are logos, photos
// and screenshots.
//
// The month token may also end the name ("EXU-M10.png"): without that, one size
// saved with no dash after the month was silently hidden while its siblings
// showed, and the client could approve without ever seeing it.
const CREATIVE_NAME_RE = /^[A-Za-z0-9&]+(?:[-_ ][A-Za-z0-9&]+){0,3}[-_ ]M\d{1,2}(?:[-_ ]|\.[A-Za-z0-9]+$)/i

export function isCreativeFileName(name: string | null | undefined): boolean {
  return !!name && CREATIVE_NAME_RE.test(name)
}

// A file that LOOKS like a finished size — dimensions in the name, or an HTML5 /
// GIF build — but isn't named to the convention. On a card where other files are
// named, the rule above hides it from the client, so the board warns about it.
const SIZE_RE = /(?<!\d)\d{2,4}\s*[x×]\s*\d{2,4}(?!\d)/i

export function looksLikeMisnamedCreative(name: string | null | undefined, type: string | null | undefined): boolean {
  if (!name || isCreativeFileName(name)) return false
  return SIZE_RE.test(name) || type === 'text/html' || type === 'image/gif'
}

const SINGLE_SOCIAL = new Set(['Social Ad Request', 'Organic Post', 'Reel Request'])

type ReviewFile = { file_name: string; file_url: string; file_type: string | null; created_at?: string }

/**
 * The files Adviewer shows for one card.
 *
 * 1. Keep only files named to the creative convention.
 * 2. If none are, keep everything — a misnamed upload must never leave a client
 *    looking at an empty card. The board's Files tab flags unnamed files, so the
 *    fix is a rename, not a support ticket.
 * 3. A single-social card is one creative, so narrow to one file: the one
 *    cards.preview_image_url points at, else the newest image/video. Otherwise
 *    2+ files would be reviewed as separate "sizes" (the Example University bug).
 */
export function clientFacingFiles<F extends ReviewFile>(
  files: F[],
  mediaType: string | null | undefined,
  previewUrl: string | null | undefined,
): F[] {
  const named = files.filter((f) => isCreativeFileName(f.file_name))
  const pool = named.length > 0 ? named : files
  if (!SINGLE_SOCIAL.has(mediaType ?? '') || pool.length <= 1) return pool

  // file_url is a bare in-bucket path on new rows and a full URL on old ones;
  // preview_image_url is always the full public URL ending in that path.
  const match = previewUrl
    ? pool.find((f) => f.file_url && previewUrl.endsWith(f.file_url.replace(/^.*\/creative-files\//, '')))
    : undefined
  if (match) return [match]
  const media = pool.filter((f) => f.file_type?.startsWith('image/') || f.file_type?.startsWith('video/'))
  const newest = [...(media.length ? media : pool)].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0]
  return newest ? [newest] : pool
}
