/**
 * Atlas ↔ Box creative sync — tree walk and card matching.
 *
 * Box anatomy (Q4 2026, verified Sep 14):
 *
 *   Q4 / <Location> / <Focus> / Build / Atlas-M9-<Location>-<Focus>-<WxH>.<ext>
 *
 * Depth is NOT uniform — MetroCare nests a sub-location (MetroCare/Northside/<Focus>/Build)
 * — so the walk descends until it finds a folder named "Build" rather than
 * assuming a fixed depth. The owning <Location>/<Focus> folder names decide the
 * match; the filename is used only for the size filter.
 *
 * Every finished creative is three files. Only the 1080x1080 MP4 may reach a
 * card: the 1080x1920 MP4 and the 1080x1080 PNG are deliberately left in Box
 * (the org is on Supabase's free storage plan).
 *
 * This module is pure — no Supabase, no writes. The caller supplies a Box token
 * and the card/location rows to match against.
 */

import { listFolderItems, type BoxFile } from '@/lib/box'
import { matchAtlasLocation } from '@/lib/atlasSheet'
import { normalizeFocus, parseCardFocus } from '@/lib/atlasFocus'

// Re-exported so existing importers keep a single entry point for the Atlas sync.
export { normalizeFocus, parseCardFocus }

/** The size the Atlas Q4 spec calls for. Square renders at other sizes are off-spec but usable. */
export const ATLAS_PREFERRED_SIZE = 1080

/** Trailing `-<W>x<H>` size token in a creative filename. */
const SIZE_TOKEN = /-(\d{2,5})x(\d{2,5})(?=\.[^.]+$)/i

export interface CreativeSize {
  width: number
  height: number
}

