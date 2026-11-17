/**
 * Atlas copy sync — push edited Copy Plan copy onto cards that already exist.
 *
 * The sheet is the source of truth for copy. When wording is edited after cards
 * were created there is otherwise no update path: force-importing an already-
 * imported row INSERTs a second card, leaving old and new copy side by side.
 * This module computes what would change; it writes nothing.
 *
 * Three-way, not two. `atlas_creative_refresh` holds the sheet copy as of the last
 * import, so comparing sheet / last-sync / card tells a plain edit apart from
 * one that would clobber someone's hand-edit:
 *
 *   card == last-sync, sheet differs  → normal change
 *   card != last-sync                 → CONFLICT: the card was hand-edited
 *   sheet == card                     → nothing to do, row is not shown at all
 *
 * Sheet-wins is still the rule, so a conflict resolves toward the sheet — but it
 * has to be visible and ticked individually. Silently losing a hand-edit is the
 * failure this design exists to prevent.
 *
 * Box build links ride along (ATLAS_LINK_FIELDS) so every social card ends up
 * carrying both builds for "Download all builds". They differ from copy in three
 * ways: a link is never blanked (no link in the sheet = leave the card alone),
 * links are read from the selected period only (a period with none changes
 * nothing), and writing one does not reset a client review — the client never
 * sees a Box link.
 */

import { parseCardFocus, normalizeFocus } from '@/lib/atlasFocus'
import type { CopyPlanPullRow, ParsedCopyPlanRow } from '@/lib/atlasSheet'
import type { AtlasCreativeRefresh } from '@/types'

/** Copy columns this mode may write. Files and box_folder_id are out of scope; links are ATLAS_LINK_FIELDS. */
export const ATLAS_COPY_FIELDS = [
  { card: 'fb_body_text', sheet: 'social_copy', label: 'Primary text' },
  { card: 'fb_headline', sheet: 'social_headline', label: 'Headline' },
  { card: 'fb_subheadline', sheet: 'social_subhead', label: 'Sub headline' },
  { card: 'heading', sheet: 'graphic_headline', label: 'Graphic heading' },
  { card: 'subheading', sheet: 'graphic_subhead', label: 'Graphic subheading' },
  { card: 'landing_page_url', sheet: 'facebook_url', label: 'Landing page' },
] as const

/**
 * Box build links this mode may fill. `sheet` is both the parsed-row key and the
 * atlas_creative_refresh baseline column, same as the copy fields.
 * box_folder_id is deliberately NOT re-resolved when build_link changes: on Atlas
 * it is owned by the Box creative sync, which points it at the Build folder.
 */
export const ATLAS_LINK_FIELDS = [
  { card: 'build_link', sheet: 'social_build_box_link', label: 'Social build link (Box)', kind: 'social' },
  { card: 'display_build_link', sheet: 'display_build_box_link', label: 'Display build link (Box)', kind: 'display' },
] as const

export type AtlasCopyCardField = (typeof ATLAS_COPY_FIELDS)[number]['card']
export type AtlasLinkCardField = (typeof ATLAS_LINK_FIELDS)[number]['card']
type SheetField = (typeof ATLAS_COPY_FIELDS)[number]['sheet'] | (typeof ATLAS_LINK_FIELDS)[number]['sheet']

/**
 * Compare on meaning, not bytes. The sheet round-trips through Google Sheets and
 * a CSV export, which introduces non-breaking spaces, CRLF and incidental
 * double-spacing that are not edits. Paragraph breaks ARE preserved — collapsing
 * them would hide a real rewrite.
 */
export function normalizeCopy(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim()
}

export function copyValuesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeCopy(a) === normalizeCopy(b)
}

/**
 * A "Still Good" row means the previous period's creative is being reused, not
 * refreshed — it carries no real copy, just that note (spelled loosely; the live
 * sheet has both "Still Good" and "STill Good"). The CSV import already badges
 * these as unlabelled copy. The copy sync drops them outright: they have no card
 * to update by design, so counting them as "no card" would make them permanent
 * noise every quarter.
 */
