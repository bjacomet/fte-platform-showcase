// Landing page URLs are stored exactly as typed, and people often type them without a
// scheme ("campus.example.edu/visit"). Used as an href, a schemeless URL is resolved relative to
// the current page (or, when pasted into Google Sheets, relative to the app's origin) —
// e.g. https://your-app.vercel.app/campus.example.edu/visit. Normalize at render time only;
// stored card data is never rewritten.

// An explicit absolute scheme ("https://", "http://", "ftp://") or a scheme that has no
// "//" by design (mailto:, tel:, sms:). Anything else — including "host:port/path" — is
// treated as schemeless.
const HAS_SCHEME_RE = /^([a-z][a-z0-9+.-]*:\/\/|(mailto|tel|sms):)/i

/**
 * Return `url` with `https://` prepended when it has no scheme. Trims whitespace; returns
 * '' for empty input. Protocol-relative URLs ("//host/path") become "https://host/path".
 * Root-relative paths and fragments ("/x", "#x") are left as-is.
 */
export function withHttpsScheme(url: string | null | undefined): string {
  const trimmed = (url ?? '').trim()
  if (!trimmed) return ''
  if (HAS_SCHEME_RE.test(trimmed)) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed
  return `https://${trimmed}`
}

/** Hostname of a (possibly schemeless) URL without a leading "www.", or '' if unparseable. */
export function landingHostname(url: string | null | undefined): string {
  const normalized = withHttpsScheme(url)
  if (!normalized) return ''
  try {
    return new URL(normalized).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
