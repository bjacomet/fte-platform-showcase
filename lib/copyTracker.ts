// Builds a clipboard payload formatted for pasting into the Copy Tracker Google Sheet.
// Google Sheets parses pasted HTML as a table, so a 1-column / 2-row <table> lands as
// two stacked cells: cell 1 = creative name (linked to Adviewer) + landing page link(s)
// on their own lines; cell 2 (row below) = the flight end date in red.

import { withHttpsScheme } from './url'

export interface CopyTrackerEntry {
  /** Display label for the creative. Callers should pass creative_name, falling back to title. */
  creativeName: string
  /** Card-level Adviewer campaign URL the creative name links to (preferred link target). */
  adviewerUrl: string | null
  /** Fallback link (the card's /card/[id] page) used when there's no Adviewer URL. */
  cardUrl: string | null
  /** Landing page URL(s) — one line per URL inside the first cell (per-slide for carousels). */
  landingPages: string[]
  /** Raw flight end date as stored (YYYY-MM-DD). Rendered M/D/YYYY in red. */
  endDate: string | null
}

/** Extract the campaign token from an Adviewer URL (`/adviewer/c/{token}`). */
export function tokenFromAdviewerUrl(url: string | null | undefined): string | null {
  const m = url?.match(/\/adviewer\/c\/([0-9a-fA-F-]+)/)
  return m ? m[1] : null
}

/**
 * Deep-link a campaign-level Adviewer URL to one creative via `?only={campaignCardId}` so it
 * opens that exact creative instead of the campaign's first item. Returns the campaign URL
 * unchanged when there's no campaign-card id.
 */
