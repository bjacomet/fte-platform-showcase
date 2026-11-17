/**
 * Shared media-kind detection.
 *
 * This lived as byte-identical private copies in CampaignPreviewClient.tsx and
 * InstantExperienceMockup.tsx. The Atlas board needed a third, which is the point
 * at which a duplicated predicate becomes a bug waiting to happen: add 'avi' in
 * one place and video silently renders as a broken image in the others.
 */
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'm4v']

export function isVideoUrl(url: string): boolean {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTENSIONS.includes(ext)
}

/**
 * Appends the `#t=0.1` media fragment that makes a browser paint a video's
 * frame at 0.1s instead of an empty black box, plus an optional cache-buster.
 *
 * The fragment MUST come after the query string or it does not parse — this is
 * the detail that made every Atlas September tile render blank before #89 fixed
 * it in the Adviewer gallery.
 */
export function videoStillSrc(url: string, cacheKey?: string | number, seconds = 0.1): string {
  const busted = cacheKey === undefined
    ? url
    : `${url}${url.includes('?') ? '&' : '?'}r=${cacheKey}`
  return `${busted}#t=${seconds}`
}

/**
 * Where to seek for a thumbnail of an animated ad.
 *
 * 0.1s — the right answer for a generic video, and what the Adviewer gallery
 * uses — lands on frame one, which for these creatives is the opening wipe of
 * the animation: a half-drawn diagonal or a blank brand panel. It reads as a
 * broken render rather than an ad. 1.5s is past the build-on for every Atlas
 * creative checked and lands on the composed frame. Browsers clamp a seek past
 * the end, so a shorter clip falls back to its last frame rather than failing.
 */
export const AD_STILL_SECONDS = 1.5

/**
 * Turns a stored file reference into something a browser can actually fetch.
 *
 * card_files.file_url and friends hold a BUCKET-RELATIVE path for anything
 * written by Box sync (e.g. "cards/<id>/box_sync_….mp4"), not an absolute URL.
 * Dropped into a src attribute as-is, the browser resolves it against the app's
 * own origin and silently requests a file that does not exist there — no error
 * event, just a video element stuck at readyState 0 and an empty box.
 *
 * Existed as three byte-identical private copies (PreviewClient,
 * CampaignPreviewClient, LookbookClient); the Atlas board needed a fourth, and
 * not having it is exactly what made every Atlas thumbnail render blank.
 */
const STORAGE_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/creative-files/`

export function resolveFileUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (url.startsWith('http')) return url
  return STORAGE_BASE + url
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']

export function isImageUrl(url: string): boolean {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.includes(ext)
}

/** A file row is renderable as a thumbnail if it is an image or a video. */
export function isRenderableUrl(url: string): boolean {
  return isImageUrl(url) || isVideoUrl(url)
}

export interface ThumbCandidate {
  file_url: string | null
  file_type?: string | null
  created_at?: string | null
}

/**
 * Pick which attached file a surface should draw as the thumbnail.
 *
 * `files[0]` is the wrong answer twice over. PostgREST gives no ordering
 * guarantee on an embedded resource, so `[0]` is non-deterministic ACROSS
 * RELOADS — the same card can show a different file each time. And uploads are
 * unfiltered, so a card carrying a spec sheet, a ZIP of banner sizes or a PDF
 * alongside its MP4 can land on the ZIP, which renders as a broken-image icon.
 * Prod has exactly this: six application/zip rows on one card.
 *
 * So: keep only rows a browser can actually paint, prefer the MIME type over
 * the extension when the row has one, and order by created_at so the answer is
 * stable. Returns null when nothing is renderable, which callers show as the
 * honest "no file yet" state rather than a broken image.
 */
export function pickThumbFile<T extends ThumbCandidate>(files: readonly T[] | null | undefined): T | null {
  const renderable = (files ?? []).filter((f) => {
    if (!f.file_url) return false
    const type = f.file_type?.toLowerCase() ?? ''
    if (type.startsWith('image/') || type.startsWith('video/')) return true
    // No usable MIME type recorded — fall back to the extension. Anything we
    // cannot positively identify is excluded, not included: a broken image is
    // worse than an honest placeholder.
    if (type && !type.startsWith('application/octet-stream')) return isRenderableUrl(f.file_url)
    return isRenderableUrl(f.file_url)
  })
  if (renderable.length === 0) return null
  return [...renderable].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))[0]
}
