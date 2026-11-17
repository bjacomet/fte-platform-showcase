'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { FULL_CARD_SELECT } from '@/lib/cardQueries'
import type { Card, Client, AtlasBoardCard, AtlasBoardColumn, AtlasBoardSettings, AtlasCardFields, AtlasLocation, WorkStatus } from '@/types'
import CardDrawer from '../CardDrawer'
import AnimatedBackground, { type MotionPreset } from '../AnimatedBackground'
import BoardMenu from '../BoardMenu'
import AtlasBoxSyncPanel from './AtlasBoxSyncPanel'
import AtlasCard, { shortLocationName } from './AtlasCard'
import AtlasStageBoard from './AtlasStageBoard'
import AtlasBoardCustomize, { type AutoMove } from './AtlasBoardCustomize'
import { toAtlasBoardCard } from '@/lib/atlasBoardCard'
import { ALL_QUARTERS, effectiveQuarter, filterByQuarter, quarterOptions } from '@/lib/atlasQuarterFilter'
import { resolveCardFields, sortColumns, stageForCard } from '@/lib/atlasStages'
import JSZip from 'jszip'
import {
  attemptQuery, buildAttempts, buildAtlasColumns, formatMissingTxt, masterZipName, missingRow, noSourceReason,
  planBuildTasks, quarterLabel,
  type AtlasBuildCard, type MissingRow,
} from '@/lib/atlasBuildsZip'

// Filter chips. 'no_file' is not a work_status — it is the state the bulk
// Send-to-Adviewer silently skips, so it is worth being able to pull up on
// demand rather than discovering it in the skip counter after a send.
const FILTER_CHIPS: [WorkStatus | 'all' | 'no_file', string][] = [
  ['all', 'All'],
  ['in_design', 'In design'],
  ['internal_review', 'Internal review'],
  ['pending_approval', 'Pending approval'],
  ['complete', 'Complete'],
  ['no_file', 'No file'],
]

// "Does this card have a creative attached?" — ONE definition, because two
// surfaces answer it and they used to disagree. The chip counted
// preview_image_url as a file; the bulk Send-to-Adviewer pre-check looked only
// at card_files. A card with a manual preview image and no file row therefore
// showed as ready on the chip and was silently skipped by the send, which is
// exactly the discrepancy the chip exists to surface. Bulk send is the
// authority — it is the thing that actually fails — so the chip follows it.
// An empty file_url counts as no file: it is what resolveThumb falls through on.
function hasAttachedFile(card: AtlasBoardCard): boolean {
  return (card.card_files ?? []).some((f) => !!f.file_url)
}

// Same unified FTE-blue accent the main board columns use (KanbanColumn.COLUMN_ACCENT).
const COLUMN_ACCENT = { top: '#0075a9', title: '#38b6ff', drag: 'rgba(0,117,169,0.22)' } as const

interface Props {
  locations: AtlasLocation[]
  initialCards: AtlasBoardCard[]
  /**
   * Set when the server's card query failed rather than genuinely returning
   * nothing. Without it the two are indistinguishable on screen — see the banner
   * below and the comment in app/atlas/page.tsx.
   */
  cardsError?: string | null
  /** The cards loaded without atlas_quarter / atlas_year (migration not applied): hide the Quarter filter. */
  quarterColumnsMissing?: boolean
  clients: Client[]
  /** The Atlas board's own background, or the FTE board's when it has none. */
  backgroundUrl: string
  stageColumns: AtlasBoardColumn[]
  /** Set when atlas_board_columns could not be read — usually the migration is not applied yet. */
  stagesError: string | null
  atlasSettings: AtlasBoardSettings | null
  userEmail: string
}

type BoardView = 'stages' | 'locations'
const VIEW_KEY = 'atlas-board-view'
const QUARTER_KEY = 'atlas-board-quarter'
const MOVE_CHUNK = 200

type SettingsPatch = Partial<Pick<AtlasBoardSettings, 'background_url' | 'card_fields' | 'review_column_id' | 'changes_column_id'>>


// Bulk publish-to-Adviewer state. BULK_IDLE is the single empty literal every reset
// goes through, so adding a counter cannot leave one of them behind.
type BulkState = {
  phase: 'idle' | 'checking' | 'confirm' | 'sending' | 'done'
  ready: string[]      // card ids with a file attached and no Adviewer link yet
  noFile: number       // skipped: nothing uploaded, so the reviewer would see an empty creative
  internal: number     // skipped: internal Display build, never shown to the client
  alreadySent: number  // skipped: already has a link
  sent: number
  failed: number
  error?: string
}

const BULK_IDLE: BulkState = {
  phase: 'idle', ready: [], noFile: 0, internal: 0, alreadySent: 0, sent: 0, failed: 0,
}