export function adviewerDeepLink(campaignUrl: string | null, campaignCardId: string | null | undefined): string | null {
  if (!campaignUrl) return null
  return campaignCardId ? `${campaignUrl}?only=${campaignCardId}` : campaignUrl
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Parse a stored YYYY-MM-DD directly into M/D/YYYY. Avoids `new Date(str)`, which reads a
// bare date as UTC midnight and can shift a day when formatted in a negative-offset timezone.
function formatEndDate(raw: string | null): string | null {
  if (!raw) return null
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return raw
  const [, y, mo, d] = m
  return `${Number(mo)}/${Number(d)}/${y}`
}

/**
 * Turn a creative file name into the Copy Tracker label: drop the extension and the trailing
 * dimension token. e.g. "RFL-M7-Maverick-300x600.gif" -> "RFL-M7-Maverick".
 */
export function creativeLabelFromFileName(fileName: string): string {
  const noExt = fileName.replace(/\.[^./\\]+$/, '')
  return noExt.replace(/[-_]\d{2,4}\s*[xX×]\s*\d{2,4}$/, '')
}

/**
 * True when a file name carries a trailing WxH dimension token before its extension
 * (e.g. "…-1080x1080.png"). Under the ABBR-M#-Name-WxH.ext naming convention this marks a
 * real deliverable creative — as opposed to a supporting asset like "FullUFORCELineup.jpg".
 */
export function hasDimensionToken(fileName: string): boolean {
  return /[-_]\d{2,4}\s*[xX×]\s*\d{2,4}\.[^./\\]+$/.test(fileName)
}

/**
 * Choose the primary creative file name from a set. Prefers a file whose name carries a WxH
 * dimension token (the real deliverable), otherwise the first named file. Returns null when
 * there are no named files. Order-independent for the WxH case, so callers don't have to
 * guarantee a particular row order.
 */
export function pickCreativeFileName(
  files: Array<{ file_name: string | null }> | null | undefined,
): string | null {
  const named = (files ?? [])
    .map((f) => f.file_name?.trim())
    .filter((n): n is string => !!n)
  return named.find(hasDimensionToken) ?? named[0] ?? null
}

/**
 * The creative-name label for a card: the primary creative file name with the dimensions
 * stripped (preferring a WxH-tokened deliverable over a supporting asset), falling back to
 * `creative_name` then the card `title` when there are no files.
 */
export function resolveCreativeName(
  files: Array<{ file_name: string | null }> | null | undefined,
  creativeName: string | null | undefined,
  title: string,
): string {
  const primary = pickCreativeFileName(files)
  if (primary) return creativeLabelFromFileName(primary)
  return creativeName?.trim() || title
}

/**
 * Resolve the landing page line(s). Carousels list each slide's landing page (deduped, in
 * order); everything else uses the single card-level landing page.
 */
export function collectLandingPages(
  cardLandingUrl: string | null,
  slides?: Array<{ landing_page_url: string | null }> | null,
): string[] {
  const fromSlides = (slides ?? [])
    .map((s) => s.landing_page_url?.trim())
    .filter((u): u is string => !!u)
  if (fromSlides.length > 0) return Array.from(new Set(fromSlides))
  const single = cardLandingUrl?.trim()
  return single ? [single] : []
}

// Inner HTML of the "name + landing page(s)" cell (creative name link on the first line,
// each landing page link on its own line below).
function cell1InnerHtml(entry: CopyTrackerEntry): string {
  const link = entry.adviewerUrl ?? entry.cardUrl
  const name = esc(entry.creativeName || 'Untitled')
  const nameCell = link ? `<a href="${esc(link)}">${name}</a>` : name
  const landingLines = entry.landingPages
    .filter(Boolean)
    // Landing pages are often stored without a scheme; Sheets would resolve a bare
    // "campus.example.edu/visit" href against the app's origin. The visible text stays as typed.
    .map((u) => `<a href="${esc(withHttpsScheme(u))}">${esc(u)}</a>`)
  return [nameCell, ...landingLines].join('<br>')
}

function endDateCellHtml(entry: CopyTrackerEntry): string {
  const endDate = formatEndDate(entry.endDate)
  return `<td style="color:#ff0000">${endDate ? esc(endDate) : ''}</td>`
}

export function buildCopyTrackerHtml(entry: CopyTrackerEntry): string {
  return (
    '<table><tbody>' +
    `<tr><td>${cell1InnerHtml(entry)}</td></tr>` +
    `<tr>${endDateCellHtml(entry)}</tr>` +
    '</tbody></table>'
  )
}

// Multi-card: one card per column. Row 1 = name + landing page(s), row 2 = end date (red).
export function buildCopyTrackerHtmlMulti(entries: CopyTrackerEntry[]): string {
  const row1 = entries.map((e) => `<td>${cell1InnerHtml(e)}</td>`).join('')
  const row2 = entries.map((e) => endDateCellHtml(e)).join('')
  return `<table><tbody><tr>${row1}</tr><tr>${row2}</tr></tbody></table>`
}

export function buildCopyTrackerText(entry: CopyTrackerEntry): string {
  const lines: string[] = []
  const link = entry.adviewerUrl ?? entry.cardUrl
  const name = entry.creativeName || 'Untitled'
  lines.push(link ? `${name} (${link})` : name)
  for (const u of entry.landingPages.filter(Boolean)) lines.push(u)
  const endDate = formatEndDate(entry.endDate)
  if (endDate) lines.push(endDate)
  return lines.join('\n')
}

export function buildCopyTrackerTextMulti(entries: CopyTrackerEntry[]): string {
  return entries.map((e) => buildCopyTrackerText(e)).join('\n\n')
}

/**
 * Write the Copy Tracker payload to the clipboard as both rich HTML (what Sheets pastes) and
 * a plain-text fallback. Returns true on success.
 */
async function writeToClipboard(html: string, text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ])
      return true
    }
  } catch {
    // Rich write unsupported or blocked — fall back to plain text below.
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function copyForCopyTracker(entry: CopyTrackerEntry): Promise<boolean> {
  return writeToClipboard(buildCopyTrackerHtml(entry), buildCopyTrackerText(entry))
}

/** Copy several cards at once — one card per Google Sheet column. */
export function copyForCopyTrackerMulti(entries: CopyTrackerEntry[]): Promise<boolean> {
  return writeToClipboard(buildCopyTrackerHtmlMulti(entries), buildCopyTrackerTextMulti(entries))
}

/**
 * Copy several cards when the data must be fetched first. The clipboard write is issued
 * synchronously with Promise-valued blobs so the browser's transient user activation from
 * the click isn't lost across the fetch's await (which would block `clipboard.write`).
 * Call this directly in the click handler — do NOT await anything before it.
 */
/** Single-card variant of the deferred copy — use when the entry needs a fetch first. */
export function copyForCopyTrackerDeferred(entryPromise: Promise<CopyTrackerEntry>): Promise<boolean> {
  return copyForCopyTrackerMultiDeferred(entryPromise.then((e) => [e]))
}

export function copyForCopyTrackerMultiDeferred(entriesPromise: Promise<CopyTrackerEntry[]>): Promise<boolean> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const html = entriesPromise.then((e) => new Blob([buildCopyTrackerHtmlMulti(e)], { type: 'text/html' }))
    const text = entriesPromise.then((e) => new Blob([buildCopyTrackerTextMulti(e)], { type: 'text/plain' }))
    return navigator.clipboard
      .write([new ClipboardItem({ 'text/html': html, 'text/plain': text })])
      .then(() => true)
      .catch(() =>
        // Rich write blocked — fall back to plain text once entries resolve.
        entriesPromise
          .then((e) => navigator.clipboard.writeText(buildCopyTrackerTextMulti(e)))
          .then(() => true)
          .catch(() => false),
      )
  }
  return entriesPromise
    .then((e) => navigator.clipboard.writeText(buildCopyTrackerTextMulti(e)))
    .then(() => true)
    .catch(() => false)
}