export function isStillGoodRow(parsed: ParsedCopyPlanRow): boolean {
  const hasRealCopy =
    parsed.social_headline || parsed.social_subhead || parsed.graphic_headline || parsed.graphic_subhead
  if (hasRealCopy) return false
  return /^still\s*good\b/i.test(normalizeCopy(parsed.social_copy))
}

/** Enough of an archived card to tell "deliberately retired" from "never existed". */
export interface AtlasCopyArchivedCard {
  id: string
  title: string
  atlas_location_id: string | null
}

export interface AtlasCopyCard {
  id: string
  title: string
  atlas_location_id: string | null
  adpiler_preview_url: string | null
  fb_body_text: string | null
  fb_headline: string | null
  fb_subheadline: string | null
  heading: string | null
  subheading: string | null
  landing_page_url: string | null
  build_link: string | null
  display_build_link: string | null
}

export interface AtlasCopyFieldDiff {
  field: AtlasCopyCardField | AtlasLinkCardField
  /** 'link' fields are ticked one by one and never reset approval. */
  kind: 'copy' | 'link'
  label: string
  /** What the sheet says now — the value that would be written. */
  sheet: string | null
  /** What the card says now. */
  card: string | null
  /** What the sheet said at the last import (atlas_creative_refresh). */
  lastSync: string | null
  /**
   * card !== lastSync — the card was edited by hand since the last import. For a
   * link this only counts when the card HAS a link: an empty card is a plain fill.
   */
  conflict: boolean
}

/** One card this sheet row could be describing, and what would change on it. */
export interface AtlasCopyCandidate {
  cardId: string
  cardTitle: string
  fields: AtlasCopyFieldDiff[]
  /**
   * Card is live in Adviewer AND this row changes its copy, so applying the copy
   * resets the client review. Link-only changes never set this.
   */
  resetsApproval: boolean
}

export type AtlasCopyRowStatus = 'change' | 'conflict'

export interface AtlasCopyDiffRow {
  /** Stable key for React and the apply payload — one sheet row, not one card. */
  key: string
  /** 1-based sheet row, which is what tells two creatives of one focus apart. */
  sheetRow: number
  locationId: string
  locationName: string
  focusType: string
  refreshRowId: string | null
  /**
   * Always exactly one. Kept as a list because the shape predates the importer's
   * Primary/Secondary tie-breaker; see the note on `buildAtlasCopyDiff`.
   */
  candidates: AtlasCopyCandidate[]
  status: AtlasCopyRowStatus
}

export interface AtlasCopyDiffResult {
  rows: AtlasCopyDiffRow[]
  totals: {
    /** Already-imported sheet rows examined. */
    examined: number
    /** Rows already matching a card exactly — never shown. */
    unchanged: number
    changed: number
    conflicts: number
    /**
     * No card has ever existed for that location+focus — something may be
     * missing. Kept apart from `archived`, where somebody decided.
     */
    noCard: number
    /** A card exists for that location+focus but was deliberately archived. */
    archivedCard: number
    /** "Still Good" reuse notes — skipped entirely, never reported as missing. */
    stillGood: number
    /** Location+focus pairs that still map to several cards — skipped, never guessed. */
    ambiguous: number
    /** Link fields where the card is empty and the sheet has a link. */
    linksToFill: number
    /** Link fields where the card has a different link than the sheet. */
    linksToReplace: number
    /**
     * Matched cards that will STILL have no social / display link even if every
     * fill shown is applied — the selected period has none for that row.
     */
    missingSocial: number
    missingDisplay: number
  }
}

function sheetValue(parsed: ParsedCopyPlanRow, field: SheetField): string | null {
  return parsed[field]
}

function refreshValue(row: AtlasCreativeRefresh | undefined, field: SheetField): string | null {
  if (!row) return null
  const v = (row as unknown as Record<string, unknown>)[field]
  return typeof v === 'string' ? v : null
}

/**
 * Build the diff for every already-imported sheet row.
 *
 * Pure — no Supabase, no writes. Rows with nothing to change are dropped, so a
 * re-run against an unedited sheet returns an empty list.
 */
