'use client'

import { useEffect, useMemo, useState, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type {
  AtlasLocation,
  AtlasBrandingAsset,
  AtlasCreativeRefresh,
  AtlasBoardCard,
  AtlasBoardColumn,
  AtlasBoardSettings,
  AtlasQuarter,
  AtlasGenerateRequest,
  AtlasGenerateResult,
  Client,
} from '@/types'
import { ATLAS_QUARTERS } from '@/types'
import AtlasBoard from '@/components/atlas/AtlasBoard'
import ExternalRef from '@/components/ExternalRef'
import AtlasCopySyncPanel from '@/components/atlas/AtlasCopySyncPanel'
import AtlasImportStatus from '@/components/atlas/AtlasImportStatus'
import { buildImportSummary, formatSummaryText, periodMismatch, rowLabel, skipReason, type ImportRowOutcome, type ImportSummary } from '@/lib/atlasImportSummary'
import { parseCopyPlanRow, parseCsvRows, buildPullRows, detectCopyBlocks, findHeaderRowIndex, describeCsvProblem, type ParsedCopyPlanRow, type CopyPlanPullRow, type CopyBlock } from '@/lib/atlasSheet'

const ATLAS_CLIENT_NAME = 'Atlas Health Network'

// ─── Tab types ────────────────────────────────────────────────────────────────
type Tab = 'parameters' | 'refresh' | 'branding' | 'board'

// A pulled sheet row with the user-editable / per-row UI state layered on top.
type PullRow = CopyPlanPullRow & {
  locationId: string        // editable; seeded from matchedLocationId
  selected: boolean
  createSocial: boolean
  createDisplay: boolean
  status?: 'importing' | 'done' | 'error'
  note?: string
}

interface CardOutcome {
  id: string | null
  reused: boolean
  error: string | null
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface Props {
  initialLocations: AtlasLocation[]
  initialAssets: AtlasBrandingAsset[]
  initialRefreshRows: AtlasCreativeRefresh[]
  initialCards: AtlasBoardCard[]
  /** Set when the board's card query failed — see app/atlas/page.tsx. */
  cardsError?: string | null
  quarterColumnsMissing?: boolean
  clients: Client[]
  backgroundUrl: string
  /** Atlas board stage columns + settings — see supabase/add_atlas_board_stages.sql. */
  stageColumns: AtlasBoardColumn[]
  stagesError: string | null
  atlasSettings: AtlasBoardSettings | null
  userEmail: string
}

// ─── Narrow form type (excludes nested relation arrays from AtlasLocation) ──────
interface LocationForm {
  name: string
  advertiser_name: string
  shares_creative: boolean
  key_notes: string
  landscape: string
  age_demo: string
  ethnicity_demo: string
}

/** The LocationForm keys that render through the generic text-input map. */
type TextLocationFormKey = {
  [K in keyof LocationForm]: LocationForm[K] extends string ? K : never
}[keyof LocationForm]

// ─── Blank forms ──────────────────────────────────────────────────────────────
const blankLocation = (): LocationForm => ({
  name: '',
  advertiser_name: '',
  shares_creative: false,
  key_notes: '',
  landscape: '',
  age_demo: '',
  ethnicity_demo: '',
})

const blankAsset = (location_id: string): Omit<AtlasBrandingAsset, 'id' | 'created_at' | 'updated_at'> => ({
  location_id,
  label: '',
  box_url: '',
})

// ─── Component ────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Atlas CARD TITLES + THE TWO GROUPINGS
// ─────────────────────────────────────────────────────────────────────────────
//
// The same practices group differently for two unrelated purposes, so there are
// two fields and they must not be collapsed (see docs/features/atlas-workspace.md):
//
//   advertiser_name  — what the client reads. MetroCare's practices all read
//                      "MetroCare", but each still gets its OWN cards.
//   shares_creative  — ScanCo only. Its practices ship ONE build, so they get
//                      ONE card per focus between them.
//
// The title follows the same split: a shared-creative brand is titled by its
// advertiser ("Atlas - ScanCo — Branded (Social)"), everyone else by their location
// ("Atlas - Lakeside Cancer Center — Breast (Social)"). No "Atlas " prefix is added —
// atlas_locations names already start with "Atlas - ", and the shared form is built to
// match, so both read consistently.
//
// The title is deterministic, which is what lets it double as the dedup key below.
function atlasCardTitle(
  loc: Pick<AtlasLocation, 'name' | 'advertiser_name' | 'shares_creative'> | undefined,
  focus: string,
  kind: 'Social' | 'Display',
): string {
  const shared = loc?.shares_creative && loc.advertiser_name?.trim()
  const label = shared ? `Atlas - ${loc.advertiser_name!.trim()}` : (loc?.name ?? 'Atlas')
  return `${label} — ${focus} (${kind})`.trim()
}

export default function AtlasWorkspaceClient({ initialLocations, initialAssets, initialRefreshRows, initialCards, clients, backgroundUrl, stageColumns, stagesError, atlasSettings, userEmail, cardsError = null, quarterColumnsMissing = false }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('parameters')

  // ── Data state ────────────────────────────────────────────────────────────
  const [locations, setLocations] = useState<AtlasLocation[]>(initialLocations)
  const [assets, setAssets] = useState<AtlasBrandingAsset[]>(initialAssets)
  const [refreshRows, setRefreshRows] = useState<AtlasCreativeRefresh[]>(initialRefreshRows)

  // ── Location modal ────────────────────────────────────────────────────────
  const [locationModal, setLocationModal] = useState<{ open: boolean; editing: AtlasLocation | null; form: LocationForm }>({
    open: false,
    editing: null,
    form: blankLocation(),
  })
  const [locationSaving, setLocationSaving] = useState(false)

  // ── Creative Refresh state ─────────────────────────────────────────────────
  const currentYear = new Date().getFullYear()
  const [refreshQuarter, setRefreshQuarter] = useState<AtlasQuarter>(() => {
    const m = new Date().getMonth()
    if (m < 3) return 'Q1'
    if (m < 6) return 'Q2'
    if (m < 9) return 'Q3'
    return 'Q4'
  })
  const [refreshYear, setRefreshYear] = useState(currentYear)
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<string>>(new Set())
  const [focusTypeInputs, setFocusTypeInputs] = useState<Record<string, string>>({}) // location_id → comma-separated focus types
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  // ── Copy Plan paste-import state ────────────────────────────────────────
  const atlasClient = useMemo(() => clients.find(c => c.name === ATLAS_CLIENT_NAME) ?? null, [clients])
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importLocationId, setImportLocationId] = useState('')
  const [importFocusType, setImportFocusType] = useState('')
  const [parsedRow, setParsedRow] = useState<ParsedCopyPlanRow | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [importSaving, setImportSaving] = useState(false)
  // row id → note shown after a card is created ('social' | 'display' created)
  const [createNote, setCreateNote] = useState<Record<string, string>>({})
  // row id → the social card id created for it, so a later display card can link back
  const [socialCardForRow, setSocialCardForRow] = useState<Record<string, string>>({})
  const [expandedRow, setExpandedRow] = useState<string | null>(null) // refresh row id being edited inline
  const [editingRefresh, setEditingRefresh] = useState<Record<string, Partial<AtlasCreativeRefresh>>>({})
  const [savingRefresh, setSavingRefresh] = useState<Set<string>>(new Set())

  // ── Copy Plan AUTO-PULL state (reads the sheet directly, no manual paste) ─
  const [pulling, setPulling] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)
  const [pullRows, setPullRows] = useState<PullRow[]>([])
  // Secondary rows the tie-breaker dropped, surfaced so the preview total never
  // shrinks without saying why.
  const [skippedSecondary, setSkippedSecondary] = useState<{ sheetRow: number; locationName: string; focusType: string }[]>([])
  const [importingBulk, setImportingBulk] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  const [summaryCopied, setSummaryCopied] = useState(false)

  // The preview is client-side state, so a reload or navigation mid-run drops the
  // rest of the queue. Rows already written stay written; the others never run.
  useEffect(() => {
    if (!importingBulk) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [importingBulk])
  const [dragOver, setDragOver] = useState(false)
  // The parsed CSV is kept so switching period re-reads it without a re-drop.
  const [csvRows, setCsvRows] = useState<string[][] | null>(null)
  const [copyBlocks, setCopyBlocks] = useState<CopyBlock[]>([])
  const [blockIndex, setBlockIndex] = useState(0)
  // What the dropped CSV is for: create new cards (the original import), or push
  // edited copy onto cards that already exist. Update-only is a separate mode
  // because the two write completely different things.
  const [csvMode, setCsvMode] = useState<'create' | 'update'>('create')

  // ── Branding Asset state ───────────────────────────────────────────────────
  const [assetModal, setAssetModal] = useState<{ open: boolean; editing: AtlasBrandingAsset | null; location: AtlasLocation | null; form: ReturnType<typeof blankAsset> }>({
    open: false,
    editing: null,
    location: null,
    form: blankAsset(''),
  })
  const [assetSaving, setAssetSaving] = useState(false)
  const [expandedBrandingLocation, setExpandedBrandingLocation] = useState<string | null>(null)

  // ─────────────────────────────────────────────────────────────────────────────
  // LOCATION CRUD
  // ─────────────────────────────────────────────────────────────────────────────
  function openAddLocation() {
    setLocationModal({ open: true, editing: null, form: blankLocation() })
  }

  function openEditLocation(loc: AtlasLocation) {
    setLocationModal({
      open: true,
      editing: loc,
      form: {
        name: loc.name,
        advertiser_name: loc.advertiser_name ?? '',
        shares_creative: loc.shares_creative ?? false,
        key_notes: loc.key_notes ?? '',
        landscape: loc.landscape ?? '',
        age_demo: loc.age_demo ?? '',
        ethnicity_demo: loc.ethnicity_demo ?? '',
      },
    })
  }

  async function saveLocation() {
    setLocationSaving(true)
    const { form, editing } = locationModal
    // advertiser_name is required, not optional-with-a-fallback: a location saved
    // without it renders "Atlas Health Network" on every one of its client
    // ads — the exact bug the column exists to fix — and nothing surfaces that.
    // The Save button is disabled on the same condition, so this is a backstop.
    if (!form.name.trim() || !form.advertiser_name.trim()) { setLocationSaving(false); return }

    if (editing) {
      const { data } = await supabase
        .from('atlas_locations')
        .update({
          name: form.name.trim(),
          advertiser_name: form.advertiser_name.trim(),
          shares_creative: form.shares_creative,
          key_notes: form.key_notes || null,
          landscape: form.landscape || null,
          age_demo: form.age_demo || null,
          ethnicity_demo: form.ethnicity_demo || null,
        })
        .eq('id', editing.id)
        .select()
        .single()
      if (data) {
        setLocations(prev => prev.map(l => l.id === editing.id ? (data as AtlasLocation) : l))
      }
    } else {
      const { data } = await supabase
        .from('atlas_locations')
        .insert({
          name: form.name.trim(),
          advertiser_name: form.advertiser_name.trim(),
          shares_creative: form.shares_creative,
          key_notes: form.key_notes || null,
          landscape: form.landscape || null,
          age_demo: form.age_demo || null,
          ethnicity_demo: form.ethnicity_demo || null,
        })
        .select()
        .single()
      if (data) {
        setLocations(prev => [...prev, data as AtlasLocation].sort((a, b) => a.name.localeCompare(b.name)))
      }
    }
    setLocationSaving(false)
    setLocationModal({ open: false, editing: null, form: blankLocation() })
  }

  // Archiving a location hides its board column -- app/atlas/page.tsx loads locations
  // with .eq('active', true) and AtlasBoard renders one column per row it gets back.
  //
  // The location's cards do NOT follow that flag. Every client-facing Adviewer
  // surface filters on cards.archived, so flipping active alone removed the column
  // from our board while the practice's ads kept rendering to the client -- a closed
  // practice still advertising, with nothing on screen to suggest it. Archive the
  // live cards in the same action, and say how many before asking.
  //
  // Cards are archived, never deleted (house rule); the archived rows are what the
  // Lookbook and the audit trail are built from.
  async function archiveLocation(loc: AtlasLocation) {
    const { data: live, error: countError } = await supabase
      .from('cards')
      .select('id')
      .eq('atlas_location_id', loc.id)
      .eq('archived', false)

    if (countError) {
      alert(`Could not check ${loc.name}'s cards, so nothing was archived. ${countError.message}`)
      return
    }

    const liveCount = live?.length ?? 0
    const warning = liveCount > 0
      ? `Archive ${loc.name}?\n\nThis also archives its ${liveCount} live card${liveCount === 1 ? '' : 's'}, removing ${liveCount === 1 ? 'it' : 'them'} from the client-facing Adviewer. Cards are archived, not deleted.`
      : `Archive ${loc.name}?\n\nIt has no live cards.`
    if (!confirm(warning)) return

    if (liveCount > 0) {
      const { error: cardError } = await supabase
        .from('cards')
        .update({ archived: true, updated_at: new Date().toISOString() })
        .eq('atlas_location_id', loc.id)
        .eq('archived', false)
      // Stop if the cards failed: leaving the location active is recoverable, but
      // hiding the column while its ads keep running is the bug this exists to fix.
      if (cardError) {
        alert(`Could not archive ${loc.name}'s cards, so the location was left active. ${cardError.message}`)
        return
      }
    }

    const { error: locError } = await supabase
      .from('atlas_locations')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', loc.id)
    if (locError) {
      alert(`${loc.name}'s cards were archived but the location is still active. ${locError.message}`)
      return
    }

    setLocations(prev => prev.filter(l => l.id !== loc.id))
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CREATIVE REFRESH — GENERATE
  // ─────────────────────────────────────────────────────────────────────────────
  async function generateCopy() {
    setGenerating(true)
    setGenerateError(null)

    const rows: AtlasGenerateRequest['rows'] = []
    for (const locId of selectedLocationIds) {
      const loc = locations.find(l => l.id === locId)
      if (!loc) continue
      const rawFocusTypes = focusTypeInputs[locId] ?? ''
      const focusTypes = rawFocusTypes.split(',').map(s => s.trim()).filter(Boolean)
      for (const ft of focusTypes) {
        rows.push({
          location_id: loc.id,
          location_name: loc.name,
          key_notes: loc.key_notes,
          landscape: loc.landscape,
          age_demo: loc.age_demo,
          ethnicity_demo: loc.ethnicity_demo,
          focus_type: ft,
          quarter: refreshQuarter,
          year: refreshYear,
        })
      }
    }

    if (rows.length === 0) {
      setGenerateError('Select at least one location and enter focus type(s).')
      setGenerating(false)
      return
    }

    try {
      const res = await fetch('/api/atlas/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows } satisfies AtlasGenerateRequest),
      })
      const json = await res.json() as { results?: AtlasGenerateResult[]; error?: string }
      if (!res.ok || !json.results) {
        setGenerateError(json.error ?? 'Generation failed.')
        setGenerating(false)
        return
      }

      // Upsert into DB and update local state
      const upsertPayload = json.results.map(r => ({
        location_id: r.location_id,
        focus_type: r.focus_type,
        quarter: r.quarter,
        year: r.year,
        social_copy: r.social_copy,
        social_headline: r.social_headline,
        social_subhead: r.social_subhead,
        graphic_headline: r.graphic_headline,
        graphic_subhead: r.graphic_subhead,
        status: 'draft',
      }))

      const { data: upserted } = await supabase
        .from('atlas_creative_refresh')
        .upsert(upsertPayload, { onConflict: 'location_id,focus_type,quarter,year' })
        .select()

      if (upserted) {
        const upsertedRows = upserted as AtlasCreativeRefresh[]
        setRefreshRows(prev => {
          const map = new Map(prev.map(r => [r.id, r]))
          for (const row of upsertedRows) map.set(row.id, row)
          return [...map.values()]
        })
      }
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setGenerating(false)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CREATIVE REFRESH — INLINE EDIT & SAVE
  // ─────────────────────────────────────────────────────────────────────────────
  function startEditRefresh(row: AtlasCreativeRefresh) {
    setExpandedRow(row.id)
    setEditingRefresh(prev => ({
      ...prev,
      [row.id]: {
        social_copy: row.social_copy ?? '',
        social_headline: row.social_headline ?? '',
        social_subhead: row.social_subhead ?? '',
        graphic_headline: row.graphic_headline ?? '',
        graphic_subhead: row.graphic_subhead ?? '',
        adpiler_link: row.adpiler_link ?? '',
        status: row.status,
      },
    }))
  }

  async function saveRefreshRow(rowId: string) {
    setSavingRefresh(prev => new Set(prev).add(rowId))
    const edits = editingRefresh[rowId] ?? {}
    const { data } = await supabase
      .from('atlas_creative_refresh')
      .update(edits)
      .eq('id', rowId)
      .select()
      .single()
    if (data) {
      setRefreshRows(prev => prev.map(r => r.id === rowId ? (data as AtlasCreativeRefresh) : r))
    }
    setSavingRefresh(prev => { const s = new Set(prev); s.delete(rowId); return s })
    setExpandedRow(null)
  }

  async function approveRefreshRow(rowId: string) {
    await supabase.from('atlas_creative_refresh').update({ status: 'approved' }).eq('id', rowId)
    setRefreshRows(prev => prev.map(r => r.id === rowId ? { ...r, status: 'approved' } : r))
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COPY PLAN — PASTE IMPORT
  // ─────────────────────────────────────────────────────────────────────────────
  function parseImport() {
    setImportError(null)
    const result = parseCopyPlanRow(importText)
    if (!result.ok) { setParsedRow(null); setImportError(result.error); return }
    setParsedRow(result.data)
  }

  // Shared upsert used by both the single paste-import and the bulk auto-pull.
  // Keyed on location+focus+quarter+year (the table's unique constraint), so a
  // re-import updates the existing row rather than duplicating it.
  async function upsertRefreshRow(
    parsed: ParsedCopyPlanRow,
    locationId: string,
    focusType: string,
  ): Promise<{ saved: AtlasCreativeRefresh | null; error: string | null }> {
    const { data, error } = await supabase
      .from('atlas_creative_refresh')
      .upsert({
        location_id: locationId,
        focus_type: focusType.trim(),
        quarter: refreshQuarter,
        year: refreshYear,
        social_copy: parsed.social_copy,
        social_headline: parsed.social_headline,
        social_subhead: parsed.social_subhead,
        graphic_headline: parsed.graphic_headline,
        graphic_subhead: parsed.graphic_subhead,
        facebook_url: parsed.facebook_url,
        display_url: parsed.display_url,
        social_build_box_link: parsed.social_build_box_link,
        display_build_box_link: parsed.display_build_box_link,
        status: 'draft',
      }, { onConflict: 'location_id,focus_type,quarter,year' })
      .select()
      .single()
    if (!data) return { saved: null, error: error?.message ?? null }
    const saved = data as AtlasCreativeRefresh
    setRefreshRows(prev => {
      const map = new Map(prev.map(r => [r.id, r]))
      map.set(saved.id, saved)
      return [...map.values()]
    })
    return { saved, error: null }
  }

  async function saveImportedRow() {
    if (!parsedRow || !importLocationId || !importFocusType.trim()) {
      setImportError('Pick a location, enter a focus type, and parse a row first.')
      return
    }
    setImportSaving(true)
    setImportError(null)
    const { saved, error } = await upsertRefreshRow(parsedRow, importLocationId, importFocusType)
    setImportSaving(false)
    if (saved) {
      setImportText(''); setParsedRow(null); setImportFocusType(''); setImportOpen(false)
      setExpandedRow(saved.id)
    } else {
      setImportError(error ?? 'Could not save to Creative Refresh (you may not have write access).')
    }
  }

  // ── Auto-pull: read the sheet directly for the selected quarter, preview, import.
  // Parse a CSV downloaded from the Copy Plan tab entirely client-side — no
  // Google API. The browser already holds `locations` (for matching) and
  // `refreshRows` (for dedupe), so nothing needs a server round-trip.
  // Build the preview from an already-parsed CSV for one campaign-period block.
  // quarter/year are passed in so the Quarter and Year selectors can re-derive the
  // dedupe flags: they default from state, which still holds the OLD value inside
  // those onChange handlers, and a stale flag is what lets a duplicate card through.
  function rebuildPullRows(rows: string[][], block: CopyBlock, quarter: AtlasQuarter = refreshQuarter, year: number = refreshYear) {
    const importedKeys = new Set(
      refreshRows
        .filter(r => r.quarter === quarter && r.year === year)
        .map(r => `${r.location_id}::${r.focus_type.trim().toLowerCase()}`),
    )
    const headerIdx = findHeaderRowIndex(rows)
    const { rows: built, skippedSecondary } = buildPullRows(rows, {
      block,
      locations: locations.map(l => ({ id: l.id, name: l.name })),
      importedKeys,
      dataStartIndex: headerIdx >= 0 ? headerIdx + 1 : 2,
    })
    const pr = built.map<PullRow>(r => ({
      ...r,
      locationId: r.matchedLocationId ?? '',
      // Unticked by default when the copy reads as a note or an unfilled stub.
      // Advisory only — the row is still listed and still tickable; it just
      // stops being swept in by Select all, which is how "Still Good" became
      // two live cards on 2026-09-14.
      selected: !r.alreadyImported && !!r.matchedLocationId && !r.suspectCopy,
      createSocial: true,
      // Default Display OFF unless THIS PERIOD has an HTML5 build for the row.
      // Gate on the period's Display Build Box link only — never on display_url,
      // which is a global column filled for every row in the sheet (every row of
      // the Sep 2026 export), so it would switch Display on for everything and
      // defeat the point. A period with no builds yet imports social-only, which
      // is the normal state when the copy has just been written.
      // Off by default now that the display build link rides on the social
      // card. A separate display card is only worth making when something has
      // to point at that folder as a card — the TTD export, which is keyed on
      // media_type and cannot run from a social card. Atlas traffics display by
      // hand ("Uploaded to TTD by MTS" in the sheet), so it normally does not.
      createDisplay: false,
    }))
    setPullRows(pr)
    setSkippedSecondary(skippedSecondary)
    setPullError(pr.length === 0
      ? `No rows found in "${block.label}" — that period has no Social Copy written yet. Pick a different period above.`
      : null)
  }

  async function handleCsvFile(file: File) {
    if (importingBulk) return
    setImportSummary(null)
    setPulling(true); setPullError(null)
    try {
      const text = await file.text()
      const rows = parseCsvRows(text)
      // The sheet grows a new 8-column block per campaign period, so the copy is
      // never at a fixed column — detect the blocks and default to the newest.
      const blocks = detectCopyBlocks(rows)
      if (blocks.length === 0) {
        setCsvRows(null); setCopyBlocks([]); setPullRows([])
        setPullError(describeCsvProblem(text, rows))
        setPulling(false)
        return
      }
      const idx = blocks.length - 1
      setCsvRows(rows); setCopyBlocks(blocks); setBlockIndex(idx)
      rebuildPullRows(rows, blocks[idx])
    } catch {
      setPullError('Could not read that file. Export the Copy Plan tab as .csv (File → Download → Comma-separated values) and try again.')
    }
    setPulling(false)
  }

  function changeBlock(idx: number) {
    setBlockIndex(idx)
    if (csvRows && copyBlocks[idx]) rebuildPullRows(csvRows, copyBlocks[idx])
  }

  function updatePullRow(idx: number, patch: Partial<PullRow>) {
    setPullRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  // Apply a patch to every row that is still importable. Without this a 25-row
  // quarter means 25 clicks to turn Display off, which is the normal case when a
  // refresh is social-only.
  //
  // Already-imported rows are skipped as well as just-imported ones: the cards insert
  // has no unique guard, so re-importing a flagged row creates a SECOND card for it.
  // That is why they are unchecked by default, and "Select all" must not undo it. The
  // per-row checkbox still forces one through deliberately.
  //
  // Rows whose copy reads as a note or an unfilled stub are protected the same
  // way, but ONLY against being ticked ON. Every other bulk patch (Social /
  // Display toggles) still applies to them, so a deliberately-ticked row still
  // behaves normally.
  function patchAllPullRows(patch: Partial<PullRow>) {
    const turningOn = patch.selected === true
    setPullRows(prev => prev.map(r => {
      if (r.status === 'done' || r.alreadyImported) return r
      if (turningOn && r.suspectCopy) return r
      return { ...r, ...patch }
    }))
  }

  async function importSelected() {
    const run = pullRows
    const periodLabel = `${refreshQuarter} ${refreshYear}`
    // Snapshot indices to import so per-row state writes don't disturb the loop.
    const targets = run.map((r, i) => ({ r, i })).filter(({ r }) => r.selected)
    const outcomes: ImportRowOutcome[] = []
    // Skip reasons are read from the flags as they stand BEFORE the run: a
    // successful import flips alreadyImported, which would relabel it afterwards.
    for (const r of run) {
      if (r.selected) continue
      outcomes.push({ sheetRow: r.sheetRow, label: rowLabel(r), kind: 'skipped', reason: skipReason(r, periodLabel), cardIds: [] })
    }
    setImportSummary(null)
    setSummaryCopied(false)
    setImportingBulk(true)
    setImportProgress({ done: 0, total: targets.length, current: '' })

    let done = 0
    for (const { i } of targets) {
      const row = run[i]
      const label = rowLabel(row)
      const fail = (reason: string, cardIds: string[] = []) =>
        outcomes.push({ sheetRow: row.sheetRow, label, kind: 'failed', reason, cardIds })
      setImportProgress({ done, total: targets.length, current: `Row ${row.sheetRow} · ${label}` })
      try {
        if (!row.locationId) { updatePullRow(i, { status: 'error', note: 'Pick a location' }); fail('no location selected'); continue }
        if (!row.focusType.trim()) { updatePullRow(i, { status: 'error', note: 'Missing focus type' }); fail('missing focus type'); continue }
        updatePullRow(i, { status: 'importing', note: undefined })
        const { saved, error: saveError } = await upsertRefreshRow(row.parsed, row.locationId, row.focusType)
        if (!saved) {
          updatePullRow(i, { status: 'error', note: saveError ? `Save failed: ${saveError}` : 'Save failed' })
          fail(saveError ? `copy not saved: ${saveError}` : 'copy not saved')
          continue
        }

        // Check both card inserts. The refresh row and the cards live under different
        // RLS, so the copy can save while the card insert is refused (or atlasClient is
        // missing) — reporting that as "Imported" would claim 85 successes with no cards
        // created. The row stays selected so a retry picks it up.
        const social: CardOutcome | null = row.createSocial ? await createReviewCard(saved) : null
        const display: CardOutcome | null = row.createDisplay ? await createDisplayCard(saved, social?.id ?? null) : null

        const failed = [
          social && !social.id ? `social: ${social.error ?? 'unknown error'}` : null,
          display && !display.id ? `display: ${display.error ?? 'unknown error'}` : null,
        ].filter((x): x is string => x !== null)
        const made = [social, display].filter((o): o is CardOutcome => !!o && !!o.id)
        const cardIds = made.filter(o => !o.reused).map(o => o.id as string)
        if (failed.length > 0) {
          const which = [social && !social.id ? 'social' : null, display && !display.id ? 'display' : null].filter(Boolean).join(' + ')
          updatePullRow(i, { status: 'error', note: `Copy saved, but the ${which} card failed` })
          fail(`Copy saved, but the card failed — ${failed.join('; ')}`, cardIds)
          continue
        }

        const reusedAll = [social, display].filter((o): o is CardOutcome => !!o).every(o => o.reused)
        const anyCard = !!social || !!display
        const reusedIds = made.filter(o => o.reused).map(o => o.id as string)
        const parts = ['Imported', row.createSocial ? 'social' : null, row.createDisplay ? 'display' : null].filter(Boolean)
        updatePullRow(i, { status: 'done', selected: false, alreadyImported: true, note: parts.join(' + ') })
        if (!anyCard) {
          outcomes.push({ sheetRow: row.sheetRow, label, kind: 'skipped', reason: 'copy saved, no card requested (Social and Display both off)', cardIds: [] })
        } else if (reusedAll) {
          outcomes.push({ sheetRow: row.sheetRow, label, kind: 'reused', reason: `no new card — reused the existing shared card for ${periodLabel} (copy on that card was not updated)`, cardIds: reusedIds })
        } else {
          outcomes.push({ sheetRow: row.sheetRow, label, kind: 'created', reason: '', cardIds })
        }
      } catch (e) {
        updatePullRow(i, { status: 'error', note: 'Unexpected error' })
        fail(e instanceof Error ? e.message : 'unexpected error')
      }
      done += 1
      setImportProgress({ done, total: targets.length, current: `Row ${row.sheetRow} · ${label}` })
    }
    outcomes.sort((a, b) => a.sheetRow - b.sheetRow)
    setImportSummary(buildImportSummary(outcomes, run.length, periodLabel))
    setImportProgress(null)
    setImportingBulk(false)
  }

  // Find an existing live card for a shared-creative brand's (advertiser, focus).
  // Returns null for every normal location, so the non-shared path is untouched and
  // pays no extra query. Scoped to Atlas cards only (atlas_location_id not null) and to
  // non-archived rows, so a card archived during consolidation is never resurrected
  // as a "reuse" — the import creates a fresh one instead.
  // Scoped to the row's quarter + year: a new quarter gets its own shared card, so
  // Q1 2027 ScanCo rows no longer land on last quarter's cards and create nothing.
  async function findSharedAtlasCard(
    loc: AtlasLocation | undefined,
    title: string,
    quarter: AtlasQuarter,
    year: number,
  ): Promise<string | null> {
    if (!loc?.shares_creative) return null
    const { data } = await supabase
      .from('cards')
      .select('id')
      .eq('title', title)
      .eq('archived', false)
      .eq('atlas_quarter', quarter)
      .eq('atlas_year', year)
      .not('atlas_location_id', 'is', null)
      .limit(1)
    return (data as { id: string }[] | null)?.[0]?.id ?? null
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COPY PLAN — CREATE BOARD CARDS FROM A REFRESH ROW
  // ─────────────────────────────────────────────────────────────────────────────
  async function createReviewCard(row: AtlasCreativeRefresh): Promise<CardOutcome> {
    if (!atlasClient) {
      const error = `Missing "${ATLAS_CLIENT_NAME}" client.`
      setCreateNote(prev => ({ ...prev, [row.id]: error }))
      return { id: null, reused: false, error }
    }
    const loc = locations.find(l => l.id === row.location_id)
    const title = atlasCardTitle(loc, row.focus_type, 'Social')

    // One card per (advertiser_name, focus) for a shared-creative brand. ScanCo's five
    // practices ship one build, so a second card for the same focus is a duplicate of
    // work already on the board — this is what stops the next import recreating the 14
    // ScanCo cards that were consolidated by hand into 4. Reuse is keyed on the title,
    // which atlasCardTitle derives deterministically from (advertiser_name, focus).
    // Deliberately NOT maybeSingle(): it errors when more than one row matches, and a
    // pre-existing duplicate pair would then fail the import instead of being reused.
    const reused = await findSharedAtlasCard(loc, title, row.quarter, row.year)
    if (reused) {
      setSocialCardForRow(prev => ({ ...prev, [row.id]: reused }))
      setCreateNote(prev => ({ ...prev, [row.id]: `Reused the shared ${loc?.advertiser_name} card for ${row.focus_type} — one creative covers every ${loc?.advertiser_name} location.` }))
      return { id: reused, reused: true, error: null }
    }

    const { data, error } = await supabase
      .from('cards')
      .insert({
        title,
        client_id: atlasClient.id,
        // Stays on the practice row the sheet row came from, even for a shared-creative
        // brand: the Atlas board groups by it and the Box sync matches on it.
        atlas_location_id: row.location_id,
        atlas_quarter: row.quarter,
        atlas_year: row.year,
        // The practice the client reads as the advertiser, not "Example Oncology
        // Network" (which is what an empty fb_page_name falls back to).
        fb_page_name: loc?.advertiser_name ?? null,
        column_id: null,
        media_type: 'Social Ad Request',
        fb_body_text: row.social_copy,
        fb_headline: row.social_headline,
        fb_subheadline: row.social_subhead,
        heading: row.graphic_headline,
        subheading: row.graphic_subhead,
        landing_page_url: row.facebook_url,
        build_link: row.social_build_box_link,
        // Both builds live on the one social card. The display set is cut from
        // this creative once it is approved, so a second card for it was only
        // ever a container for a link — and one that then had to be filtered
        // out of the board and skipped by bulk send.
        display_build_link: row.display_build_box_link,
        work_status: 'in_design',
        approval_status: 'none',
        position: 0,
      })
      .select('id')
      .single()
    if (data) {
      const newId = (data as { id: string }).id
      setSocialCardForRow(prev => ({ ...prev, [row.id]: newId }))
      setCreateNote(prev => ({ ...prev, [row.id]: 'Social review card created ✓ — open the Board tab to see it.' }))
      return { id: newId, reused: false, error: null }
    }
    const message = `Could not create the social card${error?.message ? `: ${error.message}` : ' (you may not have write access).'}`
    setCreateNote(prev => ({ ...prev, [row.id]: message }))
    return { id: null, reused: false, error: error?.message ?? 'insert refused (you may not have write access)' }
  }

  // referencedCardId is passed explicitly by the bulk import (React state set by
  // createReviewCard isn't readable synchronously mid-loop); the single-row button
  // omits it and falls back to the socialCardForRow map.
  async function createDisplayCard(row: AtlasCreativeRefresh, referencedCardId?: string | null): Promise<CardOutcome> {
    if (!atlasClient) {
      const error = `Missing "${ATLAS_CLIENT_NAME}" client.`
      setCreateNote(prev => ({ ...prev, [row.id]: error }))
      return { id: null, reused: false, error }
    }
    const loc = locations.find(l => l.id === row.location_id)
    const title = atlasCardTitle(loc, row.focus_type, 'Display')

    // Same shared-creative rule as the social card above. This one is internal, but a
    // duplicate internal build is still duplicated work for the designer.
    const reusedDisplay = await findSharedAtlasCard(loc, title, row.quarter, row.year)
    if (reusedDisplay) {
      setCreateNote(prev => ({ ...prev, [row.id]: `Reused the shared ${loc?.advertiser_name} display build for ${row.focus_type}.` }))
      return { id: reusedDisplay, reused: true, error: null }
    }

    const { data, error } = await supabase
      .from('cards')
      .insert({
        title,
        client_id: atlasClient.id,
        atlas_location_id: row.location_id,
        atlas_quarter: row.quarter,
        atlas_year: row.year,
        fb_page_name: loc?.advertiser_name ?? null,
        column_id: null,
        media_type: 'Display Request',
        landing_page_url: row.display_url,
        build_link: row.display_build_box_link,
        // Internal build — never surfaced in client review.
        client_portal_status: null,
        // Link back to the social review card when we have it (created this session).
        referenced_card_id: referencedCardId ?? socialCardForRow[row.id] ?? null,
        work_status: 'in_design',
        approval_status: 'none',
        position: 0,
      })
      .select('id')
      .single()
    if (data) {
      setCreateNote(prev => ({ ...prev, [row.id]: 'Internal display card created ✓ — open the Board tab to see it.' }))
      return { id: (data as { id: string }).id, reused: false, error: null }
    }
    const message = error?.message ?? 'insert refused (you may not have write access)'
    setCreateNote(prev => ({ ...prev, [row.id]: `Could not create the display card: ${message}` }))
    return { id: null, reused: false, error: message }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BRANDING ASSETS CRUD
  // ─────────────────────────────────────────────────────────────────────────────
  function openAddAsset(loc: AtlasLocation) {
    setAssetModal({ open: true, editing: null, location: loc, form: blankAsset(loc.id) })
  }

  function openEditAsset(asset: AtlasBrandingAsset, loc: AtlasLocation) {
    setAssetModal({
      open: true,
      editing: asset,
      location: loc,
      form: { location_id: asset.location_id, label: asset.label, box_url: asset.box_url ?? '' },
    })
  }

  async function saveAsset() {
    setAssetSaving(true)
    const { form, editing } = assetModal
    if (!form.label.trim()) { setAssetSaving(false); return }

    if (editing) {
      const { data } = await supabase
        .from('atlas_branding_assets')
        .update({ label: form.label.trim(), box_url: form.box_url || null })
        .eq('id', editing.id)
        .select()
        .single()
      if (data) setAssets(prev => prev.map(a => a.id === editing.id ? (data as AtlasBrandingAsset) : a))
    } else {
      const { data } = await supabase
        .from('atlas_branding_assets')
        .insert({ location_id: form.location_id, label: form.label.trim(), box_url: form.box_url || null })
        .select()
        .single()
      if (data) setAssets(prev => [...prev, data as AtlasBrandingAsset])
    }
    setAssetSaving(false)
    setAssetModal({ open: false, editing: null, location: null, form: blankAsset('') })
  }

  async function deleteAsset(id: string) {
    await supabase.from('atlas_branding_assets').delete().eq('id', id)
    setAssets(prev => prev.filter(a => a.id !== id))
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Derived state
  // ─────────────────────────────────────────────────────────────────────────────
  const currentRefreshRows = refreshRows.filter(
    r => r.quarter === refreshQuarter && r.year === refreshYear
  )
  const assetsByLocation = useMemo(() => {
    const map = new Map<string, AtlasBrandingAsset[]>()
    for (const a of assets) {
      const existing = map.get(a.location_id) ?? []
      map.set(a.location_id, [...existing, a])
    }
    return map
  }, [assets])

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-white/10 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal-500/20 flex items-center justify-center border border-teal-500/30">
              <span className="text-teal-400 font-bold text-xs">Atlas</span>
            </div>
            <div>
              <h1 className="text-white font-semibold text-sm leading-tight">Atlas Creative Workspace</h1>
              <p className="text-gray-400 text-xs">Atlas Health Network</p>
            </div>
          </div>
          <nav className="flex items-center gap-1 ml-4">
            {([
              { id: 'parameters', label: 'Creative Parameters' },
              { id: 'refresh', label: 'Creative Refresh' },
              { id: 'branding', label: 'Branding Assets' },
              { id: 'board', label: 'Board' },
            ] as { id: Tab; label: string }[]).map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="ml-auto">
            <a
              href="/board"
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
            >
              ← FTE Board
            </a>
          </div>
        </div>
      </header>

      {/* Body — the three data tabs live in a centered container; the Board tab
          renders full-bleed below so it can carry the shared board background
          edge-to-edge like the main FTE board. */}
      {tab === 'board' ? (
        <AtlasBoard
          locations={locations}
          initialCards={initialCards}
          cardsError={cardsError}
          quarterColumnsMissing={quarterColumnsMissing}
          clients={clients}
          backgroundUrl={backgroundUrl}
          stageColumns={stageColumns}
          stagesError={stagesError}
          atlasSettings={atlasSettings}
          userEmail={userEmail}
        />
      ) : (
      <main className="max-w-7xl mx-auto px-6 py-8">

        {/* ── CREATIVE PARAMETERS TAB ── */}
        {tab === 'parameters' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Creative Parameters</h2>
                <p className="text-gray-400 text-sm mt-0.5">{locations.length} active centers</p>
              </div>
              <button
                onClick={openAddLocation}
                className="px-4 py-2 bg-teal-600 hover:bg-teal-500 rounded-lg text-sm font-medium transition-colors"
              >
                + Add Location
              </button>
            </div>

            <div className="rounded-xl border border-white/10 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-white/5 text-gray-400">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Center</th>
                    <th className="text-left px-4 py-3 font-medium">Landscape</th>
                    <th className="text-left px-4 py-3 font-medium">Age Demo</th>
                    <th className="text-left px-4 py-3 font-medium">Ethnicity</th>
                    <th className="text-left px-4 py-3 font-medium">Key Notes</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {locations.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-gray-500">
                        No locations yet — click &ldquo;+ Add Location&rdquo; to get started.
                      </td>
                    </tr>
                  )}
                  {locations.map(loc => (
                    <tr key={loc.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3 font-medium text-white">{loc.name}</td>
                      <td className="px-4 py-3 text-gray-300">{loc.landscape ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-300">{loc.age_demo ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-300">{loc.ethnicity_demo ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate">{loc.key_notes ?? '—'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            onClick={() => openEditLocation(loc)}
                            className="text-gray-400 hover:text-white text-xs transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => archiveLocation(loc)}
                            className="text-gray-600 hover:text-red-400 text-xs transition-colors"
                          >
                            Archive
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── CREATIVE REFRESH TAB ── */}
        {tab === 'refresh' && (
          <div className="space-y-6">
            {/* Quarter / Year selector + Generate */}
            <div className="flex items-end gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold">Creative Refresh</h2>
                <p className="text-gray-400 text-sm mt-0.5">AI-generated copy per location × focus type</p>
              </div>
              <div className="ml-auto flex items-end gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Quarter</label>
                  <select
                    value={refreshQuarter}
                    disabled={importingBulk}
                    onChange={e => {
                      const q = e.target.value as AtlasQuarter
                      setRefreshQuarter(q)
                      if (csvRows && copyBlocks[blockIndex]) rebuildPullRows(csvRows, copyBlocks[blockIndex], q, refreshYear)
                    }}
                    className="bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    {ATLAS_QUARTERS.map(q => <option key={q} value={q}>{q}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Year</label>
                  <select
                    value={refreshYear}
                    disabled={importingBulk}
                    onChange={e => {
                      const y = Number(e.target.value)
                      setRefreshYear(y)
                      if (csvRows && copyBlocks[blockIndex]) rebuildPullRows(csvRows, copyBlocks[blockIndex], refreshQuarter, y)
                    }}
                    className="bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                  >
                    {[currentYear - 1, currentYear, currentYear + 1].map(y => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Location + Focus Type selector */}
            <div className="rounded-xl border border-white/10 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-300">Select Locations &amp; Focus Types to Generate</h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedLocationIds(new Set(locations.map(l => l.id)))}
                    className="text-xs text-teal-400 hover:text-teal-300 transition-colors"
                  >
                    Select all
                  </button>
                  <span className="text-gray-600">·</span>
                  <button
                    onClick={() => setSelectedLocationIds(new Set())}
                    className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-72 overflow-y-auto pr-1">
                {locations.map(loc => (
                  <label
                    key={loc.id}
                    className={`flex flex-col gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedLocationIds.has(loc.id)
                        ? 'border-teal-500/40 bg-teal-500/10'
                        : 'border-white/10 bg-white/[0.02] hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-teal-500"
                        checked={selectedLocationIds.has(loc.id)}
                        onChange={e => {
                          const s = new Set(selectedLocationIds)
                          if (e.target.checked) { s.add(loc.id) } else { s.delete(loc.id) }
                          setSelectedLocationIds(s)
                        }}
                      />
                      <span className="text-sm font-medium text-white">{loc.name}</span>
                    </div>
                    {selectedLocationIds.has(loc.id) && (
                      <input
                        type="text"
                        placeholder="Focus types (comma-separated)"
                        value={focusTypeInputs[loc.id] ?? ''}
                        onChange={e => setFocusTypeInputs(prev => ({ ...prev, [loc.id]: e.target.value }))}
                        onClick={e => e.stopPropagation()}
                        className="bg-gray-900 border border-white/10 rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 w-full"
                      />
                    )}
                  </label>
                ))}
              </div>

              {generateError && (
                <p className="text-red-400 text-sm">{generateError}</p>
              )}

              <div className="flex justify-end">
                <button
                  onClick={generateCopy}
                  disabled={generating || selectedLocationIds.size === 0}
                  className="px-5 py-2.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-semibold transition-colors flex items-center gap-2"
                >
                  {generating ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Generating…
                    </>
                  ) : (
                    `✦ Generate Copy (${Array.from(selectedLocationIds).reduce((acc, id) => {
                      const ft = focusTypeInputs[id] ?? ''
                      return acc + ft.split(',').map(s => s.trim()).filter(Boolean).length
                    }, 0)} rows)`
                  )}
                </button>
              </div>
            </div>

            {/* Import from Copy Plan sheet */}
            <div className="rounded-xl border border-white/10 p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-300">Import from Copy Plan sheet</h3>
                  <p className="text-gray-500 text-xs mt-0.5">Export the {refreshQuarter} {refreshYear} tab as CSV and drop it below — or paste one row by hand.</p>
                </div>
              {/* Create vs update — the same CSV drives both, but they write
                  different things, so the choice is made before dropping it. */}
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-gray-500 uppercase tracking-wide">This CSV is for:</span>
                <button
                  onClick={() => setCsvMode('create')}
                  className={`px-2.5 py-1 rounded-lg border transition-colors ${csvMode === 'create' ? 'border-teal-400/50 bg-teal-500/15 text-teal-200' : 'border-white/15 text-gray-300 hover:border-white/30'}`}
                >
                  Creating new cards
                </button>
                <button
                  onClick={() => setCsvMode('update')}
                  className={`px-2.5 py-1 rounded-lg border transition-colors ${csvMode === 'update' ? 'border-teal-400/50 bg-teal-500/15 text-teal-200' : 'border-white/15 text-gray-300 hover:border-white/30'}`}
                >
                  Updating copy on existing cards
                </button>
              </div>

                <button
                  onClick={() => { setImportOpen(o => !o); setImportError(null) }}
                  className="text-xs text-teal-400 hover:text-teal-300 transition-colors"
                >
                  {importOpen ? 'Hide' : 'Paste a row'}
                </button>
              </div>

              {/* CSV drop zone — export the Copy Plan tab (File → Download → CSV) and drop it here */}
              <label
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => {
                  e.preventDefault()
                  setDragOver(false)
                  const f = e.dataTransfer.files?.[0]
                  if (f) void handleCsvFile(f)
                }}
                className={`flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-teal-400 bg-teal-500/10' : 'border-white/15 hover:border-white/30 bg-white/[0.02]'}`}
              >
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) void handleCsvFile(f)
                    e.target.value = '' // allow re-selecting the same file
                  }}
                />
                <span className="text-sm text-gray-300 font-medium">
                  {pulling ? 'Reading CSV…' : 'Drop the Copy Plan CSV here'}
                </span>
                <span className="text-xs text-gray-500">or click to choose a file — export from the sheet with File → Download → Comma-separated values</span>
              </label>

              {importOpen && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Location</label>
                      <select
                        value={importLocationId}
                        onChange={e => setImportLocationId(e.target.value)}
                        className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
                      >
                        <option value="">Select location…</option>
                        {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Focus Type</label>
                      <input
                        type="text"
                        value={importFocusType}
                        onChange={e => setImportFocusType(e.target.value)}
                        placeholder="e.g. Oncology"
                        className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-400 mb-1">Pasted sheet row</label>
                    <textarea
                      rows={4}
                      value={importText}
                      onChange={e => setImportText(e.target.value)}
                      placeholder="Copy a full row from the Copy Plan tab and paste it here…"
                      className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 font-mono resize-none"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={parseImport}
                      disabled={!importText.trim()}
                      className="px-4 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-50 rounded-lg text-sm transition-colors"
                    >
                      Parse
                    </button>
                    {parsedRow && (
                      <button
                        onClick={saveImportedRow}
                        disabled={importSaving || !importLocationId || !importFocusType.trim()}
                        className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-semibold transition-colors"
                      >
                        {importSaving ? 'Saving…' : 'Save to Creative Refresh'}
                      </button>
                    )}
                  </div>

                  {importError && <p className="text-red-400 text-sm">{importError}</p>}

                  {parsedRow && (
                    <div className="rounded-lg border border-teal-500/20 bg-teal-500/5 p-4 space-y-2">
                      <p className="text-xs font-semibold text-teal-300 uppercase tracking-wide">Parsed preview</p>
                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                        {([
                          ['Social Copy', parsedRow.social_copy],
                          ['Social Headline', parsedRow.social_headline],
                          ['Social Subhead', parsedRow.social_subhead],
                          ['Graphic Headline', parsedRow.graphic_headline],
                          ['Graphic Subhead', parsedRow.graphic_subhead],
                          ['FB URL (H)', parsedRow.facebook_url],
                          ['Display URL (I)', parsedRow.display_url],
                          ['Social Box (AW)', parsedRow.social_build_box_link],
                          ['Display Box (AU)', parsedRow.display_build_box_link],
                        ] as [string, string | null][]).map(([label, value]) => (
                          <div key={label} className="flex flex-col">
                            <dt className="text-gray-500">{label}</dt>
                            <dd className={`break-words ${value ? 'text-gray-200' : 'text-gray-600 italic'}`}>{value ?? '— not found'}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}
                </div>
              )}

              {/* Update mode — its own confirm screen; writes nothing until Apply. */}
              {csvMode === 'update' && csvRows && copyBlocks[blockIndex] && (
                <AtlasCopySyncPanel
                  csvRows={csvRows}
                  block={copyBlocks[blockIndex]}
                  locations={locations}
                  refreshRows={refreshRows}
                  quarter={refreshQuarter}
                  year={refreshYear}
                  userEmail={userEmail}
                  onApplied={() => router.refresh()}
                />
              )}

              {/* Auto-pull preview — one confirm screen for the whole quarter */}
              {csvMode === 'create' && (pullRows.length > 0 || pullError) && (
                <div className="space-y-3 border-t border-white/10 pt-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-gray-400">
                      {pullRows.length > 0
                        ? `Pulled ${pullRows.length} row${pullRows.length !== 1 ? 's' : ''} from "${copyBlocks[blockIndex]?.label ?? ''}" — saving into ${refreshQuarter} ${refreshYear}. Check the location matches, then import.${
                            pullRows.filter(r => r.suspectCopy).length > 0
                              ? ` ${pullRows.filter(r => r.suspectCopy).length} left unticked — the copy reads as a note, not ad copy.`
                              : ''
                          }`
                        : ''}
                    </p>
                    {pullRows.length > 0 && (
                      <button
                        onClick={importSelected}
                        disabled={importingBulk || pullRows.every(r => !r.selected)}
                        className="flex-none px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-semibold transition-colors"
                      >
                        {importingBulk ? 'Importing…' : `Import selected (${pullRows.filter(r => r.selected).length})`}
                      </button>
                    )}
                  </div>

                  <AtlasImportStatus
                    mismatch={copyBlocks[blockIndex] ? periodMismatch(copyBlocks[blockIndex].label, refreshQuarter, refreshYear) : null}
                    progress={importProgress}
                    summary={importingBulk ? null : importSummary}
                    copied={summaryCopied}
                    onCopy={async () => {
                      if (!importSummary) return
                      try {
                        await navigator.clipboard.writeText(formatSummaryText(importSummary))
                        setSummaryCopied(true)
                      } catch { setSummaryCopied(false) }
                    }}
                    onDismiss={() => setImportSummary(null)}
                  />

                  {/* Why the total is lower than the sheet's row count. One card per
                      location+focus: a Secondary row is dropped when the same focus
                      also has a Primary. Never silent — a total shrinking with no
                      reason on screen is the thing that costs an afternoon. */}
                  {skippedSecondary.length > 0 && (
                    <details className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                      <summary className="text-[11px] text-gray-400 cursor-pointer">
                        {skippedSecondary.length} Secondary duplicate{skippedSecondary.length !== 1 ? 's' : ''} skipped — one card per location + focus
                      </summary>
                      <ul className="mt-1.5 space-y-0.5">
                        {skippedSecondary.map(r => (
                          <li key={r.sheetRow} className="text-[10px] text-gray-500">
                            sheet row {r.sheetRow} — {r.locationName} / {r.focusType} (a Primary row for this focus is being imported instead)
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {/* Which campaign period to import — the sheet adds a new copy block
                      each period, so this is not derivable from the quarter selector */}
                  {copyBlocks.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-[11px] text-gray-500 uppercase tracking-wide">Copy from period:</label>
                      <select
                        value={blockIndex}
                        disabled={importingBulk}
                        onChange={e => changeBlock(Number(e.target.value))}
                        className="bg-gray-800 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white"
                      >
                        {copyBlocks.map((b, i) => (
                          <option key={b.copyCol} value={i}>
                            {b.label}{i === copyBlocks.length - 1 ? ' (newest)' : ''}
                          </option>
                        ))}
                      </select>
                      {copyBlocks[blockIndex] && copyBlocks[blockIndex].socialBoxCol === null && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30">
                          no Social Build Box column in this period
                        </span>
                      )}
                    </div>
                  )}

                  {pullError && <p className="text-red-400 text-sm">{pullError}</p>}

                  {/* Everything below is locked while a run is in flight: changing a
                      checkbox, location or the Quarter/Year re-derives the dedupe flags
                      mid-loop, which is how a duplicate card gets through. */}
                  <fieldset disabled={importingBulk} className="min-w-0 border-0 p-0 m-0 space-y-3">
                  {/* Bulk controls — set selection and card types for the whole pull at once */}
                  {pullRows.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-gray-500 uppercase tracking-wide">Apply to all:</span>
                      <button
                        onClick={() => patchAllPullRows({ selected: true })}
                        className="px-2 py-1 rounded border border-white/15 text-gray-300 hover:border-white/30 transition-colors"
                      >
                        Select all
                      </button>
                      <button
                        onClick={() => patchAllPullRows({ selected: false })}
                        className="px-2 py-1 rounded border border-white/15 text-gray-300 hover:border-white/30 transition-colors"
                      >
                        Select none
                      </button>
                      <span className="text-white/15">|</span>
                      <button
                        onClick={() => patchAllPullRows({ createSocial: true, createDisplay: false })}
                        className="px-2 py-1 rounded border border-white/15 text-gray-300 hover:border-white/30 transition-colors"
                      >
                        Social only
                      </button>
                      <button
                        onClick={() => patchAllPullRows({ createSocial: true, createDisplay: true })}
                        title="Rarely needed — the display build link is saved on the social card regardless. Only add display cards if they must be exported to TTD from the platform."
                        className="px-2 py-1 rounded border border-white/15 text-gray-300 hover:border-white/30 transition-colors"
                      >
                        Social + Display
                      </button>
                    </div>
                  )}

                  <div className="space-y-2">
                    {pullRows.map((r, idx) => (
                      <div
                        key={`${r.sheetRow}-${idx}`}
                        className={`rounded-lg border p-3 ${r.alreadyImported && r.status !== 'done' ? 'border-white/5 bg-white/[0.01] opacity-60' : 'border-white/10 bg-white/[0.02]'}`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={r.selected}
                            onChange={e => updatePullRow(idx, { selected: e.target.checked })}
                            className="mt-1 flex-none"
                          />
                          <div className="flex-1 min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs text-gray-500">Row {r.sheetRow}</span>
                              <span className="text-sm text-white font-medium">{r.locationName || '(no location)'}</span>
                              {r.focusType && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-300">{r.focusType}</span>}
                              {r.matchConfidence === 'fuzzy' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30">fuzzy match — verify</span>}
                              {r.matchConfidence === 'none' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-400/30">no match — pick location</span>}
                              {r.suspectCopy && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-400/30" title={r.suspectCopy}>
                                  {r.suspectCopy}
                                </span>
                              )}
                              {!r.suspectCopy && !r.parsed.social_headline && !r.parsed.social_subhead && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-400/30">no labelled copy — check</span>
                              )}
                              {r.alreadyImported && r.status !== 'done' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400">already imported</span>}
                              {r.status === 'importing' && <span className="text-[10px] text-gray-400">importing…</span>}
                              {r.status === 'done' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/15 text-teal-300">✓ {r.note}</span>}
                              {r.status === 'error' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300">{r.note}</span>}
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                              <select
                                value={r.locationId}
                                onChange={e => updatePullRow(idx, { locationId: e.target.value })}
                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white"
                              >
                                <option value="">Select location…</option>
                                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                              </select>
                              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                                <input type="checkbox" checked={r.createSocial} onChange={e => updatePullRow(idx, { createSocial: e.target.checked })} /> Social card
                              </label>
                              <label className="flex items-center gap-1.5 text-xs text-gray-300">
                                <input type="checkbox" checked={r.createDisplay} onChange={e => updatePullRow(idx, { createDisplay: e.target.checked })} /> <span title="Only needed if this display set has to be exported to TTD from the platform. The display build LINK is saved on the social card either way.">Separate display card</span>
                              </label>
                            </div>
                            <p className="text-xs text-gray-500 line-clamp-2">{r.parsed.social_copy ?? r.parsed.social_headline ?? '(no copy parsed)'}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  </fieldset>
                </div>
              )}
            </div>

            {/* Results grid */}
            {currentRefreshRows.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-gray-300">
                  {refreshQuarter} {refreshYear} — {currentRefreshRows.length} row{currentRefreshRows.length !== 1 ? 's' : ''}
                </h3>
                <div className="rounded-xl border border-white/10 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-white/5 text-gray-400">
                      <tr>
                        <th className="text-left px-4 py-3 font-medium">Location</th>
                        <th className="text-left px-4 py-3 font-medium">Focus Type</th>
                        <th className="text-left px-4 py-3 font-medium">Social Headline</th>
                        <th className="text-left px-4 py-3 font-medium">Graphic Headline</th>
                        <th className="text-left px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {currentRefreshRows.map(row => {
                        const loc = locations.find(l => l.id === row.location_id)
                        const isExpanded = expandedRow === row.id
                        const edits = editingRefresh[row.id] ?? {}
                        return (
                          // Keyed Fragment, not <>: the key must sit on the outermost
                          // element returned from the map, not on the inner <tr>.
                          <Fragment key={row.id}>
                            <tr className="hover:bg-white/[0.02] transition-colors">
                              <td className="px-4 py-3 font-medium text-white">{loc?.name ?? '—'}</td>
                              <td className="px-4 py-3 text-gray-300">{row.focus_type}</td>
                              <td className="px-4 py-3 text-gray-300 max-w-[180px] truncate">{row.social_headline ?? '—'}</td>
                              <td className="px-4 py-3 text-gray-300 max-w-[180px] truncate">{row.graphic_headline ?? '—'}</td>
                              <td className="px-4 py-3">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                  row.status === 'approved'
                                    ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                    : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                                }`}>
                                  {row.status}
                                </span>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2 justify-end">
                                  <button
                                    onClick={() => isExpanded ? setExpandedRow(null) : startEditRefresh(row)}
                                    className="text-gray-400 hover:text-white text-xs transition-colors"
                                  >
                                    {isExpanded ? 'Close' : 'Edit'}
                                  </button>
                                  {row.status !== 'approved' && (
                                    <button
                                      onClick={() => approveRefreshRow(row.id)}
                                      className="text-teal-500 hover:text-teal-300 text-xs transition-colors"
                                    >
                                      Approve
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr key={`${row.id}-expanded`} className="bg-gray-900/60">
                                <td colSpan={6} className="px-4 py-4">
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {(
                                      [
                                        { key: 'social_headline', label: 'Social Headline' },
                                        { key: 'social_subhead', label: 'Social Subhead' },
                                        { key: 'graphic_headline', label: 'Graphic Headline' },
                                        { key: 'graphic_subhead', label: 'Graphic Subhead' },
                                        { key: 'facebook_url', label: 'FB URL (H)' },
                                        { key: 'display_url', label: 'Display URL (I)' },
                                        { key: 'social_build_box_link', label: 'Social Box (AW)' },
                                        { key: 'display_build_box_link', label: 'Display Box (AU)' },
                                        { key: 'adpiler_link', label: 'Adviewer Link' },
                                      ] as { key: keyof AtlasCreativeRefresh; label: string }[]
                                    ).map(({ key, label }) => (
                                      <div key={key}>
                                        <label className="block text-xs text-gray-400 mb-1">{label}</label>
                                        <input
                                          type="text"
                                          value={String(edits[key] ?? row[key] ?? '')}
                                          onChange={e => setEditingRefresh(prev => ({
                                            ...prev,
                                            [row.id]: { ...prev[row.id], [key]: e.target.value },
                                          }))}
                                          className="w-full bg-gray-800 border border-white/10 rounded px-3 py-2 text-sm text-white"
                                        />
                                      </div>
                                    ))}
                                    <div className="md:col-span-2">
                                      <label className="block text-xs text-gray-400 mb-1">Social Copy</label>
                                      <textarea
                                        rows={3}
                                        value={String(edits.social_copy ?? row.social_copy ?? '')}
                                        onChange={e => setEditingRefresh(prev => ({
                                          ...prev,
                                          [row.id]: { ...prev[row.id], social_copy: e.target.value },
                                        }))}
                                        className="w-full bg-gray-800 border border-white/10 rounded px-3 py-2 text-sm text-white resize-none"
                                      />
                                    </div>
                                  </div>
                                  <div className="mt-4 flex flex-wrap gap-3 items-center">
                                    <button
                                      onClick={() => saveRefreshRow(row.id)}
                                      disabled={savingRefresh.has(row.id)}
                                      className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
                                    >
                                      {savingRefresh.has(row.id) ? 'Saving…' : 'Save Changes'}
                                    </button>
                                    <button
                                      onClick={() => setExpandedRow(null)}
                                      className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors"
                                    >
                                      Cancel
                                    </button>
                                    <div className="w-px h-6 bg-white/10 mx-1" />
                                    <button
                                      onClick={() => createReviewCard(row)}
                                      title="Create the 1080×1080 social review card (Social Ad Request) on the Atlas board"
                                      className="px-4 py-2 bg-sky-600/80 hover:bg-sky-500 rounded-lg text-sm font-medium transition-colors"
                                    >
                                      Create review card
                                    </button>
                                    <button
                                      onClick={() => createDisplayCard(row)}
                                      title="Create the internal HTML5 display card (kept off client review)"
                                      className="px-4 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm font-medium transition-colors"
                                    >
                                      Create display card
                                    </button>
                                    {createNote[row.id] && (
                                      <span className="text-xs text-teal-300">{createNote[row.id]}</span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {currentRefreshRows.length === 0 && (
              <div className="rounded-xl border border-white/10 py-16 text-center text-gray-500">
                No copy generated for {refreshQuarter} {refreshYear} yet.
                <br />
                <span className="text-sm">Select locations above and click Generate.</span>
              </div>
            )}
          </div>
        )}

        {/* ── BRANDING ASSETS TAB ── */}
        {tab === 'branding' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Branding Assets</h2>
              <p className="text-gray-400 text-sm mt-0.5">Box links for logos and brand kits per location</p>
            </div>

            <div className="space-y-3">
              {locations.length === 0 && (
                <div className="rounded-xl border border-white/10 py-16 text-center text-gray-500">
                  No locations yet. Add locations in Creative Parameters first.
                </div>
              )}
              {locations.map(loc => {
                const locAssets = assetsByLocation.get(loc.id) ?? []
                const isExpanded = expandedBrandingLocation === loc.id
                return (
                  <div key={loc.id} className="rounded-xl border border-white/10 overflow-hidden">
                    <button
                      onClick={() => setExpandedBrandingLocation(isExpanded ? null : loc.id)}
                      className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/[0.02] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-medium text-white">{loc.name}</span>
                        <span className="text-xs text-gray-500 bg-white/5 px-2 py-0.5 rounded-full">
                          {locAssets.length} asset{locAssets.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <span className="text-gray-500 text-sm">{isExpanded ? '▲' : '▼'}</span>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-white/10 p-4 space-y-3 bg-white/[0.02]">
                        {locAssets.length === 0 && (
                          <p className="text-gray-500 text-sm">No assets yet.</p>
                        )}
                        {locAssets.map(asset => (
                          <div key={asset.id} className="flex items-center gap-3 group">
                            <div className="flex-1">
                              <span className="text-sm font-medium text-gray-200">{asset.label}</span>
                              {asset.box_url && (
                                <ExternalRef url={asset.box_url} note={asset.label} className="ml-3" />
                              )}
                            </div>
                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => openEditAsset(asset, loc)}
                                className="text-gray-400 hover:text-white text-xs transition-colors"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => { if (confirm(`Delete "${asset.label}"?`)) deleteAsset(asset.id) }}
                                className="text-gray-600 hover:text-red-400 text-xs transition-colors"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        ))}
                        <button
                          onClick={() => openAddAsset(loc)}
                          className="text-sm text-teal-400 hover:text-teal-300 transition-colors"
                        >
                          + Add asset
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </main>
      )}

      {/* ── LOCATION MODAL ── */}
      {locationModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-white/10 rounded-2xl w-full max-w-md p-6 space-y-5">
            <h2 className="text-lg font-semibold">
              {locationModal.editing ? `Edit ${locationModal.editing.name}` : 'Add Location'}
            </h2>
            <div className="space-y-4">
              {(
                [
                  { key: 'name', label: 'Center Name', placeholder: 'e.g. Atlas Lakeside Oncology' },
                  { key: 'landscape', label: 'Landscape', placeholder: 'e.g. Urban, Suburban, Rural' },
                  { key: 'age_demo', label: 'Age Demo', placeholder: 'e.g. 55+, 35–65' },
                  { key: 'ethnicity_demo', label: 'Ethnicity Demo', placeholder: 'e.g. General Market, Hispanic' },
                  // Text fields only — `shares_creative` is a boolean and renders as its
                  // own checkbox below, so it must not widen this generic <input> map.
                ] as { key: TextLocationFormKey; label: string; placeholder: string }[]
              ).map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="block text-xs text-gray-400 mb-1">{label}</label>
                  <input
                    type="text"
                    value={locationModal.form[key] ?? ''}
                    onChange={e => setLocationModal(prev => ({ ...prev, form: { ...prev.form, [key]: e.target.value } }))}
                    placeholder={placeholder}
                    className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500"
                  />
                </div>
              ))}
              {/* Advertiser name is what a client reads on the Adviewer mockup, so it is
                  required and sits next to the fields that shape the creative. Left out,
                  the location's ads silently fall back to the Atlas client record and read
                  "Atlas Health Network". Not in the generic map above because it
                  carries its own hint and a paired checkbox. */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Advertiser Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={locationModal.form.advertiser_name}
                  onChange={e => setLocationModal(prev => ({ ...prev, form: { ...prev.form, advertiser_name: e.target.value } }))}
                  placeholder="e.g. Lakeside"
                  className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500"
                />
                <p className="mt-1 text-[11px] text-gray-500">
                  The Facebook page name the client sees on the ad. Short form — &ldquo;Lakeside&rdquo;, not
                  &ldquo;Lakeside Cancer Center&rdquo;. Practices under one brand share a name (all MetroCare
                  locations use &ldquo;MetroCare&rdquo;).
                </p>
              </div>
              <div>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={locationModal.form.shares_creative}
                    onChange={e => setLocationModal(prev => ({ ...prev, form: { ...prev.form, shares_creative: e.target.checked } }))}
                    className="mt-0.5 accent-teal-500"
                  />
                  <span className="text-xs text-gray-300">
                    One creative for the whole brand
                    <span className="block text-[11px] text-gray-500">
                      Import makes a single card per focus for every location sharing this advertiser
                      name, instead of one each. True for ScanCo only today — leave off unless the brand
                      genuinely ships one build for all its practices.
                    </span>
                  </span>
                </label>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Key Notes</label>
                <textarea
                  rows={3}
                  value={locationModal.form.key_notes ?? ''}
                  onChange={e => setLocationModal(prev => ({ ...prev, form: { ...prev.form, key_notes: e.target.value } }))}
                  placeholder="Important context for AI copy generation…"
                  className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setLocationModal({ open: false, editing: null, form: blankLocation() })}
                className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveLocation}
                disabled={locationSaving || !locationModal.form.name.trim() || !locationModal.form.advertiser_name.trim()}
                className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
              >
                {locationSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ASSET MODAL ── */}
      {assetModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-white/10 rounded-2xl w-full max-w-sm p-6 space-y-5">
            <h2 className="text-lg font-semibold">
              {assetModal.editing ? 'Edit Asset' : `Add Asset — ${assetModal.location?.name}`}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Label</label>
                <input
                  type="text"
                  value={assetModal.form.label}
                  onChange={e => setAssetModal(prev => ({ ...prev, form: { ...prev.form, label: e.target.value } }))}
                  placeholder="e.g. Logo, Brand Kit, Photography"
                  className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Box URL</label>
                <input
                  type="url"
                  value={assetModal.form.box_url ?? ''}
                  onChange={e => setAssetModal(prev => ({ ...prev, form: { ...prev.form, box_url: e.target.value } }))}
                  placeholder="External Box folder link"
                  className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setAssetModal({ open: false, editing: null, location: null, form: blankAsset('') })}
                className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveAsset}
                disabled={assetSaving || !assetModal.form.label.trim()}
                className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
              >
                {assetSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