export default function AtlasBoard({
  locations, initialCards, cardsError = null, quarterColumnsMissing = false, clients, backgroundUrl: initialBackground,
  stageColumns: initialStageColumns, stagesError, atlasSettings, userEmail,
}: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [cards, setCards] = useState<AtlasBoardCard[]>(initialCards)
  // Read by moveCards to restore positions on a failed write without making the
  // callback depend on (and re-create with) every card change.
  const cardsRef = useRef(cards)
  useEffect(() => { cardsRef.current = cards }, [cards])

  // ── Stages view + customization ─────────────────────────────────────────────
  // All of this is Atlas-only: atlas_board_columns / atlas_board_settings / cards.atlas_column_id.
  // Nothing here reads or writes the FTE board's columns or its background key.
  const [stageColumns, setStageColumns] = useState<AtlasBoardColumn[]>(() => sortColumns(initialStageColumns))
  const [cardFields, setCardFields] = useState<AtlasCardFields>(() => resolveCardFields(atlasSettings?.card_fields))
  // Which stage the cards_atlas_auto_stage trigger moves a card to (null = don't
  // move). The DB does the move; this copy only lets the board mirror it on
  // screen without a reload, and drives the two pickers in Customize.
  const [autoMove, setAutoMove] = useState<AutoMove>(() => ({
    review: atlasSettings?.review_column_id ?? null,
    changes: atlasSettings?.changes_column_id ?? null,
  }))
  const [backgroundUrl, setBackgroundUrl] = useState(initialBackground)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [bgMenuOpen, setBgMenuOpen] = useState(false)
  const [stageError, setStageError] = useState<string | null>(null)
  // Stages is the default; the choice is remembered per browser only (a
  // convenience, not shared state), and the storage read can throw in private
  // windows, so it is guarded and the board works without it.
  const [view, setView] = useState<BoardView>('stages')
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_KEY)
      if (saved === 'stages' || saved === 'locations') setView(saved)
    } catch { /* storage unavailable — keep the default */ }
  }, [])
  function changeView(next: BoardView) {
    setView(next)
    try { window.localStorage.setItem(VIEW_KEY, next) } catch { /* see above */ }
  }

  // Quarter filter — By location view only. Remembered per browser (a convenience,
  // so the storage read is guarded like the view's). Stages stays unfiltered.
  const [storedQuarter, setStoredQuarter] = useState<string | null>(null)
  useEffect(() => {
    try { setStoredQuarter(window.localStorage.getItem(QUARTER_KEY)) } catch { /* storage unavailable */ }
  }, [])
  function changeQuarter(next: string) {
    setStoredQuarter(next)
    try { window.localStorage.setItem(QUARTER_KEY, next) } catch { /* see above */ }
  }
  const quarters = useMemo(() => quarterOptions(cards), [cards])
  const quarter = quarterColumnsMissing ? ALL_QUARTERS : effectiveQuarter(storedQuarter, quarters)

  // Optimistic, then written; on failure the cards go back where they were and
  // the error is shown — a card silently snapping back would read as a glitch.
  //
  // Chunked (200 ids per .in(), well under URL limits), and a failure rolls back
  // ONLY the chunks that did not save. Rolling back everything left the screen
  // disagreeing with the table on a >200-card move whose later chunk failed:
  // the earlier chunks were saved but shown in their old stage (#110 review).
  const moveCards = useCallback(async (ids: string[], columnId: string): Promise<string | null> => {
    if (ids.length === 0) return null
    const idSet = new Set(ids)
    const before = new Map(cardsRef.current.filter((c) => idSet.has(c.id)).map((c) => [c.id, c.atlas_column_id]))
    setCards((prev) => prev.map((c) => (idSet.has(c.id) ? { ...c, atlas_column_id: columnId } : c)))
    setStageError(null)
    for (let i = 0; i < ids.length; i += MOVE_CHUNK) {
      const { error } = await supabase.from('cards').update({ atlas_column_id: columnId }).in('id', ids.slice(i, i + MOVE_CHUNK))
      if (error) {
        const unsaved = new Set(ids.slice(i))
        setCards((prev) => prev.map((c) => (unsaved.has(c.id) ? { ...c, atlas_column_id: before.get(c.id) ?? null } : c)))
        const msg = i === 0
          ? `Could not move ${ids.length === 1 ? 'the card' : 'the cards'}: ${error.message}`
          : `Moved ${i} of ${ids.length} cards; the other ${ids.length - i} could not be moved: ${error.message}`
        setStageError(msg)
        return msg
      }
    }
    return null
  }, [supabase])

  // Settings writes go through ONE queue. Each save sends the full value it was
  // called with, so running them strictly in order means the last click is the
  // last write — fired in parallel, two quick toggles could land out of order
  // and leave the older value saved (#110 review).
  const settingsQueue = useRef<Promise<void>>(Promise.resolve())
  function saveSettings(patch: SettingsPatch): Promise<void> {
    const run = async () => {
      const { error } = await supabase
        .from('atlas_board_settings')
        .upsert({ id: true, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' })
      if (error) setStageError(`Could not save board settings: ${error.message}`)
    }
    settingsQueue.current = settingsQueue.current.then(run, run)
    return settingsQueue.current
  }

  function changeAutoMove(next: AutoMove) {
    setAutoMove(next)
    void saveSettings({ review_column_id: next.review, changes_column_id: next.changes })
  }

  function changeFields(next: AtlasCardFields) {
    setCardFields(next)
    void saveSettings({ card_fields: next })
  }

  // Every card's effective stage, from ALL cards (not the filtered set) — the
  // delete confirmation has to count every card it is about to move.
  const cardsByStage = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const c of cards) {
      const stage = stageForCard(c.atlas_column_id, stageColumns)
      if (!stage) continue
      const arr = map.get(stage) ?? []
      arr.push(c.id)
      map.set(stage, arr)
    }
    return map
  }, [cards, stageColumns])
  const stageCounts = useMemo(() => new Map([...cardsByStage].map(([k, v]) => [k, v.length])), [cardsByStage])

  async function deleteStage(columnId: string, targetId: string): Promise<string | null> {
    // Move by effective stage, not by stored id: cards with no stage render in
    // the first column, so deleting the first column has to carry them too.
    const ids = cardsByStage.get(columnId) ?? []
    const moveErr = await moveCards(ids, targetId)
    if (moveErr) return moveErr
    const { error } = await supabase.from('atlas_board_columns').delete().eq('id', columnId)
    if (error) return `Cards moved, but the column could not be deleted: ${error.message}`
    setStageColumns((prev) => prev.filter((c) => c.id !== columnId))
    // The FK is ON DELETE SET NULL, so a deleted stage that was an auto-move
    // target has already turned that move off in the table; mirror it.
    setAutoMove((m) => ({
      review: m.review === columnId ? null : m.review,
      changes: m.changes === columnId ? null : m.changes,
    }))
    return null
  }
  const [selectedCard, setSelectedCard] = useState<Card | null>(null)
  // Search + status filter. The board had neither: with 23 columns off the
  // right edge, finding one location meant scrolling blind past twenty others.
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<WorkStatus | 'all' | 'no_file'>('all')

  // Counts come from ALL cards, never the filtered set: a chip that renumbers
  // itself as you filter can't be used to navigate.
  // Cards in scope for the current view: the quarter filter applies to By location
  // only, and cards with no quarter appear only under "All quarters". Counts, the
  // header line and the filters all read this one list so they match the screen.
  const quarterFiltering = view === 'locations' && quarter !== ALL_QUARTERS
  const scopedCards = useMemo(
    () => (view === 'locations' ? filterByQuarter(cards, quarter) : cards),
    [cards, view, quarter],
  )
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: scopedCards.length, no_file: 0 }
    for (const c of scopedCards) {
      if (c.work_status) counts[c.work_status] = (counts[c.work_status] ?? 0) + 1
      if (!hasAttachedFile(c)) counts.no_file += 1
    }
    return counts
  }, [scopedCards])

  const locationNameById = useMemo(
    () => new Map(locations.map((l) => [l.id, l.name.toLowerCase()])),
    [locations],
  )

  // Status is a property of a CARD, so it filters cards. Search is a question
  // about a LOCATION, so it filters columns (below) — see columnMatchesQuery.
  const statusCards = useMemo(() => {
    return scopedCards.filter((c) => {
      if (statusFilter === 'no_file') return !hasAttachedFile(c)
      if (statusFilter !== 'all' && c.work_status !== statusFilter) return false
      return true
    })
  }, [scopedCards, statusFilter])

  const cardsByLocation = useMemo(() => {
    const map = new Map<string, AtlasBoardCard[]>()
    for (const c of statusCards) {
      if (!c.atlas_location_id) continue
      const arr = map.get(c.atlas_location_id) ?? []
      arr.push(c)
      map.set(c.atlas_location_id, arr)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position)
    return map
  }, [statusCards])

  const filtering = query.trim() !== '' || statusFilter !== 'all'

  /**
   * Columns are one per BRAND, not one per location row.
   *
   * A shared-creative brand ships ONE build for every practice under it (ScanCo
   * today), so the importer already makes one card per (advertiser_name, focus)
   * rather than one per (location, focus) — ScanCo's sheet rows become one card per focus.
   * Those cards each carry the atlas_location_id of whichever practice's sheet
   * row created them, so rendering a column per location scattered them across
   * two of ScanCo's five columns and left the other three showing "No cards".
   *
   * Grouping by advertiser_name for shares_creative brands gives the board the
   * shape the work actually has: one `Atlas - ScanCo` column holding Branded,
   * Beta-Amyloid, PSMA and FDG.
   *
   * Only shares_creative collapses. MetroCare's practices share an advertiser NAME
   * but each has its own Box build folder and its own graphics, so they stay as
   * separate columns — merging them would hide per-practice creative behind one
   * heading. That distinction is exactly why advertiser_name and shares_creative
   * are two fields and not one.
   */
  const columns = useMemo(() => buildAtlasColumns(locations), [locations])

  // Cards for a column = the union across its locations. Deduped by id because a
  // shared card is reused, not copied: the same row can be reachable from more
  // than one location in the group if a future import ever repoints it.
  const cardsForColumn = useMemo(() => {
    const map = new Map<string, AtlasBoardCard[]>()
    for (const col of columns) {
      const seen = new Set<string>()
      const arr: AtlasBoardCard[] = []
      for (const id of col.locationIds) {
        for (const c of cardsByLocation.get(id) ?? []) {
          if (seen.has(c.id)) continue
          seen.add(c.id)
          arr.push(c)
        }
      }
      arr.sort((a, b) => a.position - b.position)
      map.set(col.key, arr)
    }
    return map
  }, [columns, cardsByLocation])

  // With a filter on, a column holding no match is dropped entirely rather than
  // rendered as an empty panel — otherwise filtering to 3 results still leaves
  // you scrolling past 20 empty columns, which is the problem it was meant to
  // solve. This filters COLUMNS, not locations: a shares_creative brand column
  // unions several locations' cards, so a location that contributes no match can
  // still belong to a column that has one.
  //
  // Search matches the COLUMN, not the individual card, and that distinction is
  // the whole fix. A card carries one atlas_location_id — the practice whose sheet
  // row created it — but a shares_creative brand column unions several practices
  // (ScanCo's practices share cards, so at least one practice's id is on
  // no card at all). Matching per card meant typing that practice's name returned
  // nothing, the ScanCo column dropped out, and the board said there was no creative
  // for that location when `Atlas - ScanCo` covers it — #91's scattering bug, back at
  // the search level. The column's own title was not searched either, so typing
  // the header text you can see on screen also found nothing.
  const columnMatchesQuery = useCallback(
    (col: { title: string; locationIds: string[] }, q: string) => {
      if (!q) return true
      if (col.title.toLowerCase().includes(q)) return true
      if (col.locationIds.some((id) => (locationNameById.get(id) ?? '').includes(q))) return true
      return false
    },
    [locationNameById],
  )

  const visibleColumns = useMemo(() => {
    const q = query.trim().toLowerCase()
    return columns.filter((col) => {
      const colCards = cardsForColumn.get(col.key) ?? []
      // A status filter with no matches empties the column — drop it rather than
      // render an empty panel you have to scroll past.
      if (statusFilter !== 'all' && colCards.length === 0) return false
      if (!q) return true
      // A card title still matches on its own: focuses ("Prostate", "Branded")
      // are what you search for as often as locations.
      return columnMatchesQuery(col, q) || colCards.some((c) => c.title.toLowerCase().includes(q))
    })
  }, [columns, cardsForColumn, query, statusFilter, columnMatchesQuery])

  // What is actually on screen. ONE map, used by the render, the counter and the
  // bulk send, so those three can never disagree about what "visible" means.
  const visibleCardsByColumn = useMemo(() => {
    const q = query.trim().toLowerCase()
    const map = new Map<string, AtlasBoardCard[]>()
    for (const col of visibleColumns) {
      const colCards = cardsForColumn.get(col.key) ?? []
      // Once a column matches by name, every creative in it is shown — you asked
      // for that location, not for one of its focuses.
      const byName = columnMatchesQuery(col, q)
      map.set(col.key, !q || byName ? colCards : colCards.filter((c) => c.title.toLowerCase().includes(q)))
    }
    return map
  }, [visibleColumns, cardsForColumn, query, columnMatchesQuery])

  const locationVisibleCards = useMemo(
    () => visibleColumns.flatMap((col) => visibleCardsByColumn.get(col.key) ?? []),
    [visibleColumns, visibleCardsByColumn],
  )

  // In the Stages view a card names its location with the same label the By
  // location view uses for its column — the brand group for shares_creative
  // brands (Atlas - ScanCo), the practice otherwise — so the two views agree.
  const columnTitleByLocation = useMemo(() => {
    const map = new Map<string, string>()
    for (const col of columns) for (const id of col.locationIds) map.set(id, col.title)
    return map
  }, [columns])
  const locationNameFor = useCallback(
    (card: AtlasBoardCard) => (card.atlas_location_id ? columnTitleByLocation.get(card.atlas_location_id) : undefined) ?? '',
    [columnTitleByLocation],
  )

  // Stages: search matches the card's title, its location column title, or the
  // practice name it came from — the same three things the location view searches.
  const stageVisibleCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return statusCards
    return statusCards.filter((c) =>
      c.title.toLowerCase().includes(q)
      || locationNameFor(c).toLowerCase().includes(q)
      || (c.atlas_location_id ? (locationNameById.get(c.atlas_location_id) ?? '') : '').includes(q),
    )
  }, [statusCards, query, locationNameFor, locationNameById])

  const stagesReady = !stagesError && stageColumns.length > 0
  const showingStages = view === 'stages'
  // What is on screen in whichever view is showing. The counter, the bulk send
  // and the bulk move all read this, so they always agree with the screen.
  const visibleCards = showingStages ? stageVisibleCards : locationVisibleCards
  const [moveTarget, setMoveTarget] = useState('')
  const [moving, setMoving] = useState(false)
  async function moveShown() {
    if (!moveTarget) return
    setMoving(true)
    const err = await moveCards(visibleCards.map((c) => c.id), moveTarget)
    setMoving(false)
    if (!err) setMoveTarget('')
  }

  // ── Download all builds ───────────────────────────────────────────────────
  // Assembled in the browser: a quarter is hundreds of MB, far past what one
  // serverless response can carry. Each card goes through the existing
  // /api/box/download-build route exactly as the drawer's two buttons call it.
  type BuildsState = {
    running: boolean
    done: number
    total: number
    current: string
    summary: { downloaded: number; missing: number } | null
    error: string | null
  }
  const [builds, setBuilds] = useState<BuildsState>({ running: false, done: 0, total: 0, current: '', summary: null, error: null })
  const buildsRunning = useRef(false)

  useEffect(() => {
    if (!builds.running) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [builds.running])

  async function downloadAllBuilds() {
    if (buildsRunning.current) return
    buildsRunning.current = true
    setBuilds({ running: true, done: 0, total: 0, current: 'Loading cards…', summary: null, error: null })
    try {
      // Fresh read, not board state: the slim board cards carry no build_link and
      // may be stale. Always every live Atlas social card — not the filtered view.
      const { data, error } = await supabase
        .from('cards')
        .select('id, title, atlas_location_id, build_link, display_build_link, box_folder_id')
        .not('atlas_location_id', 'is', null)
        .eq('archived', false)
        .eq('media_type', 'Social Ad Request')
      if (error) throw new Error(error.message)
      const tasks = planBuildTasks((data ?? []) as AtlasBuildCard[], locations)
      if (tasks.length === 0) throw new Error('No live Atlas social cards found.')

      const master = new JSZip()
      const missing: MissingRow[] = []
      let downloaded = 0
      setBuilds(b => ({ ...b, total: tasks.length }))

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]
        setBuilds(b => ({ ...b, done: i, current: `${t.locationFolder} / ${t.focusFolder} / ${t.kind}…` }))
        const attempts = buildAttempts(t)
        if (attempts.length === 0) { missing.push(missingRow(t, noSourceReason(t))); continue }
        let reason = 'Download failed'
        let got = false
        for (const attempt of attempts) {
          try {
            const res = await fetch(`/api/box/download-build?${attemptQuery(t, attempt)}`)
            if (!res.ok) {
              const json = await res.json().catch(() => ({})) as { error?: string }
              throw new Error(json.error ?? `Download failed (${res.status})`)
            }
            const inner = await JSZip.loadAsync(await res.arrayBuffer())
            let files = 0
            for (const entry of Object.values(inner.files)) {
              if (entry.dir) continue
              master.file(`${t.dir}/${entry.name}`, await entry.async('uint8array'))
              files++
            }
            if (files === 0) throw new Error('Zip was empty')
            got = true
            break
          } catch (err) {
            reason = err instanceof Error ? err.message : 'Download failed'
          }
        }
        if (got) downloaded++
        else missing.push(missingRow(t, reason))
      }

      const label = quarterLabel(new Date())
      master.file('MISSING.txt', formatMissingTxt(missing, downloaded, label))
      setBuilds(b => ({ ...b, done: tasks.length, current: 'Zipping…' }))
      // STORE: MP4/GIF/PNG are already compressed, deflating them only burns CPU.
      const blob = await master.generateAsync({ type: 'blob', compression: 'STORE' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = masterZipName(label)
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setBuilds({ running: false, done: tasks.length, total: tasks.length, current: '', summary: { downloaded, missing: missing.length }, error: null })
    } catch (err) {
      setBuilds(b => ({ ...b, running: false, current: '', error: err instanceof Error ? err.message : 'Download failed' }))
    } finally {
      buildsRunning.current = false
    }
  }

  // ── Bulk publish to Adviewer ──────────────────────────────────────────────
  // Atlas cards have no column, so the usual "Ready for Adviewer" drop can never
  // fire for them and each card is published individually from the drawer. For a
  // quarterly refresh that is ~85 trips through the drawer, so this does the same
  // thing in one pass — over exactly the cards that are ready for it.
  const [bulk, setBulk] = useState<BulkState>(BULK_IDLE)
  const [boxSyncOpen, setBoxSyncOpen] = useState(false)
  const router = useRouter()

  // Work out what WOULD be sent, and show it for confirmation before anything is
  // published. Deliberately not window.confirm: a native dialog blocks the page.
  async function prepareBulkSend() {
    setBulk({ ...BULK_IDLE, phase: 'checking' })

    // Atlas Display cards are the internal HTML5 build — AtlasWorkspaceClient creates them
    // with client_portal_status null and "never surfaced in client review" — but the
    // campaign page (app/adviewer/c/[token]) renders every card in the campaign and
    // applies no such filter. Publishing them in bulk would put the internal build on
    // the client's review link the moment a designer uploads it, so they are excluded
    // here; the drawer's per-card button still publishes one deliberately if needed.
    // visibleCards, not cards: with a filter on, the button sits under a board
    // showing three columns and said "Send all", then published all sixty. The
    // confirm step caught it, but only because someone read the number.
    const scope = visibleCards
    const publishable = scope.filter((c) => c.media_type !== 'Display Request')
    const internal = scope.length - publishable.length

    const unsent = publishable.filter((c) => !c.adpiler_preview_url)
    const alreadySent = publishable.length - unsent.length

    if (unsent.length === 0) {
      setBulk({ ...BULK_IDLE, phase: 'done', internal, alreadySent })
      return
    }

    // Which of those actually have a creative attached? The board's slim select
    // carries no file info, and preview_image_url is not a reliable stand-in, so
    // ask card_files directly.
    // Paged, and chunked by card id. A plain .in() over every card would silently
    // stop at PostgREST's 1000-row default cap once the board carries that many
    // file rows, and cards whose rows fell past the cap would be misread as having
    // no creative and quietly skipped — an under-send with no error to notice.
    const withFile = new Set<string>()
    const ID_CHUNK = 200
    const PAGE = 1000
    const unsentIds = unsent.map((c) => c.id)

    for (let i = 0; i < unsentIds.length; i += ID_CHUNK) {
      const chunk = unsentIds.slice(i, i + ID_CHUNK)
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('card_files')
          // file_url, not just card_id: a row with an empty file_url is not a
          // creative, and counting it here would disagree with the "No file"
          // chip and with what the tile draws.
          .select('card_id, file_url')
          // Ordered because the paging below is range-based: Postgres gives no
          // stable row order without it, so successive pages could repeat or SKIP
          // rows — and a skipped row reads as "no creative", the exact under-send
          // the paging is here to prevent.
          .order('card_id', { ascending: true })
          .in('card_id', chunk)
          .range(from, from + PAGE - 1)

        if (error) {
          setBulk({ ...BULK_IDLE, internal, alreadySent, error: `Could not check attached files: ${error.message}` })
          return
        }

        for (const row of (data ?? []) as { card_id: string; file_url: string | null }[]) {
          if (row.file_url) withFile.add(row.card_id)
        }
        if (!data || data.length < PAGE) break
      }
    }
    const ready = unsent.filter((c) => withFile.has(c.id)).map((c) => c.id)

    setBulk({
      ...BULK_IDLE,
      phase: 'confirm',
      ready,
      noFile: unsent.length - ready.length,
      internal,
      alreadySent,
    })
  }

  async function runBulkSend() {
    setBulk((b) => ({ ...b, phase: 'sending', sent: 0, failed: 0 }))
    let sent = 0
    let failed = 0
    const links = new Map<string, string>()

    // Sequential on purpose: generateAdviewerForCard finds-or-creates the client's
    // open campaign, so parallel calls would race and create duplicate campaigns.
    for (const id of bulk.ready) {
      try {
        const res = await fetch('/api/adviewer/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ card_id: id }),
        })
        const json = (await res.json()) as { previewUrl?: string; error?: string }
        if (res.ok && json.previewUrl) {
          links.set(id, json.previewUrl)
          sent += 1
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
      setBulk((b) => ({ ...b, sent, failed }))
    }

    // Reflect the new links on the tiles without a reload — the "View in Adviewer"
    // pill reads adpiler_preview_url.
    // The first send also moves each card to the review stage — the DB trigger
    // already did that; this mirrors it so the board matches without a reload.
    if (links.size > 0) {
      const reviewStage = autoMove.review
      setCards((prev) => prev.map((c) => (links.has(c.id)
        ? { ...c, adpiler_preview_url: links.get(c.id)!, atlas_column_id: reviewStage ?? c.atlas_column_id }
        : c)))
    }
    setBulk((b) => ({ ...b, phase: 'done', sent, failed }))
  }

  async function openCard(id: string) {
    const { data, error } = await supabase
      .from('cards')
      .select(FULL_CARD_SELECT)
      .eq('id', id)
      .single()
    if (error || !data) return
    setSelectedCard(data as Card)
  }

  function handleUpdated(updated: Card) {
    setCards((prev) => prev.map((c) => (c.id === updated.id ? toAtlasBoardCard(updated, c) : c)))
    setSelectedCard(updated)
    void refreshCardFiles(updated.id)
  }

  // The drawer's refetch cannot carry card_files (FULL_CARD_SELECT has no join
  // for them), and a file can have been added or removed while the drawer was
  // open. One narrow query keeps the thumbnail honest without re-reading the
  // board. Failure is silent on purpose: the card keeps the files it had.
  async function refreshCardFiles(cardId: string) {
    const { data, error } = await supabase
      .from('card_files')
      .select('id, file_url, file_type, created_at')
      .eq('card_id', cardId)
      .order('created_at', { ascending: true })
    if (error || !data) return
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, card_files: data } : c)))
  }

  function handleDeleted(cardId: string) {
    setCards((prev) => prev.filter((c) => c.id !== cardId))
    setSelectedCard(null)
  }

  // Same background treatment as the main FTE board (see components/Board.tsx):
  // a photo with a dark scrim, or an animated motion preset over a dark base.
  const isMotionBackground = backgroundUrl.startsWith('motion:')
  const motionPreset = (isMotionBackground ? backgroundUrl.slice(7) : 'aurora') as MotionPreset

  return (
    <div
      className="relative w-full min-h-[calc(100vh-64px)] overflow-hidden"
      style={
        isMotionBackground
          ? { backgroundColor: '#07090f' }
          : backgroundUrl
            ? { backgroundImage: `url(${backgroundUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { backgroundColor: '#0f1117' }
      }
    >
      {isMotionBackground && (
        <div className="absolute inset-0 z-0 pointer-events-none">
          <AnimatedBackground preset={motionPreset} />
        </div>
      )}
      {backgroundUrl && !isMotionBackground && (
        <div className="absolute inset-0 bg-black/45 pointer-events-none" />
      )}

      <div className="relative z-10 px-6 py-6 space-y-4">
        {/* An empty board and a failed query look identical, and the failure is
            the likelier of the two on a fresh deploy: ATLAS_BOARD_CARD_SELECT names
            display_build_link, so until supabase/add_display_build_link.sql is
            applied every card silently disappears. Say so rather than implying
            the creatives are gone. */}
        {cardsError && quarterColumnsMissing && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3">
            <p className="text-sm font-semibold text-amber-200">Quarter filter is off — the board is showing every card.</p>
            <p className="text-xs text-amber-200/70 mt-1">
              The atlas_quarter / atlas_year columns are missing. Apply supabase/add_atlas_card_quarter.sql, then reload.
            </p>
          </div>
        )}
        {cardsError && !quarterColumnsMissing && (
          <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3">
            <p className="text-sm font-semibold text-rose-200">Cards could not be loaded — this board is not empty.</p>
            <p className="text-xs text-rose-200/70 mt-1">
              {cardsError.includes('display_build_link')
                ? 'The display_build_link column is missing. Apply supabase/add_display_build_link.sql, then reload.'
                : cardsError.includes('atlas_quarter') || cardsError.includes('atlas_year')
                  ? 'The atlas_quarter / atlas_year columns are missing. Apply supabase/add_atlas_card_quarter.sql, then reload.'
                  : cardsError}
            </p>
          </div>
        )}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-lg font-semibold text-white">Board</h2>
              <div className="inline-flex rounded-lg border border-white/15 bg-black/40 p-0.5" role="tablist" aria-label="Board view">
                {([['stages', 'Stages'], ['locations', 'By location']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={view === value}
                    onClick={() => changeView(value)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                      view === value ? 'bg-[#0075a9] text-white' : 'text-white/55 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {!showingStages && !quarterColumnsMissing && quarters.length > 0 && (
                <label className="flex items-center gap-1.5 text-xs text-gray-300">
                  Quarter
                  <select
                    value={quarter}
                    onChange={(e) => changeQuarter(e.target.value)}
                    className="bg-black/40 border border-white/15 rounded-lg px-2 py-1 text-xs font-semibold text-white"
                  >
                    {quarters.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    <option value={ALL_QUARTERS}>All quarters</option>
                  </select>
                </label>
              )}
              <button
                onClick={() => setCustomizeOpen(true)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-white/20 text-gray-200 hover:border-white/40 transition-colors"
              >
                Customize board
              </button>
            </div>
            <p className="text-gray-300 text-sm mt-1">
              {scopedCards.length} card{scopedCards.length !== 1 ? 's' : ''} across {quarterFiltering ? new Set(scopedCards.map((c) => c.atlas_location_id)).size : locations.length} location{(quarterFiltering ? new Set(scopedCards.map((c) => c.atlas_location_id)).size : locations.length) !== 1 ? 's' : ''}{quarterFiltering ? ` in ${quarters.find((o) => o.key === quarter)?.label ?? ''}` : ''} — kept off the main FTE board
            </p>
          </div>

          {cards.length > 0 && (
            <div className="flex-none text-right">
              {bulk.phase === 'idle' && (
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => setBoxSyncOpen((v) => !v)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-white/20 text-gray-200 hover:border-white/40 transition-colors"
                  >
                    {boxSyncOpen ? 'Hide Box sync' : 'Sync creatives from Box'}
                  </button>
                  <button
                    onClick={downloadAllBuilds}
                    disabled={builds.running}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-white/20 text-gray-200 hover:border-white/40 disabled:opacity-50 transition-colors"
                  >
                    {builds.running ? 'Downloading…' : 'Download all builds'}
                  </button>
                  <button
                    onClick={prepareBulkSend}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-opacity hover:opacity-90"
                    style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
                  >
                    {filtering || quarterFiltering ? `Send ${visibleCards.length} shown to Adviewer` : 'Send all to Adviewer'}
                  </button>
                </div>
              )}
              {(builds.running || builds.summary || builds.error) && (
                <div className="mt-1 max-w-sm text-left space-y-0.5">
                  {builds.running && (
                    <p className="text-[11px] text-gray-200">
                      {builds.total > 0 ? `${Math.min(builds.done + 1, builds.total)}/${builds.total} — ` : ''}{builds.current} Keep this tab open.
                    </p>
                  )}
                  {builds.summary && (
                    <p className="text-[11px] text-gray-200">
                      {builds.summary.downloaded} downloaded
                      {builds.summary.missing > 0 && <span className="text-amber-300"> · {builds.summary.missing} missing (listed in MISSING.txt)</span>}
                    </p>
                  )}
                  {builds.error && <p className="text-[11px] text-red-300">{builds.error}</p>}
                </div>
              )}
              <p className="text-[10px] text-gray-500 mt-1 max-w-sm">
                Downloads every live Atlas social card, ignoring the search and filters.
              </p>
              {bulk.phase === 'checking' && <span className="text-xs text-gray-300">Checking which cards are ready…</span>}

              {bulk.phase === 'confirm' && (
                <div className="rounded-lg border border-white/15 bg-black/50 p-3 text-left max-w-sm space-y-2">
                  <p className="text-xs text-gray-200">
                    Publish <span className="font-semibold text-white">{bulk.ready.length}</span> card{bulk.ready.length !== 1 ? 's' : ''} to Adviewer.
                  </p>
                  {bulk.noFile > 0 && (
                    <p className="text-[11px] text-amber-300">
                      Skipping {bulk.noFile} with no file attached — they would show the reviewer an empty creative. Upload the MP4 first, then run this again.
                    </p>
                  )}
                  {bulk.internal > 0 && (
                    <p className="text-[11px] text-gray-400">
                      Skipping {bulk.internal} internal display build{bulk.internal !== 1 ? 's' : ''} — those are not for the client review link.
                    </p>
                  )}
                  {bulk.alreadySent > 0 && (
                    <p className="text-[11px] text-gray-400">{bulk.alreadySent} already published; leaving them alone.</p>
                  )}
                  <p className="text-[11px] text-gray-400">
                    All of these join one campaign on one link — right for the first review, but that link shows every location&apos;s creative.
                  </p>
                  <div className="flex gap-2 pt-0.5">
                    <button
                      onClick={runBulkSend}
                      disabled={bulk.ready.length === 0}
                      className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-40 transition-opacity hover:opacity-90"
                      style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
                    >
                      Send {bulk.ready.length}
                    </button>
                    <button
                      onClick={() => setBulk(BULK_IDLE)}
                      className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 border border-gray-700 text-gray-300 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {bulk.phase === 'sending' && (
                <span className="text-xs text-gray-200">
                  Sending {bulk.sent + bulk.failed} of {bulk.ready.length}…
                </span>
              )}

              {bulk.phase === 'done' && (
                <div className="rounded-lg border border-white/15 bg-black/50 p-3 text-left max-w-sm space-y-1">
                  <p className="text-xs text-gray-200">
                    {bulk.sent > 0 ? `Published ${bulk.sent} card${bulk.sent !== 1 ? 's' : ''}.` : 'Nothing to publish.'}
                    {bulk.failed > 0 && <span className="text-red-300"> {bulk.failed} failed — open those cards and send individually.</span>}
                  </p>
                  {bulk.noFile > 0 && (
                    <p className="text-[11px] text-amber-300">{bulk.noFile} still waiting on a file.</p>
                  )}
                  {bulk.internal > 0 && (
                    <p className="text-[11px] text-gray-400">
                      {bulk.internal} internal display build{bulk.internal !== 1 ? 's' : ''} skipped.
                    </p>
                  )}
                  <button
                    onClick={() => setBulk(BULK_IDLE)}
                    className="text-[11px] text-gray-400 hover:text-white transition-colors"
                  >
                    Done
                  </button>
                </div>
              )}

              {bulk.error && <p className="text-[11px] text-red-300 mt-1 max-w-sm text-left">{bulk.error}</p>}
            </div>
          )}
        </div>

        {boxSyncOpen && <AtlasBoxSyncPanel onApplied={() => router.refresh()} />}

        {locations.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-black/30 py-16 text-center text-gray-300">
            No locations yet. Add locations in Creative Parameters first.
          </div>
        ) : (
          <>
          <div className="flex flex-wrap items-center gap-2 pb-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search locations or focuses…"
              className="flex-1 min-w-[220px] max-w-md text-xs px-3 py-2 rounded-lg bg-black/40 border border-white/15 text-white placeholder:text-white/30 focus:outline-none focus:border-[#38b6ff]/60"
            />
            {FILTER_CHIPS.map(([value, label]) => {
              const active = statusFilter === value
              const count = statusCounts[value] ?? 0
              return (
                <button
                  key={value}
                  onClick={() => setStatusFilter(value)}
                  className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                    active
                      ? 'bg-[#0075a9] border-[#0075a9] text-white'
                      : 'bg-black/30 border-white/15 text-white/55 hover:text-white hover:border-white/30'
                  }`}
                >
                  {label} <span className={active ? 'text-white/70' : 'text-white/30'}>{count}</span>
                </button>
              )
            })}
            {filtering && (
              <button
                onClick={() => { setQuery(''); setStatusFilter('all') }}
                className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg text-white/40 hover:text-white transition-colors"
              >
                Clear
              </button>
            )}
            {filtering && (
              <span className="text-[11px] text-white/35">
                {visibleCards.length} of {scopedCards.length}
                {!showingStages && <> · {visibleColumns.length} column{visibleColumns.length === 1 ? '' : 's'}</>}
              </span>
            )}
            {/* Bulk move: filter down to the cards you mean (search a location,
                pick a status), then send everything shown to one stage. Labelled
                with the live count so "move all 85" is never an accident. */}
            {showingStages && stagesReady && visibleCards.length > 0 && (
              <div className="flex items-center gap-1.5 ml-auto">
                <select
                  value={moveTarget}
                  onChange={(e) => setMoveTarget(e.target.value)}
                  className="text-[11px] px-2 py-1.5 rounded-lg bg-black/40 border border-white/15 text-white/80 focus:outline-none focus:border-[#38b6ff]/60"
                  aria-label="Move shown cards to stage"
                >
                  <option value="">Move {visibleCards.length} shown to…</option>
                  {stageColumns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
                {moveTarget && (
                  <button
                    onClick={moveShown}
                    disabled={moving}
                    className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-[#0075a9] text-white hover:bg-[#0088c4] disabled:opacity-50"
                  >
                    {moving ? 'Moving…' : `Move ${visibleCards.length}`}
                  </button>
                )}
              </div>
            )}
          </div>

          {stageError && (
            <p className="text-[11px] text-red-300 rounded border border-red-400/30 bg-red-400/10 px-3 py-2 mb-3">{stageError}</p>
          )}

          {showingStages ? (
            stagesError ? (
              <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3">
                <p className="text-sm font-semibold text-amber-200">The Stages view is not set up yet.</p>
                <p className="text-xs text-amber-200/70 mt-1">
                  Apply supabase/add_atlas_board_stages.sql in the Supabase SQL Editor, then reload. The By location view works in the meantime. ({stagesError})
                </p>
              </div>
            ) : (
              <AtlasStageBoard
                columns={stageColumns}
                cards={stageVisibleCards}
                locationNameFor={locationNameFor}
                fields={cardFields}
                onOpen={openCard}
                onMove={(ids, columnId) => { void moveCards(ids, columnId) }}
              />
            )
          ) : (
          // items-start matches the FTE board (components/Board.tsx): without it
          // flex stretches every column to the height of the tallest one, so a
          // location with 4 cards — or none — renders a full-height empty panel.
          <div className="flex items-start gap-3 overflow-x-auto pb-4 board-scroll">
            {visibleColumns.length === 0 && (
              <p className="text-sm text-white/40 py-10 px-2">No creatives match that search.</p>
            )}
            {visibleColumns.map((loc) => {
            const locCards = visibleCardsByColumn.get(loc.key) ?? []
            // Hoisted out of the .map below, where it rebuilt a Set per card
            // (O(n²)) — and, worse, computed it over the FILTERED cards, so the
            // badge blinked in and out as you typed in the search box. Whether a
            // column mixes media types is a property of the column, not of what
            // is currently on screen, so it reads the unfiltered set.
            const columnMediaTypes = new Set(
              (cardsForColumn.get(loc.key) ?? []).map((c) => c.media_type).filter(Boolean),
            )
            const showMediaBadge = columnMediaTypes.size > 1
            return (
              <div
                key={loc.key}
                className="flex-none w-[272px] flex flex-col rounded-xl overflow-hidden glass-column"
                style={{ borderTop: `2px solid ${COLUMN_ACCENT.top}`, '--col-accent': COLUMN_ACCENT.top } as React.CSSProperties}
              >
                {/* Column header — dark panel with white accent title + count pill */}
                <div className="px-3 py-2 flex items-center justify-between gap-2 select-none glass-column-header">
                  <h3
                    className="text-[13px] font-extrabold truncate tracking-wide uppercase"
                    style={{ color: '#ffffff' }}
                    title={loc.title}
                  >
                    {shortLocationName(loc.title)}
                  </h3>
                  <span
                    className="flex-none text-xs font-semibold rounded-full px-2 py-0.5 min-w-[22px] text-center"
                    style={{ color: '#ffffff', textShadow: '0 1px 2px rgba(0,0,0,0.55)', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.35)' }}
                  >
                    {locCards.length}
                  </span>
                </div>

                {/* Body — glass area continuous with the header */}
                <div className="glass-column-body">
                  <div
                    className="overflow-y-auto px-2 pt-1.5 pb-2 space-y-1.5 [scrollbar-gutter:stable]"
                    style={{ minHeight: 80, maxHeight: 'calc(100vh - 260px)' }}
                  >
                    {locCards.length === 0 && (
                      <p className="text-center text-xs py-6" style={{ color: `${COLUMN_ACCENT.title}50` }}>
                        No cards
                      </p>
                    )}
                    {locCards.map((card) => (
                      <AtlasCard
                        key={card.id}
                        card={card}
                        onOpen={openCard}
                        locationName={loc.title}
                        showMediaBadge={showMediaBadge}
                        fields={cardFields}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
          </div>
          )}
          </>
      )}
      </div>{/* end z-10 content layer */}

      {customizeOpen && (
        <AtlasBoardCustomize
          columns={stageColumns}
          countsByColumn={stageCounts}
          fields={cardFields}
          onColumnsChange={(update) => setStageColumns((prev) => sortColumns(update(prev)))}
          onFieldsChange={changeFields}
          autoMove={autoMove}
          onAutoMoveChange={changeAutoMove}
          onDeleteColumn={deleteStage}
          onOpenBackground={() => { setCustomizeOpen(false); setBgMenuOpen(true) }}
          onClose={() => setCustomizeOpen(false)}
        />
      )}
      {bgMenuOpen && (
        <BoardMenu
          title="Atlas board background"
          currentBackground={backgroundUrl}
          onBackgroundChange={setBackgroundUrl}
          persist={(url) => saveSettings({ background_url: url })}
          onClose={() => setBgMenuOpen(false)}
        />
      )}

      {selectedCard && (
        <CardDrawer
          card={selectedCard}
          userEmail={userEmail}
          columns={[]}
          clients={clients}
          doneColumnId={null}
          onClose={() => setSelectedCard(null)}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
          onColumnChanged={() => { /* Atlas cards have no board column */ }}
        />
      )}
    </div>
  )
}