export function buildAtlasCopyDiff(
  pullRows: CopyPlanPullRow[],
  cards: AtlasCopyCard[],
  refreshRows: AtlasCreativeRefresh[],
  locations: { id: string; name: string }[],
  archivedCards: AtlasCopyArchivedCard[] = [],
): AtlasCopyDiffResult {
  const locationName = new Map(locations.map((l) => [l.id, l.name]))

  // Cards keyed by location + normalised focus, parsed out of the title because
  // `cards` carries no focus column. Several cards under one key is legitimate —
  // the sheet holds two creatives for the same focus at five location/focus
  // pairs — and is the hazard this must never guess at.
  const cardsByKey = new Map<string, AtlasCopyCard[]>()
  for (const card of cards) {
    if (!card.atlas_location_id) continue
    const focus = parseCardFocus(card.title, locationName.get(card.atlas_location_id) ?? null)
    const key = `${card.atlas_location_id}::${normalizeFocus(focus)}`
    const list = cardsByKey.get(key) ?? []
    list.push(card)
    cardsByKey.set(key, list)
  }

  // Keys of location+focus pairs whose only cards are archived. Reported
  // separately from "no card": an archived card means somebody decided, while no
  // card at all may mean something is missing. Fifteen rows reported identically
  // every quarter get ignored wholesale, and that is exactly when a real gap
  // slips through.
  const archivedKeys = new Set<string>()
  for (const card of archivedCards) {
    if (!card.atlas_location_id) continue
    const focus = parseCardFocus(card.title, locationName.get(card.atlas_location_id) ?? null)
    archivedKeys.add(`${card.atlas_location_id}::${normalizeFocus(focus)}`)
  }

  const refreshByKey = new Map<string, AtlasCreativeRefresh>()
  for (const row of refreshRows) {
    refreshByKey.set(`${row.location_id}::${normalizeFocus(row.focus_type)}`, row)
  }

  const rows: AtlasCopyDiffRow[] = []
  let examined = 0
  let unchanged = 0
  let noCard = 0
  let archivedCard = 0
  let stillGood = 0
  let ambiguous = 0
  let linksToFill = 0
  let linksToReplace = 0
  let missingSocial = 0
  let missingDisplay = 0

  /** What would change on one card if this sheet row were written to it. */
  function diffAgainst(
    parsed: ParsedCopyPlanRow,
    card: AtlasCopyCard,
    refreshRow: AtlasCreativeRefresh | undefined,
  ): AtlasCopyFieldDiff[] {
    const out: AtlasCopyFieldDiff[] = []
    for (const spec of ATLAS_COPY_FIELDS) {
      const sheet = sheetValue(parsed, spec.sheet)
      const cardValue = card[spec.card]
      if (copyValuesEqual(sheet, cardValue)) continue
      const lastSync = refreshValue(refreshRow, spec.sheet)
      out.push({
        field: spec.card,
        kind: 'copy',
        label: spec.label,
        sheet,
        card: cardValue,
        lastSync,
        conflict: !copyValuesEqual(cardValue, lastSync),
      })
    }
    return out
  }

  /** Box build links that would change on this card. Never blanks one. */
  function linkDiffAgainst(
    pull: CopyPlanPullRow,
    card: AtlasCopyCard,
    refreshRow: AtlasCreativeRefresh | undefined,
  ): AtlasCopyFieldDiff[] {
    const out: AtlasCopyFieldDiff[] = []
    for (const spec of ATLAS_LINK_FIELDS) {
      const sheet = normalizeCopy(sheetValue(pull.parsed, spec.sheet))
      // No link in the selected period for this row: leave the card's link alone.
      if (!sheet) continue
      const cardValue = card[spec.card]
      if (copyValuesEqual(sheet, cardValue)) continue
      const lastSync = refreshValue(refreshRow, spec.sheet)
      out.push({
        field: spec.card,
        kind: 'link',
        label: spec.label,
        sheet,
        card: cardValue,
        lastSync,
        conflict: !!normalizeCopy(cardValue) && !copyValuesEqual(cardValue, lastSync),
      })
    }
    return out
  }

  for (const pull of pullRows) {
    // Update-only: a row that was never imported is the CSV import's job.
    if (!pull.alreadyImported || !pull.matchedLocationId) continue
    if (isStillGoodRow(pull.parsed)) { stillGood += 1; continue }
    examined += 1

    const key = `${pull.matchedLocationId}::${normalizeFocus(pull.focusType)}`
    const matched = cardsByKey.get(key) ?? []
    if (matched.length === 0) {
      if (archivedKeys.has(key)) archivedCard += 1
      else noCard += 1
      continue
    }

    const refreshRow = refreshByKey.get(key)
    const perCard = matched.map((card) => ({ card, fields: diffAgainst(pull.parsed, card, refreshRow) }))

    // A card that already carries this row's copy verbatim IS this row's card.
    // This is what keeps a re-run of an unedited sheet empty where a
    // location+focus carries two creatives: the sheet holds two rows for that
    // focus and each one matches its own card exactly, so neither is ambiguous
    // until somebody edits one. The match is on COPY only — links are then
    // diffed against that one card, so a missing link cannot turn a clean pair
    // into an "ambiguous" skip.
    const exact = perCard.filter((c) => c.fields.length === 0)
    if (exact.length > 1) {
      // Identical copy on several cards: whose build is this? Not guessed.
      unchanged += 1
      continue
    }
    if (exact.length === 1) {
      const card = exact[0].card
      const links = linkDiffAgainst(pull, card, refreshRow)
      countLinks(pull, card, links)
      if (links.length === 0) {
        unchanged += 1
        continue
      }
      rows.push(makeRow(pull, key, refreshRow, card, links))
      continue
    }

    // Exactly one card per location+focus is expected: the importer's
    // Primary/Secondary tie-breaker (lib/atlasSheet.ts → buildPullRows) keeps only
    // the Primary row when a focus carries both tiers, so the two-creatives-per-
    // focus case that used to produce a pair cannot occur. Should one somehow
    // survive — a card created before that rule, or a hand-made duplicate — the
    // row is skipped rather than guessed at, because writing one row's wording
    // onto both would destroy the other creative's copy.
    if (matched.length > 1) {
      ambiguous += 1
      continue
    }

    const only = perCard[0]
    const links = linkDiffAgainst(pull, only.card, refreshRow)
    countLinks(pull, only.card, links)
    rows.push(makeRow(pull, key, refreshRow, only.card, [...only.fields, ...links]))
  }

  function countLinks(pull: CopyPlanPullRow, card: AtlasCopyCard, links: AtlasCopyFieldDiff[]) {
    for (const f of links) {
      if (normalizeCopy(f.card)) linksToReplace += 1
      else linksToFill += 1
    }
    // Still missing after a full apply = empty on the card AND nothing in the sheet.
    if (!normalizeCopy(card.build_link) && !normalizeCopy(pull.parsed.social_build_box_link)) missingSocial += 1
    if (!normalizeCopy(card.display_build_link) && !normalizeCopy(pull.parsed.display_build_box_link)) missingDisplay += 1
  }

  function makeRow(
    pull: CopyPlanPullRow,
    key: string,
    refreshRow: AtlasCreativeRefresh | undefined,
    card: AtlasCopyCard,
    fields: AtlasCopyFieldDiff[],
  ): AtlasCopyDiffRow {
    const locationId = pull.matchedLocationId ?? ''
    return {
      key: `${key}::${pull.sheetRow}`,
      sheetRow: pull.sheetRow,
      locationId,
      locationName: locationName.get(locationId) ?? pull.locationName,
      focusType: pull.focusType,
      refreshRowId: refreshRow?.id ?? null,
      candidates: [{
        cardId: card.id,
        cardTitle: card.title.replace(/\s+/g, ' ').trim(),
        fields,
        // Only a copy change reaches the client; a Box link never does.
        resetsApproval: !!card.adpiler_preview_url && fields.some((f) => f.kind === 'copy'),
      }],
      status: fields.some((f) => f.conflict) ? 'conflict' : 'change',
    }
  }

  return {
    rows,
    totals: {
      examined,
      unchanged,
      changed: rows.filter((r) => r.status === 'change').length,
      conflicts: rows.filter((r) => r.status === 'conflict').length,
      noCard,
      archivedCard,
      stillGood,
      ambiguous,
      linksToFill,
      linksToReplace,
      missingSocial,
      missingDisplay,
    },
  }
}
