/**
 * Focus-name helpers shared by the Atlas Box sync and the Atlas copy sync.
 *
 * Kept in their own module because they are pure string work with no imports:
 * `lib/atlasBoxSync.ts` reaches Box and therefore `lib/supabase/server` and
 * `next/headers`, so a client component importing these from there would drag a
 * server-only module into the browser bundle.
 */

/**
 * Known misspellings, folded so both spellings produce the same key.
 *
 * Unlike ATLAS_FOCUS_ALIASES (which maps a Box name TO a card name, and so has a
 * direction), these are pure equivalences: the same focus written two ways. A
 * directional alias would break the moment the typo is corrected on one side,
 * because the mapping would then point away from the name both sides use.
 *
 * `gynocologic` — the Copy Plan sheet spells it with an o. Whether Box
 * matches it or uses the correct `gynecologic` varies by folder, and the sheet
 * may be corrected at any time; folding both to one key makes the match hold in
 * every combination.
 */
const FOCUS_SPELLING_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/gyn[eo]cologic/g, 'gynecologic'],
]

/** Case/whitespace/&/apostrophe-insensitive key for comparing focus names. */
export function normalizeFocus(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
  return FOCUS_SPELLING_FOLDS.reduce((acc, [re, to]) => acc.replace(re, to), base)
}

/**
 * Pull the focus out of an Atlas card title, which is built as
 * `<location name> — <focus> (Social)`. Falls back to splitting on the em dash
 * when the title doesn't start with the location name.
 *
 * Whitespace is collapsed because at least one title carries a literal newline
 * inherited from a wrapped Copy Plan cell
 * ("Women's Health \n(Urinary & Sexual)").
 */
export function parseCardFocus(title: string, locationName: string | null): string {
  let rest = title.replace(/\s*\((?:Social|Display)\)\s*$/i, '').trim()

  if (locationName && rest.toLowerCase().startsWith(locationName.toLowerCase())) {
    rest = rest.slice(locationName.length)
  } else {
    const parts = rest.split(/\s+[—–]\s+/)
    if (parts.length > 1) rest = parts.slice(1).join(' — ')
  }

  return rest.replace(/^\s*[—–-]\s*/, '').replace(/\s+/g, ' ').trim()
}