/** Read the `-WxH` token out of a creative filename. */
export function parseSizeToken(fileName: string): CreativeSize | null {
  const m = fileName.match(SIZE_TOKEN)
  if (!m) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

/** Square = the feed render. Vertical 1080x1920 story renders never reach a card. */
export function isSquareCreative(fileName: string): boolean {
  const size = parseSizeToken(fileName)
  return !!size && size.width === size.height
}

/** True for a square MP4 — the only shape allowed onto an Atlas card. */
export function isAtlasAttachableFile(fileName: string): boolean {
  return /\.mp4$/i.test(fileName) && isSquareCreative(fileName)
}

export interface SquarePick {
  file: { id: string; name: string; size: number; dimensions: CreativeSize } | null
  /** Square but not 1080x1080 — attachable, surfaced so a re-render can be decided. */
  offSpec: boolean
  /** Set when several square MP4s tie and picking one would be a guess. */
  ambiguous: string[] | null
}

/**
 * Choose the one square MP4 a Build folder should contribute.
 *
 * Selection is by aspect ratio, not an exact pixel literal: some centres
 * rendered at 1200x1200 (Mountain Region, MetroCare Valley) and those are still
 * the feed creative. 1080x1080 wins when present; otherwise a lone square render
 * is taken and marked off-spec. A genuine tie is never guessed at — it is
 * reported so a human picks.
 */
export function pickSquareMp4(files: { id: string; name: string; size: number }[]): SquarePick {
  const squares = files
    .filter((f) => isAtlasAttachableFile(f.name))
    .map((f) => ({ ...f, dimensions: parseSizeToken(f.name)! }))

  if (squares.length === 0) return { file: null, offSpec: false, ambiguous: null }

  const exact = squares.filter((f) => f.dimensions.width === ATLAS_PREFERRED_SIZE)
  const pool = exact.length > 0 ? exact : squares
  if (pool.length > 1) {
    return { file: null, offSpec: false, ambiguous: pool.map((f) => f.name) }
  }

  return { file: pool[0], offSpec: exact.length === 0, ambiguous: null }
}

/** Safety rail for the recursive walk — the real tree is 3–4 levels deep. */
const MAX_WALK_DEPTH = 6

/**
 * Naming drift: Box focus folder → Atlas card focus. Keys and values are both
 * given as they are written by a human; both sides are normalised before the
 * lookup, so only genuine renames need an entry.
 *
 * `Head and Neck`/`Head & Neck`, `Mens Health`/`Men's Health` and
 * `Lung Radiation`/`Lung - Radiation` already fall out of normalisation, and are
 * listed anyway so this table stays the single record of every known drift.
 *
 * When the next one appears, add one line here.
 */
export const ATLAS_FOCUS_ALIASES: Record<string, string> = {
  'Branding': 'Branded',                                 // two practices
  'Head and Neck': 'Head & Neck',                        // two practices
  'Mens Health': "Men's Health",                         // Coastal Urology
  'Lung Radiation': 'Lung - Radiation',                  // Coastal Cancer Care
  'Pancreatic': 'Pancreatic - Medonc',                   // Coastal Cancer Care
  'UTI': "Women's Health (Urinary & Sexual)",            // one practice — a real rename, not a normalisation
  'LDRT': 'LDRT for OA',                                 // several desert-region practices
}

/**
 * Box location folder → Atlas location name(s). Only for names `matchAtlasLocation`
 * cannot reach on its own (verified against the live atlas_locations list):
 *
 *  - `MetroCare/Northside` — the app name is "MetroCare North (Northside)", so neither string
 *    contains the other and the substring fallback returns nothing.
 *  - `Mountain Region` — plural in Box, singular in the app.
 *  - `ScanCo` — ONE shared video, several locations. Box's single ScanCo folder is
 *    correct and must not be split: the centres share the creative but
 *    their copy is per location, so the cards stay separate and one build
 *    attaches to all of them. This is the documented one-to-many decision.
 */
export const ATLAS_LOCATION_ALIASES: Record<string, string[]> = {
  'MetroCare/Northside': ['Atlas - MetroCare North (Northside)'],
  'Mountain Region': ['Atlas - Mountain Region Oncology'],
  'ScanCo': [
    'Atlas - ScanCo Imaging of Metro (Ridgeview)',
    'Atlas - ScanCo Imaging of Region Two (Hillcrest)',
    'Atlas - ScanCo Imaging of Region Three',
    'Atlas - ScanCo Imaging of Region Four',
    'Atlas - ScanCo Imaging of Region Five',
  ],
}

const ALIAS_BY_NORMALIZED_KEY = new Map(
  Object.entries(ATLAS_FOCUS_ALIASES).map(([box, card]) => [normalizeFocus(box), normalizeFocus(card)]),
)

/** Normalised focus key for a Box folder name, after alias resolution. */
export function canonicalFocusKey(boxFocusName: string): string {
  const key = normalizeFocus(boxFocusName)
  return ALIAS_BY_NORMALIZED_KEY.get(key) ?? key
}

// ─── Walk ─────────────────────────────────────────────────────────────────────

export interface AtlasBoxBuild {
  /** The `Build` folder's own id — this is what lands on cards.box_folder_id. */
  buildFolderId: string
  /** Folder names between the root and `Build`, e.g. ['MetroCare','Northside','Breast']. */
  path: string[]
  /** Everything above the focus folder, e.g. 'MetroCare/Northside'. */
  locationLabel: string
  /** The folder directly above `Build`, e.g. 'Breast'. */
  focusLabel: string
  /** The one square MP4 this build contributes, when it has exactly one. */
  file: { id: string; name: string; size: number; dimensions: CreativeSize } | null
  /** Square but not 1080x1080 — still attachable; surfaced for a re-render decision. */
  offSpec: boolean
  /** Names of tied square MP4s when picking one would be a guess. */
  ambiguousFiles: string[] | null
  /** Names of files deliberately not attached (story sizes, PNGs) — shown in the preview. */
  skippedFiles: string[]
}

/** A `Build` folder and what sits in it, creative-agnostic (Social and Display trees share it). */
export interface BoxBuildFolder {
  buildFolderId: string
  /** Folder names between the root and `Build`, e.g. ['MetroCare','Northside','Breast']. */
  path: string[]
  files: { id: string; name: string; size: number }[]
}

/**
 * Walk a Box tree and return one entry per `Build` folder found, with its files.
 * Read-only: lists folders and files, downloads nothing.
 */
export async function walkBuildFolders(
  rootFolderId: string,
  token: string,
  path: string[] = [],
  depth = 0,
): Promise<BoxBuildFolder[]> {
  if (depth > MAX_WALK_DEPTH) return []

  const items = await listFolderItems(rootFolderId, token)
  const folders = items.filter((i) => i.type === 'folder')
  const buildFolder = folders.find((f) => f.name.trim().toLowerCase() === 'build')

  if (buildFolder) {
    const files = (await listFolderItems(buildFolder.id, token)).filter((i) => i.type === 'file')
    return [{ buildFolderId: buildFolder.id, path, files }]
  }

  const nested: BoxBuildFolder[] = []
  for (const folder of folders) {
    nested.push(...(await walkBuildFolders(folder.id, token, [...path, folder.name], depth + 1)))
  }
  return nested
}

/** Social tree: every Build folder, with the one square MP4 it contributes. */
export async function walkAtlasBuilds(rootFolderId: string, token: string): Promise<AtlasBoxBuild[]> {
  return (await walkBuildFolders(rootFolderId, token)).map((b) => {
    const pick = pickSquareMp4(b.files)
    return {
      buildFolderId: b.buildFolderId,
      path: b.path,
      locationLabel: b.path.slice(0, -1).join('/'),
      focusLabel: b.path[b.path.length - 1] ?? '',
      file: pick.file,
      offSpec: pick.offSpec,
      ambiguousFiles: pick.ambiguous,
      skippedFiles: b.files.filter((f) => f.name !== pick.file?.name).map((f) => f.name),
    }
  })
}

/** Display tree: every Build folder, with its file names (six HTML5 zips expected). */
export interface AtlasDisplayBuild {
  buildFolderId: string
  path: string[]
  locationLabel: string
  focusLabel: string
  files: string[]
}

export async function walkDisplayBuilds(rootFolderId: string, token: string): Promise<AtlasDisplayBuild[]> {
  return (await walkBuildFolders(rootFolderId, token)).map((b) => ({
    buildFolderId: b.buildFolderId,
    path: b.path,
    locationLabel: b.path.slice(0, -1).join('/'),
    focusLabel: b.path[b.path.length - 1] ?? '',
    files: b.files.map((f) => f.name),
  }))
}

// ─── Match ────────────────────────────────────────────────────────────────────

export interface AtlasSyncCard {
  id: string
  title: string
  atlas_location_id: string | null
  box_folder_id: string | null
}

export interface AtlasSyncLocation {
  id: string
  name: string
}

export type AtlasBoxRowStatus = 'matched' | 'needs_attention'

/** The Display (Banner Ads) Build folder paired with a row. */
export interface AtlasScanDisplay {
  buildFolderId: string
  boxPath: string
  files: string[]
}

export interface AtlasBoxScanRow {
  /** Stable key for React and for the apply payload. */
  rowKey: string
  /** The Social Build folder; null on a row that exists only because of a Display build. */
  buildFolderId: string | null
  /** Display Build folder paired with this row, or null when Banner Ads has none for it. */
  display: AtlasScanDisplay | null
  /** atlas_locations ids the Box location label resolved to (several for ScanCo). */
  locationIds: string[]
  boxPath: string
  locationLabel: string
  focusLabel: string
  file: { id: string; name: string; size: number; dimensions: CreativeSize } | null
  offSpec: boolean
  ambiguousFiles: string[] | null
  skippedFiles: string[]
  /** Card ids this build should attach to. Several is normal for ScanCo. */
  cardIds: string[]
  /** Offered when the match is ambiguous, so the user can choose in the UI. */
  candidateCardIds: string[]
  status: AtlasBoxRowStatus
  reason: string | null
}

export interface AtlasBoxScanResult {
  matched: AtlasBoxScanRow[]
  needsAttention: AtlasBoxScanRow[]
  /** Cards no Build folder resolved to. */
  cardsWithoutBuild: { id: string; title: string }[]
  /** Social rows for which Banner Ads has no Display build — surfaced, never silently skipped. */
  displayMissing: { rowKey: string; boxPath: string; reason: string }[]
  totals: {
    displayBuilds: number
    buildFolders: number
    cardsCovered: number
    cards: number
  }
}

/**
 * Every spelling a focus is known by: the folder's own wording, the aliased card
 * focus, and any alias partner pointing the other way. The drift runs in both
 * directions in the wild — some folders are named "Branding" with "Branded"
 * cards, while EXOCC's folder is "Branded" with "…-EXOCC-Branding-…" files — so
 * an equivalence set is needed, not a one-way lookup.
 */
function focusSpellings(focusLabel: string): string[] {
  const raw = normalizeFocus(focusLabel)
  const out = new Set<string>([raw, canonicalFocusKey(focusLabel)])
  for (const [boxName, cardName] of Object.entries(ATLAS_FOCUS_ALIASES)) {
    const boxKey = normalizeFocus(boxName)
    const cardKey = normalizeFocus(cardName)
    if (boxKey === raw) out.add(cardKey)
    if (cardKey === raw) out.add(boxKey)
  }
  out.delete('')
  return [...out]
}

/**
 * Does the creative's filename mention the focus its folder claims?
 *
 * Only a filename matching NONE of the focus's known spellings counts as a
 * disagreement, so this flags clear mismatches (a Lung render sitting in the
 * Prostate folder) without adding noise for mere naming drift.
 */
function filenameMentionsFocus(fileName: string, focusLabel: string): boolean {
  const haystack = normalizeFocus(fileName.replace(SIZE_TOKEN, ''))
  const spellings = focusSpellings(focusLabel)
  if (spellings.length === 0) return true
  return spellings.some((s) => haystack.includes(s))
}

/** Resolve a Box location label to Atlas location ids (several, for ScanCo). */
function resolveLocations(locationLabel: string, locations: AtlasSyncLocation[]): {
  ids: string[]
  reason: string | null
} {
  const aliasNames = ATLAS_LOCATION_ALIASES[locationLabel]
  if (aliasNames) {
    const ids: string[] = []
    const missing: string[] = []
    for (const name of aliasNames) {
      const found = locations.find((l) => l.name === name)
      if (found) ids.push(found.id)
      else missing.push(name)
    }
    if (missing.length > 0) {
      // A renamed/deactivated location must surface, never silently drop a centre.
      return { ids, reason: `Location alias "${locationLabel}" expects ${missing.join(', ')} — not found in atlas_locations` }
    }
    return { ids, reason: null }
  }

  const match = matchAtlasLocation(locationLabel, locations)
  if (!match.id) return { ids: [], reason: `No Atlas location matches the Box folder "${locationLabel}"` }
  return { ids: [match.id], reason: null }
}

/**
 * The live cards a Box location/focus pair points at, using the same location
 * resolution, alias table and title parsing for both the Social and the
 * Display tree.
 */
function findCandidates(
  locationLabel: string,
  focusLabel: string,
  cards: AtlasSyncCard[],
  locations: AtlasSyncLocation[],
): {
  locationIds: string[]
  locationReason: string | null
  candidates: AtlasSyncCard[]
  duplicateLocations: [string, number][]
} {
  const locationById = new Map(locations.map((l) => [l.id, l]))
  const { ids: locationIds, reason: locationReason } = resolveLocations(locationLabel, locations)
  const focusKey = canonicalFocusKey(focusLabel)
  const candidates = cards.filter(
    (c) =>
      c.atlas_location_id !== null &&
      locationIds.includes(c.atlas_location_id) &&
      normalizeFocus(parseCardFocus(c.title, locationById.get(c.atlas_location_id)?.name ?? null)) === focusKey,
  )
  // Ambiguity is per location: ScanCo's several cards are several locations (fine),
  // while two Breast cards inside one location is a real conflict.
  const perLocationCounts = new Map<string, number>()
  for (const c of candidates) {
    if (c.atlas_location_id) perLocationCounts.set(c.atlas_location_id, (perLocationCounts.get(c.atlas_location_id) ?? 0) + 1)
  }
  const duplicateLocations = [...perLocationCounts.entries()].filter(([, n]) => n > 1)
  return { locationIds, locationReason, candidates, duplicateLocations }
}

/**
 * Match every Build folder to the Atlas cards it should attach to.
 *
 * One build → many cards is expected (ScanCo). Many cards → one build inside a
 * single location is genuinely ambiguous (MetroCare Valley has two `Breast`
 * cards) and is routed to needs-attention with both cards offered, rather than
 * guessed at.
 */
export function matchAtlasBuilds(
  builds: AtlasBoxBuild[],
  cards: AtlasSyncCard[],
  locations: AtlasSyncLocation[],
): AtlasBoxScanResult {
  const locationById = new Map(locations.map((l) => [l.id, l]))
  const coveredCardIds = new Set<string>()
  const matched: AtlasBoxScanRow[] = []
  const needsAttention: AtlasBoxScanRow[] = []

  for (const build of builds) {
    const boxPath = build.path.join('/')
    const { locationIds, locationReason, candidates, duplicateLocations } =
      findCandidates(build.locationLabel, build.focusLabel, cards, locations)

    const base = {
      rowKey: build.buildFolderId,
      buildFolderId: build.buildFolderId,
      display: null,
      locationIds,
      boxPath,
      locationLabel: build.locationLabel,
      focusLabel: build.focusLabel,
      file: build.file,
      offSpec: build.offSpec,
      ambiguousFiles: build.ambiguousFiles,
      skippedFiles: build.skippedFiles,
    }

    let reason: string | null = locationReason
    if (!reason && build.ambiguousFiles) {
      reason = `More than one square MP4 here (${build.ambiguousFiles.join(', ')}) — pick which render to attach`
    }
    if (!reason && !build.file) reason = 'No square MP4 in this Build folder'
    if (!reason && candidates.length === 0) reason = `No Atlas card for ${build.locationLabel || '(root)'} / ${build.focusLabel}`
    // The folder path decides the match, but a filename naming a DIFFERENT focus
    // means the Build folder holds the wrong render (seen live: MetroCare/South/Prostate
    // contains Atlas-M9-MetroCare-South-Lung-1080x1080.mp4). Attaching that silently files
    // the wrong video against a client's card, so route it to a human instead.
    if (!reason && build.file && !filenameMentionsFocus(build.file.name, build.focusLabel)) {
      reason = `Filename "${build.file.name}" does not name the "${build.focusLabel}" focus — check the Build folder holds the right render`
    }
    if (!reason && duplicateLocations.length > 0) {
      const names = duplicateLocations.map(([id]) => locationById.get(id)?.name ?? id).join(', ')
      reason = `More than one card with this focus at ${names} — pick which one`
    }

    if (reason) {
      needsAttention.push({ ...base, cardIds: [], candidateCardIds: candidates.map((c) => c.id), status: 'needs_attention', reason })
      continue
    }

    for (const c of candidates) coveredCardIds.add(c.id)
    matched.push({
      ...base,
      cardIds: candidates.map((c) => c.id),
      candidateCardIds: candidates.map((c) => c.id),
      status: 'matched',
      reason: null,
    })
  }

  const cardsWithoutBuild = cards
    .filter((c) => !coveredCardIds.has(c.id))
    .map((c) => ({ id: c.id, title: c.title }))

  return {
    matched,
    needsAttention,
    cardsWithoutBuild,
    displayMissing: [],
    totals: { displayBuilds: 0, buildFolders: builds.length, cardsCovered: coveredCardIds.size, cards: cards.length },
  }
}

/**
 * Match BOTH trees. Social matching is exactly `matchAtlasBuilds`; each Display
 * build is then resolved through the same matchers and paired onto the Social
 * row for the same card(s). A Display build with no Social row becomes its own
 * row so its link can still be stored. Social rows with no Display build are
 * listed in `displayMissing` (with the reason) — including a missing ScanCo
 * folder — rather than dropped.
 *
 * `displayTreeNote` replaces the reason when the whole Display period folder
 * does not exist yet (Banner Ads <year>/<quarter> not created).
 */
export function matchAtlasBoxTrees(
  socialBuilds: AtlasBoxBuild[],
  displayBuilds: AtlasDisplayBuild[],
  cards: AtlasSyncCard[],
  locations: AtlasSyncLocation[],
  displayTreeNote: string | null = null,
): AtlasBoxScanResult {
  const social = matchAtlasBuilds(socialBuilds, cards, locations)
  const rows: AtlasBoxScanRow[] = [...social.matched, ...social.needsAttention]
  const extraRows: AtlasBoxScanRow[] = []
  const displayLocationIds = new Set<string>()
  // Social rows whose only Display build is an empty folder — reported in
  // displayMissing, never paired (an empty Banner Ads folder is "not built yet",
  // not a reason to hold back the Social attach).
  const emptyDisplay = new Set<string>()
  // Display builds paired onto each Social row, to catch two competing for one row.
  const pairedBuild = new Map<string, AtlasDisplayBuild>()
  const contested = new Set<string>()

  const displayRow = (db: AtlasDisplayBuild, reason: string | null): AtlasBoxScanRow => {
    const { locationIds, candidates } = findCandidates(db.locationLabel, db.focusLabel, cards, locations)
    return {
      rowKey: `display:${db.buildFolderId}`,
      buildFolderId: null,
      display: { buildFolderId: db.buildFolderId, boxPath: db.path.join('/'), files: db.files },
      locationIds,
      boxPath: db.path.join('/'),
      locationLabel: db.locationLabel,
      focusLabel: db.focusLabel,
      file: null,
      offSpec: false,
      ambiguousFiles: null,
      skippedFiles: [],
      cardIds: reason ? [] : candidates.map((c) => c.id),
      candidateCardIds: candidates.map((c) => c.id),
      status: reason ? 'needs_attention' : 'matched',
      reason,
    }
  }

  for (const db of displayBuilds) {
    const { locationIds, locationReason, candidates, duplicateLocations } =
      findCandidates(db.locationLabel, db.focusLabel, cards, locations)
    for (const id of locationIds) displayLocationIds.add(id)
    const focusKey = canonicalFocusKey(db.focusLabel)

    const target = rows.find(
      (r) =>
        r.buildFolderId !== null &&
        canonicalFocusKey(r.focusLabel) === focusKey &&
        r.locationIds.some((id) => locationIds.includes(id)),
    )
    if (target) {
      if (db.files.length === 0) {
        emptyDisplay.add(target.rowKey)
        continue
      }
      const contestReason = `More than one Banner Ads build for ${db.locationLabel || '(root)'} / ${db.focusLabel} — pick which one`
      const first = pairedBuild.get(target.rowKey)
      if (first) {
        // Two Display builds for one row: neither is applied silently.
        if (!contested.has(target.rowKey)) {
          contested.add(target.rowKey)
          target.display = null
          extraRows.push(displayRow(first, contestReason))
        }
        extraRows.push(displayRow(db, contestReason))
        continue
      }
      if (contested.has(target.rowKey)) {
        extraRows.push(displayRow(db, contestReason))
        continue
      }
      pairedBuild.set(target.rowKey, db)
      target.display = { buildFolderId: db.buildFolderId, boxPath: db.path.join('/'), files: db.files }
      continue
    }

    let reason: string | null = locationReason
    if (!reason && db.files.length === 0) reason = 'The Display Build folder is empty'
    if (!reason && candidates.length === 0) reason = `No Atlas card for ${db.locationLabel || '(root)'} / ${db.focusLabel}`
    if (!reason && duplicateLocations.length > 0) {
      const names = duplicateLocations.map(([id]) => locations.find((l) => l.id === id)?.name ?? id).join(', ')
      reason = `More than one card with this focus at ${names} — pick which one`
    }
    extraRows.push(displayRow(db, reason))
  }

  const allRows = [...rows, ...extraRows]
  const matched = allRows.filter((r) => r.status === 'matched')
  const needsAttention = allRows.filter((r) => r.status === 'needs_attention')
  const covered = new Set(matched.flatMap((r) => r.cardIds))

  const displayMissing = rows
    .filter((r) => r.buildFolderId !== null && !r.display)
    .map((r) => ({
      rowKey: r.rowKey,
      boxPath: r.boxPath,
      reason: displayTreeNote
        ?? (contested.has(r.rowKey) ? 'More than one Banner Ads build — see Needs attention' : null)
        ?? (emptyDisplay.has(r.rowKey) ? 'The Display Build folder is empty' : null)
        ?? (r.locationIds.some((id) => displayLocationIds.has(id))
          ? `No Banner Ads build for "${r.focusLabel}"`
          : `No "${r.locationLabel}" folder in Banner Ads`),
    }))

  return {
    matched,
    needsAttention,
    cardsWithoutBuild: cards.filter((c) => !covered.has(c.id)).map((c) => ({ id: c.id, title: c.title })),
    displayMissing,
    totals: {
      displayBuilds: displayBuilds.length,
      buildFolders: socialBuilds.length,
      cardsCovered: covered.size,
      cards: cards.length,
    },
  }
}

export type { BoxFile }
