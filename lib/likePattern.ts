/**
 * Escape user or model text for a Postgres LIKE / ILIKE pattern, so `%` and `_`
 * match themselves instead of acting as wildcards ("50% off" must not match
 * every title that has "50" in it). Pair with `contains()` for partial matches.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** ILIKE pattern for "contains this text", with the text escaped. */
export function contains(text: string): string {
  return `%${escapeLike(text)}%`
}
