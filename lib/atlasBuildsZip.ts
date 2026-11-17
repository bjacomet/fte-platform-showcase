/**
 * Pure helpers for the Atlas board's "Download all builds" button.
 *
 * Kept free of imports beyond `atlasFocus` (pure string work) so the browser-side
 * zip assembly in components/atlas/AtlasBoard.tsx stays thin and the naming/grouping
 * rules are unit-testable.
 */
import { parseCardFocus } from './atlasFocus'

export interface AtlasLocationLike {
  id: string
  name: string
  advertiser_name?: string | null
  shares_creative?: boolean | null
}

export interface AtlasBuildCard {
  id: string
  title: string
  atlas_location_id: string | null
  build_link: string | null
  display_build_link: string | null
  box_folder_id: string | null
}

export type BuildKind = 'Social' | 'Display'

export interface AtlasColumn {
  key: string
  title: string
  locationIds: string[]
}

export interface BuildTask {
  cardId: string
  locationFolder: string
  focusFolder: string
  kind: BuildKind
  /** The card's Build folder (cards.box_folder_id), set by "Sync creatives from Box". */
  folderId: string | null
  /** build_link (Social) or display_build_link (Display) — shared-link fallback. */
  link: string | null
  /** Folder inside the master zip, no trailing slash: `Loc/Focus/Social`. */
  dir: string
}

export interface MissingRow {
  location: string
  focus: string
  kind: BuildKind
  reason: string
}

const ATLAS_PREFIX = /^\s*Atlas\s*[-–—]\s*/i

export function shortLocationName(name: string): string {
  return name.replace(ATLAS_PREFIX, '').trim() || name
}

/**
 * One column per BRAND for shares_creative locations (ScanCo), one per location
 * otherwise — the exact grouping the Atlas board draws. AtlasBoard uses this same
 * function so the folders can never drift from the columns.
 */
export function buildAtlasColumns(locations: AtlasLocationLike[]): AtlasColumn[] {
  const out: AtlasColumn[] = []
  const groupIndex = new Map<string, number>()
  for (const loc of locations) {
    const brand = loc.advertiser_name?.trim()
    if (loc.shares_creative && brand) {
      const existing = groupIndex.get(brand)
      if (existing !== undefined) { out[existing].locationIds.push(loc.id); continue }
      groupIndex.set(brand, out.length)
      out.push({ key: `brand:${brand}`, title: `Atlas - ${brand}`, locationIds: [loc.id] })
    } else {
      out.push({ key: loc.id, title: loc.name, locationIds: [loc.id] })
    }
  }
  return out
}

/** Make one path segment safe on macOS/Windows/zip: no separators or reserved chars. */
export function safeFolderName(name: string, fallback = 'Unnamed'): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80)
    .trim()
  return cleaned || fallback
}

/** Case-insensitive de-dupe of a segment against ones already handed out. */
export function uniqueSegment(base: string, used: Map<string, number>): string {
  const key = base.toLowerCase()
  let n = (used.get(key) ?? 0) + 1
  // A suffixed name can itself be a real name ("Breast", "Breast", "Breast (2)"),
  // so keep counting until the result is unused, and reserve it too.
  while (n > 1 && used.has(`${key} (${n})`)) n++
  used.set(key, n)
  const name = n === 1 ? base : `${base} (${n})`
  if (n > 1) used.set(name.toLowerCase(), 1)
  return name
}

/**
 * Folder name per column key. Prefers the advertiser name ("Lakeside", "ScanCo"),
 * but MetroCare's practices share one, so a name that more than one column
 * would claim falls back to the practice's short location name. Any remaining
 * clash gets " (2)", " (3)".
 */
export function locationFolderNames(
  columns: AtlasColumn[],
  locations: AtlasLocationLike[],
): Map<string, string> {
  const locById = new Map(locations.map(l => [l.id, l]))
  const advertiserOf = (col: AtlasColumn): string =>
    locById.get(col.locationIds[0])?.advertiser_name?.trim() ?? ''

  const advertiserCount = new Map<string, number>()
  for (const col of columns) {
    const a = advertiserOf(col).toLowerCase()
    if (a) advertiserCount.set(a, (advertiserCount.get(a) ?? 0) + 1)
  }

  const used = new Map<string, number>()
  const result = new Map<string, string>()
  for (const col of columns) {
    const adv = advertiserOf(col)
    const loc = locById.get(col.locationIds[0])
    const raw = adv && advertiserCount.get(adv.toLowerCase()) === 1
      ? adv
      : shortLocationName(loc?.name ?? col.title)
    result.set(col.key, uniqueSegment(safeFolderName(raw), used))
  }
  return result
}

