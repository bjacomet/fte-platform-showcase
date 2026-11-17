/**
 * Fetch live brand tokens (colors, fonts, CSS variables) from a client's website.
 * Used by Brenda to perform on-brand compliance checks without needing a PDF.
 */

const FETCH_TIMEOUT_MS = 4000

async function fetchWithTimeout(url: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FTE-Brenda/1.0)' },
    })
    clearTimeout(timer)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

function extractCssTokens(css: string): { colors: string[]; fonts: string[]; vars: string[] } {
  const colors = new Set<string>()
  const fonts = new Set<string>()
  const vars = new Set<string>()

  // CSS custom properties (--color-*, --brand-*, --primary-*, --font-*)
  const varMatches = css.matchAll(/--(?:color|brand|primary|secondary|accent|font|text|bg|background)[^:]*:\s*([^;}\n]+)/gi)
  for (const m of varMatches) {
    const val = m[0].trim()
    if (val.length < 120) vars.add(val)
  }

  // Hex colors
  const hexMatches = css.matchAll(/#([0-9a-f]{3,8})\b/gi)
  for (const m of hexMatches) {
    if ([3, 6, 8].includes(m[1].length)) colors.add(m[0].toLowerCase())
  }

  // RGB/HSL colors
  const rgbMatches = css.matchAll(/(?:rgb|hsl)a?\([^)]+\)/gi)
  for (const m of rgbMatches) colors.add(m[0])

  // Font families
  const fontMatches = css.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)
  for (const m of fontMatches) {
    const val = m[1].trim().replace(/["']/g, '').split(',')[0].trim()
    if (val && val.length < 60 && !val.startsWith('var(')) fonts.add(val)
  }

  return {
    colors: [...colors].slice(0, 40),
    fonts: [...new Set([...fonts])].slice(0, 10),
    vars: [...vars].slice(0, 30),
  }
}

function findStylesheetUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = []
  const linkMatches = html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)
  for (const m of linkMatches) {
    try {
      urls.push(new URL(m[1], baseUrl).href)
    } catch { /* skip malformed */ }
  }
  // Also grab inline <style> blocks — return as a special marker
  return urls.slice(0, 3) // only first 3 stylesheets
}

function extractInlineStyles(html: string): string {
  const blocks: string[] = []
  const matches = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)
  for (const m of matches) blocks.push(m[1])
  return blocks.join('\n').slice(0, 20000)
}

/**
 * Fetch a client website and extract brand tokens.
 * Returns a human-readable summary for Brenda, or null if unreachable.
 */
export async function extractBrandFromWebsite(websiteUrl: string): Promise<string | null> {
  const html = await fetchWithTimeout(websiteUrl)
  if (!html) return null

  const stylesheetUrls = findStylesheetUrls(html, websiteUrl)
  const inlineCss = extractInlineStyles(html)

  // Fetch stylesheets concurrently
  const sheetTexts = await Promise.all(stylesheetUrls.map((u) => fetchWithTimeout(u)))
  const allCss = [inlineCss, ...sheetTexts.filter(Boolean)].join('\n')

  if (!allCss.trim()) return null

  const { colors, fonts, vars } = extractCssTokens(allCss)

  const lines: string[] = [`Brand tokens extracted from ${websiteUrl}:`]
  if (vars.length) lines.push(`\nCSS Variables:\n${vars.join('\n')}`)
  if (fonts.length) lines.push(`\nFont families in use: ${fonts.join(', ')}`)
  if (colors.length) lines.push(`\nColors found in stylesheet: ${colors.join(', ')}`)

  return lines.join('\n').slice(0, 8000) || null
}