/** Focus as the board shows it: strip the "Atlas - <location> —" prefix and "(Social)" suffix. */
export function cardFocusName(
  card: Pick<AtlasBuildCard, 'title'>,
  loc: AtlasLocationLike | undefined,
  column: AtlasColumn | undefined,
): string {
  const candidates = [
    column?.title,
    loc?.name,
    loc?.advertiser_name?.trim() ? `Atlas - ${loc.advertiser_name.trim()}` : null,
  ].filter((c): c is string => !!c)
  for (const name of candidates) {
    if (card.title.toLowerCase().startsWith(name.toLowerCase())) return parseCardFocus(card.title, name)
  }
  return parseCardFocus(card.title, null)
}

/** The task list: two per card (Social, Display), links possibly null. */
export function planBuildTasks(
  cards: AtlasBuildCard[],
  locations: AtlasLocationLike[],
): BuildTask[] {
  const columns = buildAtlasColumns(locations)
  const locById = new Map(locations.map(l => [l.id, l]))
  const folderByCol = locationFolderNames(columns, locations)

  const focusUsed = new Map<string, Map<string, number>>()
  const tasks: BuildTask[] = []
  for (const col of columns) {
    const inCol = cards.filter(c => c.atlas_location_id && col.locationIds.includes(c.atlas_location_id))
    for (const card of inCol) {
      const loc = locById.get(card.atlas_location_id as string)
      const locationFolder = folderByCol.get(col.key) ?? 'Unnamed'
      const used = focusUsed.get(col.key) ?? new Map<string, number>()
      focusUsed.set(col.key, used)
      const focusFolder = uniqueSegment(safeFolderName(cardFocusName(card, loc, col), 'Focus'), used)
      for (const kind of ['Social', 'Display'] as const) {
        const raw = kind === 'Social' ? card.build_link : card.display_build_link
        tasks.push({
          cardId: card.id,
          locationFolder,
          focusFolder,
          kind,
          folderId: card.box_folder_id?.trim() || null,
          link: raw?.trim() || null,
          dir: `${locationFolder}/${focusFolder}/${kind}`,
        })
      }
    }
  }
  return tasks
}

/** One way to ask /api/box/download-build for a task's files. */
export type BuildAttempt =
  | { via: 'folder'; folderId: string }
  | { via: 'link'; link: string }

/**
 * How to fetch a task.
 *
 * Social: the card's Build folder (box_folder_id); build_link ONLY when no Build
 * folder is set. Display: display_build_link, the shared link the Box sync
 * stores for the card's Banner Ads Build folder. There is no folder-name
 * guessing — the sync already matched and linked it.
 */
export function buildAttempts(task: BuildTask): BuildAttempt[] {
  if (task.kind === 'Social') {
    if (task.folderId) return [{ via: 'folder', folderId: task.folderId }]
    return task.link ? [{ via: 'link', link: task.link }] : []
  }
  return task.link ? [{ via: 'link', link: task.link }] : []
}

export const NO_DISPLAY_BUILD = 'No Display build yet'
export const NO_SOCIAL_SOURCE = 'No Build folder synced and no build link on the card'

/** Reason when a task has nothing to try at all. */
export function noSourceReason(task: BuildTask): string {
  return task.kind === 'Social' ? NO_SOCIAL_SOURCE : NO_DISPLAY_BUILD
}

/** Query string for /api/box/download-build, exactly as the drawer calls it plus the folder mode. */
export function attemptQuery(task: BuildTask, a: BuildAttempt): string {
  const id = `cardId=${encodeURIComponent(task.cardId)}`
  const display = task.kind === 'Display' ? '&variant=display' : ''
  if (a.via === 'link') return `sharedLink=${encodeURIComponent(a.link)}&${id}${display}`
  return `folderId=${encodeURIComponent(a.folderId)}&${id}${display}`
}

export function missingRow(task: BuildTask, reason: string): MissingRow {
  return { location: task.locationFolder, focus: task.focusFolder, kind: task.kind, reason }
}

export function formatMissingTxt(rows: MissingRow[], downloaded: number, label: string): string {
  const head = [
    `Atlas Builds — ${label}: builds that could not be included`,
    `Downloaded: ${downloaded}   Missing: ${rows.length}`,
    '',
  ]
  if (rows.length === 0) return [...head, 'Nothing missing.'].join('\n') + '\n'
  const lines = rows.map(r => `${r.location} | ${r.focus} | ${r.kind} | ${r.reason}`)
  return [...head, 'Location | Focus | Type | Reason', ...lines].join('\n') + '\n'
}

export function quarterLabel(d: Date): string {
  return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`
}

export function masterZipName(label: string): string {
  return `Atlas Builds — ${label}.zip`
}
