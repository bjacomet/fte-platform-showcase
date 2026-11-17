'use client'

import { useState, useRef, useCallback, useMemo } from 'react'
import Link from 'next/link'
import type {
  PlannedBudget, SpendUpload, SpendDataRow, CampaignMapping,
  PacingRow, PacingSeverity, ClientMetadata, CampaignMetadata, CampaignTask
} from './page'

// ── Pacing color engine ───────────────────────────────────────────────────────
// variance: negative = underspend, positive = overspend (as fraction, e.g. -0.15 = 15% under)
function interpolateColor(a: [number,number,number], b: [number,number,number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  return `rgb(${r},${g},${bl})`
}

function getPacingStyle(variancePct: number | null): {
  bg: string; text: string; label: string; tier: number
} {
  if (variancePct === null) return { bg: 'rgb(30,30,40)', text: '#888', label: 'No data', tier: 0 }

  // variancePct: (actual - expected) / expected * 100
  // Negative = underspend, positive = overspend

  const COLORS = {
    onPace:    [22,163,74]   as [number,number,number],  // green-600
    lightRed:  [248,113,113] as [number,number,number],  // red-400
    red:       [220,38,38]   as [number,number,number],  // red-600
    deepRed:   [127,29,29]   as [number,number,number],  // red-900
    darkest:   [80,10,10]    as [number,number,number],  // near-black red
    lightGreen:[74,222,128]  as [number,number,number],  // green-400
    deepGreen: [20,83,45]    as [number,number,number],  // green-900
  }

  // ── Underspend (variance < 0) → RED ───────────────────────────────────────
  if (variancePct <= -100) {
    return { bg: `rgb(${COLORS.darkest.join(',')})`, text: '#fca5a5', label: 'Not spending', tier: -7 }
  }
  if (variancePct < 0) {
    const under = Math.abs(variancePct)
    let bg: string
    let tier: number
    let label: string

    if (under <= 5) {
      const t = under / 5
      bg = interpolateColor(COLORS.onPace, COLORS.lightRed, t * 0.5)
      tier = -1; label = `${under.toFixed(1)}% under`
    } else if (under <= 15) {
      const t = (under - 5) / 10
      bg = interpolateColor(COLORS.lightRed, COLORS.red, t * 0.6)
      tier = -2; label = `${under.toFixed(1)}% under`
    } else if (under <= 25) {
      const t = (under - 15) / 10
      bg = interpolateColor(COLORS.lightRed, COLORS.red, 0.6 + t * 0.4)
      tier = -3; label = `${under.toFixed(1)}% under`
    } else if (under <= 50) {
      const t = (under - 25) / 25
      bg = interpolateColor(COLORS.red, COLORS.deepRed, t * 0.5)
      tier = -4; label = `${under.toFixed(1)}% under`
    } else if (under <= 75) {
      const t = (under - 50) / 25
      bg = interpolateColor(COLORS.deepRed, COLORS.darkest, t * 0.5)
      tier = -5; label = `${under.toFixed(1)}% under`
    } else {
      const t = (under - 75) / 25
      bg = interpolateColor(COLORS.deepRed, COLORS.darkest, 0.5 + Math.min(t, 1) * 0.5)
      tier = -6; label = `${under.toFixed(1)}% under`
    }
    return { bg, text: '#fff', label, tier }
  }

  // ── On pace (0–10% over) → GREEN ──────────────────────────────────────────
  if (variancePct <= 10) {
    return { bg: `rgb(${COLORS.onPace.join(',')})`, text: '#fff', label: variancePct <= 1 ? 'On pace' : `${variancePct.toFixed(1)}% over`, tier: 0 }
  }

  // ── Overspend (variance > 10%) → GREEN ────────────────────────────────────
  const over = variancePct
  let bg: string; let tier: number; let label: string

  if (over <= 25) {
    const t = (over - 10) / 15
    bg = interpolateColor(COLORS.onPace, COLORS.lightGreen, t)
    tier = 1; label = `${over.toFixed(1)}% over`
  } else if (over <= 50) {
    const t = (over - 25) / 25
    bg = interpolateColor(COLORS.lightGreen, COLORS.onPace, t)
    tier = 2; label = `${over.toFixed(1)}% over`
  } else if (over <= 100) {
    const t = (over - 50) / 50
    bg = interpolateColor(COLORS.onPace, COLORS.deepGreen, t)
    tier = 3; label = `${over.toFixed(1)}% over`
  } else {
    bg = `rgb(${COLORS.deepGreen.join(',')})`
    tier = 4; label = `${over.toFixed(1)}% over`
  }
  return { bg, text: '#fff', label, tier }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const MONTH_NAMES = ['','January','February','March','April','May','June',
  'July','August','September','October','November','December']

function fmt(n: number, unit: 'currency' | 'impressions' = 'currency') {
  if (unit === 'impressions') {
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
  }
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

// TTD campaigns sold on impression targets, not dollar spend. Only these three
// campaign types are impression-denominated; everything else (Social — Meta, FB,
// IG, TikTok, Reddit, NextDoor…) is dollar-denominated. Must stay in sync with
// the actual_spend CASE in v_pacing_current (migration 20260710_009).
const IMPRESSION_BASED_TYPES = new Set(['display', 'ctv', 'audio'])

function isImpressionBased(campaignType: string): boolean {
  return IMPRESSION_BASED_TYPES.has(campaignType?.toLowerCase() ?? '')
}

function fmtUnit(n: number, campaignType: string) {
  return fmt(n, isImpressionBased(campaignType) ? 'impressions' : 'currency')
}

// ── Triage severity presentation ──────────────────────────────────────────────
const SEVERITY_ORDER: PacingSeverity[] = ['critical', 'action_needed', 'watch', 'clean']

const SEVERITY_META: Record<PacingSeverity, { label: string; dot: string; bar: string }> = {
  critical:      { label: 'Critical',      dot: '#ef4444', bar: 'border-red-500/50 bg-red-950/20' },
  action_needed: { label: 'Action needed', dot: '#f97316', bar: 'border-orange-500/50 bg-orange-950/20' },
  watch:         { label: 'Watch',         dot: '#eab308', bar: 'border-yellow-500/40 bg-yellow-950/15' },
  clean:         { label: 'Clean',         dot: '#22c55e', bar: 'border-green-600/40 bg-green-950/10' },
}

function suggestedAction(row: PacingRow): string {
  if (row.has_creative === false && (row.flight_status === 'active' || row.flight_status === 'ended'))
    return 'Creative missing/blocked while live — check the media plan CT tab and traffic creative.'
  if (row.has_creative === false)
    return 'Upcoming budget with no creative yet — line up creative before the flight starts.'
  if (row.flight_status === 'not_started')
    return 'Flight has not started — nothing to do yet.'
  if (row.expected_spend > 0 && row.actual_spend === 0)
    return 'No spend recorded — confirm the campaign is live and trafficked.'
  if (row.deviation_pct !== null && row.deviation_pct >= 20)
    return 'Spending ahead of pace — consider capping or reallocating budget.'
  if (row.deviation_pct !== null && row.deviation_pct <= -25)
    return 'Underpacing — increase delivery or reallocate to faster-pacing lines.'
  if (row.severity === 'watch')
    return 'Minor drift — keep an eye on it over the next few days.'
  return 'On pace.'
}

function flightLabel(row: PacingRow): string | null {
  switch (row.flight_status) {
    case 'no_dates':    return '⚠ Flight dates not set'
    case 'not_started': return 'Scheduled — not started'
    case 'ended':       return 'Flight ended'
    case 'active':      return row.flight_ends_in_days !== null && row.flight_ends_in_days <= 5
      ? `Ends in ${row.flight_ends_in_days}d` : null
    default:            return null
  }
}

// ── Platform chip colors ──────────────────────────────────────────────────────
function getPlatformChip(platform: string): { bg: string; text: string } {
  switch (platform?.toLowerCase()) {
    case 'ttd':      return { bg: 'rgba(0,117,169,0.3)',   text: '#60c9f0' }
    case 'social':   return { bg: 'rgba(24,119,242,0.25)', text: '#91b4f5' }
    case 'youtube':  return { bg: 'rgba(255,0,0,0.2)',     text: '#ff8080' }
    case 'nextdoor': return { bg: 'rgba(0,178,70,0.2)',    text: '#4ade80' }
    default:         return { bg: 'rgba(75,85,99,0.3)',    text: '#9ca3af' }
  }
}

// ── Client-level rollup type (clients view) ───────────────────────────────────
// Totals are split by unit — impressions (TTD Display/CTV/Audio) and dollars
// (Social) can't be summed into one figure, so each client tracks both buckets.
interface UnitAgg { planned: number; expected: number; actual: number }
interface ClientRollup {
  client_name: string
  campaigns: PacingRow[]
  imp: UnitAgg
  usd: UnitAgg
  worstSeverity: PacingSeverity
  impDeviationPct: number | null
  usdDeviationPct: number | null
  sortDeviationPct: number | null
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface Props {
  userEmail: string
  currentMonth: number
  currentYear: number
  initialBudgets: PlannedBudget[]
  initialUploads: SpendUpload[]
  initialSpendData: SpendDataRow[]
  initialMappings: CampaignMapping[]
  initialPacing: PacingRow[]
  initialClientMeta: ClientMetadata[]
  initialCampaignMeta: CampaignMetadata[]
  initialTasks: CampaignTask[]
  prevSpendData: SpendDataRow[]
  daysInMonth: number
  dayOfMonth: number
}

// ── Client-side XLSX parser ───────────────────────────────────────────────────
// Parses in the browser so only extracted rows are sent to the server,
// bypassing Vercel's 4.5MB request body limit on large TTD/Facebook reports.
// Scans all sheets and all rows to find the header — TTD reports typically
// have several metadata rows above the actual column headers.
async function parseXlsxClientSide(
  file: File,
  source: 'ttd' | 'facebook'
): Promise<Array<{ advertiser: string; campaign: string; adGroup?: string; spend: number; impressions: number; clicks: number }>> {
  const XLSX = await import('xlsx')
  const buffer = await file.arrayBuffer()
  // Skip styles, formulas, HTML, and date parsing — we only need raw cell values.
  // These flags cut parse time by ~70% on large TTD reports.
  const wb = XLSX.read(new Uint8Array(buffer), {
    type: 'array',
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    cellDates: false,
    raw: true,
  })

  // The sentinel identifies the header row in whichever sheet contains it
  const sentinel = source === 'ttd' ? 'Advertiser' : 'Account'

  // Find the first sheet + row where the sentinel column appears
  const sheetsToTry = source === 'ttd'
    ? [
        wb.Sheets['Ad Group Performance'],
        ...wb.SheetNames.filter(n => n !== 'Ad Group Performance').map(n => wb.Sheets[n]),
      ].filter(Boolean)
    : wb.SheetNames.map(n => wb.Sheets[n]).filter(Boolean)

  let headerIdx = -1
  let allRows: unknown[][] = []
  for (const ws of sheetsToTry) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as unknown[][]
    const hi = rows.findIndex(r => r.some(c => String(c).trim() === sentinel))
    if (hi >= 0) { allRows = rows; headerIdx = hi; break }
  }
  if (headerIdx < 0) return []

  const header = allRows[headerIdx].map(h => String(h).trim())
  const col = (name: string) => header.indexOf(name)
  const dataRows = allRows.slice(headerIdx + 1)

  if (source === 'ttd') {
    const iA = col('Advertiser')
    const iC = col('Campaign')
    const iG = col('Ad Group')
    const iS = col('Advertiser Cost (Adv Currency)') !== -1
      ? col('Advertiser Cost (Adv Currency)')
      : col('Advertiser Cost')
    const iI = col('Impressions')
    const iK = col('Clicks')
    return dataRows
      .map(r => {
        const row = r as unknown[]
        return {
          advertiser:  String(row[iA] ?? '').trim(),
          campaign:    String(row[iC] ?? '').trim(),
          adGroup:     String(row[iG] ?? '').trim(),
          spend:       parseFloat(String(row[iS] ?? '0')) || 0,
          impressions: parseInt(  String(row[iI] ?? '0')) || 0,
          clicks:      parseInt(  String(row[iK] ?? '0')) || 0,
        }
      })
      .filter(r => r.advertiser)
  } else {
    const iA = col('Account')
    const iC = col('Campaign')
    const iS = col('Spend')
    const iI = col('Impressions')
    const iK = col('Clicks')
    return dataRows
      .map(r => {
        const row = r as unknown[]
        return {
          advertiser:  String(row[iA] ?? '').trim(),
          campaign:    String(row[iC] ?? '').trim(),
          spend:       parseFloat(String(row[iS] ?? '0')) || 0,
          impressions: parseInt(  String(row[iI] ?? '0')) || 0,
          clicks:      parseInt(  String(row[iK] ?? '0')) || 0,
        }
      })
      .filter(r => r.advertiser)
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function PacingClient({
  userEmail,
  currentMonth,
  currentYear,
  initialBudgets,
  initialUploads,
  initialSpendData,
  initialMappings,
  initialPacing,
  initialClientMeta,
  initialCampaignMeta,
  initialTasks,
  prevSpendData,
  daysInMonth,
  dayOfMonth,
}: Props) {
  const [budgets,    setBudgets]    = useState<PlannedBudget[]>(initialBudgets)
  const [uploads,    setUploads]    = useState<SpendUpload[]>(initialUploads)
  const [spendData,  setSpendData]  = useState<SpendDataRow[]>(initialSpendData)
  const [mappings,   setMappings]   = useState<CampaignMapping[]>(initialMappings)
  const [tab,           setTab]          = useState<'all'|'ttd'|'social'|'youtube'>('all')
  const [view,          setView]         = useState<'triage'|'pacing'|'clients'|'mappings'|'import'|'checklist'>('triage')
  const [expandedClients, setExpandedClients] = useState<Set<string>>(() => new Set())
  const [selectedPacing, setSelectedPacing] = useState<PacingRow | null>(null)
  const [uploading,     setUploading]    = useState<'ttd'|'facebook'|null>(null)
  const [uploadMsg,     setUploadMsg]    = useState<string>('')
  const [searchQ,       setSearchQ]      = useState('')
  const [newMapping,    setNewMapping]   = useState<Partial<CampaignMapping> | null>(null)
  const [savingMap,     setSavingMap]    = useState(false)
  const [importText,    setImportText]   = useState('')
  const [importing,     setImporting]    = useState(false)
  const [exporting,     setExporting]    = useState(false)
  const [exportMsg,     setExportMsg]    = useState('')
  const [scanStatus,    setScanStatus]   = useState<{
    last_scanned_at: string | null
    scanned_count: number
    total_clients: number
    not_scanned: string[]
    results: Array<{ client_name: string; platform: string; has_creative: boolean | null; creative_details?: string }>
  } | null>(null)
  const [scanning,      setScanning]     = useState(false)
  const [scanMsg,       setScanMsg]      = useState('')
  const [rowAssignments, setRowAssignments] = useState<Record<string, string>>({})
  const [savingRowId,    setSavingRowId]   = useState<string | null>(null)
  const [sortMode,       setSortMode]      = useState<'default'|'underspend'|'overspend'>('default')

  const ttdRef = useRef<HTMLInputElement>(null)
  const fbRef  = useRef<HTMLInputElement>(null)

  // ── Upload handler ──────────────────────────────────────────────────────────
  const handleUpload = useCallback(async (source: 'ttd' | 'facebook', file: File) => {
    setUploading(source)
    setUploadMsg('')

    // Yield to the event loop so the "Uploading…" spinner renders before the
    // synchronous XLSX parse blocks the main thread.
    await new Promise<void>(resolve => setTimeout(resolve, 50))

    try {
      const isXlsx = file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')
      let res: Response

      if (isXlsx) {
        // Parse in the browser → send rows as JSON (no file body, no 4.5MB limit)
        const rows = await parseXlsxClientSide(file, source)
        if (!rows.length) throw new Error('No data rows found — check that the file has the expected columns')
        res = await fetch('/api/pacing/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, month: currentMonth, year: currentYear, userEmail, rows }),
        })
      } else {
        // CSV: send as FormData (text files stay well under the limit)
        const fd = new FormData()
        fd.append('source', source)
        fd.append('month', String(currentMonth))
        fd.append('year',  String(currentYear))
        fd.append('userEmail', userEmail)
        fd.append('file', file)
        res = await fetch('/api/pacing/upload', { method: 'POST', body: fd })
      }

      if (!res.ok) {
        const text = await res.text()
        let msg: string
        try { msg = (JSON.parse(text) as { error?: string }).error ?? `Upload failed (${res.status})` }
        catch { msg = `Upload failed (${res.status})` }
        throw new Error(msg)
      }
      const json = await res.json()

      const msg = `✓ Uploaded ${json.rowCount} campaigns · $${json.totalSpend.toLocaleString(undefined,{maximumFractionDigits:0})} total spend` +
        (json.unmappedCount > 0 ? ` · ⚠ ${json.unmappedCount} unmapped` : '')
      setUploadMsg(msg)

      // Re-fetch spend data via page reload (simplest for now)
      window.location.reload()
    } catch (e: unknown) {
      setUploadMsg(`✗ ${e instanceof Error ? e.message : 'Upload failed'}`)
    } finally {
      setUploading(null)
    }
  }, [currentMonth, currentYear, userEmail])

  // ── Pacing rows computation ─────────────────────────────────────────────────
  const pacingRows = useMemo(() => {
    const elapsedFraction = dayOfMonth / daysInMonth

    // Group spend (dollars) and impressions separately by mapping key
    const spendByKey       = new Map<string, number>()
    const impressionsByKey = new Map<string, number>()
    for (const row of spendData) {
      if (!row.campaign_mappings) continue
      const { planned_client, planned_platform, planned_campaign_type } = row.campaign_mappings
      const key = `${planned_client}||${planned_platform}||${planned_campaign_type}`
      spendByKey.set(key,       (spendByKey.get(key)       ?? 0) + row.spend)
      impressionsByKey.set(key, (impressionsByKey.get(key) ?? 0) + row.impressions)
    }

    // Join with budgets
    return budgets
      .filter(b => {
        if (tab === 'ttd')     return b.platform === 'TTD' && !b.campaign_type.toLowerCase().includes('youtube')
        if (tab === 'social')  return b.platform !== 'TTD' && !b.campaign_type.toLowerCase().includes('youtube')
        if (tab === 'youtube') return b.campaign_type.toLowerCase().includes('youtube')
        return true
      })
      .filter(b => !searchQ || b.client_name.toLowerCase().includes(searchQ.toLowerCase()))
      .map(b => {
        const key             = `${b.client_name}||${b.platform}||${b.campaign_type}`
        const actual          = spendByKey.get(key) ?? null
        const actualImps      = impressionsByKey.get(key) ?? null
        const expected        = b.planned_amount * elapsedFraction
        // For impression-based campaigns (Display, CTV, etc.) compare actual
        // impressions vs expected impressions. For dollar-based (Social) compare
        // dollar spend vs expected dollar spend.
        const actualForPacing = isImpressionBased(b.campaign_type) ? actualImps : actual
        const variance        = actualForPacing !== null && expected > 0
          ? ((actualForPacing - expected) / expected) * 100
          : null

        // Budget recommendation: CPM from actuals + $0.10 buffer
        const cpm = actualImps !== null && actualImps > 0 && actual !== null
          ? (actual / actualImps) * 1000
          : null
        const suggestedCpm        = cpm !== null ? cpm + 0.10 : null
        const recommendedTotal    = suggestedCpm !== null
          ? (b.planned_amount / 1000) * suggestedCpm
          : null
        const remainingImps       = actualImps !== null
          ? Math.max(0, b.planned_amount - actualImps)
          : b.planned_amount
        const additionalNeeded    = suggestedCpm !== null
          ? (remainingImps / 1000) * suggestedCpm
          : null

        return { ...b, actual, actualImps, expected, variance, cpm, suggestedCpm, recommendedTotal, remainingImps, additionalNeeded }
      })
      .sort((a, b) => {
        // Sort: unmapped last, then by variance severity (most critical first)
        if (a.actual === null && b.actual !== null) return 1
        if (a.actual !== null && b.actual === null) return -1
        if (a.variance === null && b.variance !== null) return 1
        if (a.variance !== null && b.variance === null) return -1
        return (Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0))
      })
  }, [budgets, spendData, tab, searchQ, dayOfMonth, daysInMonth])

  // ── Unmapped spend rows ─────────────────────────────────────────────────────
  const unmappedRows = useMemo(() =>
    spendData.filter(r => !r.mapping_id),
    [spendData]
  )

  // ── Budget options for assignment dropdowns ──────────────────────────────────
  const budgetOptions = useMemo(() =>
    budgets.map(b => ({
      value: `${b.client_name}||${b.platform}||${b.campaign_type}`,
      label: `${b.client_name}${b.campaign_type !== 'Display' ? ` (${b.campaign_type})` : ''}`,
      platform: b.platform,
    })),
    [budgets]
  )

  // ── Filtered pacing rows (triage + clients views — respects tab + search) ────
  const filteredPacing = useMemo(() => {
    return initialPacing
      .filter(r => {
        if (tab === 'ttd')     return r.platform === 'TTD' && !(r.campaign_type?.toLowerCase().includes('youtube'))
        if (tab === 'social')  return r.platform !== 'TTD' && !(r.campaign_type?.toLowerCase().includes('youtube'))
        if (tab === 'youtube') return r.campaign_type?.toLowerCase().includes('youtube')
        return true
      })
      .filter(r => !searchQ || r.client_name.toLowerCase().includes(searchQ.toLowerCase()))
  }, [initialPacing, tab, searchQ])

  // ── Triage grouping (severity buckets from v_pacing_current) ─────────────────
  const triageGroups = useMemo(() => {
    const groups: Record<PacingSeverity, PacingRow[]> = { critical: [], action_needed: [], watch: [], clean: [] }
    for (const r of filteredPacing) (groups[r.severity] ?? groups.clean).push(r)
    for (const k of SEVERITY_ORDER) {
      groups[k].sort((a, b) => Math.abs(b.deviation_pct ?? 0) - Math.abs(a.deviation_pct ?? 0))
    }
    return groups
  }, [filteredPacing])

  // ── Sort-mode derived lists ─────────────────────────────────────────────────
  const sortedTriageSections = useMemo((): { label: string; color: string; rows: PacingRow[] }[] | null => {
    if (sortMode === 'default') return null
    const all = SEVERITY_ORDER.flatMap(s => triageGroups[s])
    if (sortMode === 'underspend') {
      const under = all.filter(r => (r.deviation_pct ?? 0) < 0).sort((a, b) => (a.deviation_pct ?? 0) - (b.deviation_pct ?? 0))
      const over  = all.filter(r => (r.deviation_pct ?? 0) >= 0).sort((a, b) => (b.deviation_pct ?? 0) - (a.deviation_pct ?? 0))
      return [
        { label: 'Under-pacing', color: '#f87171', rows: under },
        { label: 'On Pace / Over-pacing', color: '#4ade80', rows: over },
      ].filter(s => s.rows.length > 0)
    }
    const over  = all.filter(r => (r.deviation_pct ?? 0) > 0).sort((a, b) => (b.deviation_pct ?? 0) - (a.deviation_pct ?? 0))
    const under = all.filter(r => (r.deviation_pct ?? 0) <= 0).sort((a, b) => (a.deviation_pct ?? 0) - (b.deviation_pct ?? 0))
    return [
      { label: 'Over-pacing', color: '#4ade80', rows: over },
      { label: 'On Pace / Under-pacing', color: '#f87171', rows: under },
    ].filter(s => s.rows.length > 0)
  }, [triageGroups, sortMode])

  const sortedPacingRows = useMemo(() => {
    if (sortMode === 'default') return pacingRows
    if (sortMode === 'underspend') {
      const under = pacingRows.filter(r => (r.variance ?? 0) < 0).sort((a, b) => (a.variance ?? 0) - (b.variance ?? 0))
      const over  = pacingRows.filter(r => (r.variance ?? 0) >= 0)
      return [...under, ...over]
    }
    const over  = pacingRows.filter(r => (r.variance ?? 0) > 0).sort((a, b) => (b.variance ?? 0) - (a.variance ?? 0))
    const under = pacingRows.filter(r => (r.variance ?? 0) <= 0)
    return [...over, ...under]
  }, [pacingRows, sortMode])

  // ── Stale detection: current and previous impressions by campaign key ────────
  const currImpsByKey = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of spendData) {
      if (!row.campaign_mappings) continue
      const { planned_client, planned_platform, planned_campaign_type } = row.campaign_mappings
      const key = `${planned_client}|${planned_platform}|${planned_campaign_type}`
      map.set(key, (map.get(key) ?? 0) + row.impressions)
    }
    return map
  }, [spendData])

  const prevSpendByKey = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of prevSpendData) {
      if (!row.campaign_mappings) continue
      const { planned_client, planned_platform, planned_campaign_type } = row.campaign_mappings
      const key = `${planned_client}|${planned_platform}|${planned_campaign_type}`
      map.set(key, (map.get(key) ?? 0) + row.impressions)
    }
    return map
  }, [prevSpendData])

  // ── Client-level rollups for the Clients view ─────────────────────────────
  // Totals are split by unit: impression-based campaigns (Display/CTV/Audio) and
  // dollar-based campaigns (Social) accumulate into separate buckets so a client
  // running both never gets impressions added to dollars.
  const SEV_ORDER_NUM: Record<PacingSeverity, number> = { critical: 0, action_needed: 1, watch: 2, clean: 3 }

  const clientRollups = useMemo((): ClientRollup[] => {
    const dev = (u: UnitAgg): number | null =>
      u.expected > 0 ? Math.round(((u.actual - u.expected) / u.expected) * 100 * 10) / 10 : null

    const map = new Map<string, ClientRollup>()
    for (const r of filteredPacing) {
      if (!map.has(r.client_name)) {
        map.set(r.client_name, {
          client_name: r.client_name,
          campaigns: [],
          imp: { planned: 0, expected: 0, actual: 0 },
          usd: { planned: 0, expected: 0, actual: 0 },
          worstSeverity: 'clean',
          impDeviationPct: null,
          usdDeviationPct: null,
          sortDeviationPct: null,
        })
      }
      const entry  = map.get(r.client_name)!
      const bucket = isImpressionBased(r.campaign_type) ? entry.imp : entry.usd
      entry.campaigns.push(r)
      bucket.planned  += r.planned_amount
      bucket.actual   += r.actual_spend
      bucket.expected += r.expected_spend
      if (SEV_ORDER_NUM[r.severity] < SEV_ORDER_NUM[entry.worstSeverity]) {
        entry.worstSeverity = r.severity
      }
    }
    return Array.from(map.values()).map(entry => {
      const impDeviationPct = dev(entry.imp)
      const usdDeviationPct = dev(entry.usd)
      // Sort key: the more extreme of the two unit deviations (by magnitude).
      const candidates = [impDeviationPct, usdDeviationPct].filter((d): d is number => d !== null)
      const sortDeviationPct = candidates.length
        ? candidates.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a))
        : null
      return { ...entry, impDeviationPct, usdDeviationPct, sortDeviationPct }
    }).sort((a, b) => {
      if (SEV_ORDER_NUM[a.worstSeverity] !== SEV_ORDER_NUM[b.worstSeverity])
        return SEV_ORDER_NUM[a.worstSeverity] - SEV_ORDER_NUM[b.worstSeverity]
      return (a.sortDeviationPct ?? 0) - (b.sortDeviationPct ?? 0)
    })
  }, [filteredPacing])

  const sortedClientRollups = useMemo((): ClientRollup[] => {
    if (sortMode === 'default') return clientRollups
    if (sortMode === 'underspend') {
      const under = clientRollups.filter(c => (c.sortDeviationPct ?? 0) < 0).sort((a, b) => (a.sortDeviationPct ?? 0) - (b.sortDeviationPct ?? 0))
      const over  = clientRollups.filter(c => (c.sortDeviationPct ?? 0) >= 0).sort((a, b) => (b.sortDeviationPct ?? 0) - (a.sortDeviationPct ?? 0))
      return [...under, ...over]
    }
    const over  = clientRollups.filter(c => (c.sortDeviationPct ?? 0) > 0).sort((a, b) => (b.sortDeviationPct ?? 0) - (a.sortDeviationPct ?? 0))
    const under = clientRollups.filter(c => (c.sortDeviationPct ?? 0) <= 0).sort((a, b) => (a.sortDeviationPct ?? 0) - (b.sortDeviationPct ?? 0))
    return [...over, ...under]
  }, [clientRollups, sortMode])

  // ── Upload status cards ─────────────────────────────────────────────────────
  const ttdUpload  = uploads.find(u => u.report_source === 'ttd')
  const fbUpload   = uploads.find(u => u.report_source === 'facebook')

  // ── Summary totals (split by unit — impressions vs dollars) ──────────────────
  // Impression rows (Display/CTV/Audio) use impression delivery; dollar rows
  // (Social) use dollar spend. Never summed together.
  const summaryUnits = useMemo(() => {
    const acc = {
      impressions: { planned: 0, expected: 0, actual: 0 },
      currency:    { planned: 0, expected: 0, actual: 0 },
    }
    for (const r of pacingRows) {
      const imp = isImpressionBased(r.campaign_type)
      const b   = imp ? acc.impressions : acc.currency
      b.planned  += r.planned_amount
      b.expected += r.expected
      b.actual   += (imp ? r.actualImps : r.actual) ?? 0
    }
    const build = (unit: 'impressions' | 'currency', label: string) => {
      const b = acc[unit]
      const variance = b.expected > 0 ? ((b.actual - b.expected) / b.expected) * 100 : null
      return { unit, label, ...b, variance, present: b.planned > 0 || b.actual > 0 }
    }
    const imps = build('impressions', 'TTD · impressions')
    const usd  = build('currency', 'Social · dollars')
    const shown = tab === 'ttd' ? [imps]
      : tab === 'social' || tab === 'youtube' ? [usd]
      : [imps, usd].filter(u => u.present)
    return shown.length ? shown : [imps]
  }, [pacingRows, tab])

  // ── Save new mapping ────────────────────────────────────────────────────────
  const saveMapping = async () => {
    if (!newMapping?.report_source || !newMapping.report_advertiser || !newMapping.planned_client || !newMapping.planned_platform) return
    setSavingMap(true)
    try {
      const res  = await fetch('/api/pacing/mappings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newMapping) })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as {error?:string}).error ?? `Save failed (${res.status})`) }
      const json = await res.json()
      const mRes  = await fetch('/api/pacing/mappings')
      const mJson = await mRes.json()
      setMappings(mJson.mappings ?? [])
      setNewMapping(null)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingMap(false)
    }
  }

  // ── Assign a single unmapped row to a budget line ──────────────────────────
  const assignRow = useCallback(async (row: SpendDataRow, budgetValue: string) => {
    const [planned_client, planned_platform, planned_campaign_type] = budgetValue.split('||')
    setSavingRowId(row.id)
    try {
      const res = await fetch('/api/pacing/mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_source: row.report_source.toLowerCase() as 'ttd' | 'facebook',
          report_advertiser: row.report_advertiser,
          report_campaign: row.report_campaign,
          planned_client,
          planned_platform,
          planned_campaign_type,
          fix_spend_data_id: row.id,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error ?? `Save failed (${res.status})`)
      }
      window.location.reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Assign failed')
    } finally {
      setSavingRowId(null)
    }
  }, [])

  // ── Scan status fetch ───────────────────────────────────────────────────────
  const fetchScanStatus = async () => {
    setScanning(true)
    setScanMsg('')
    try {
      const res  = await fetch(`/api/pacing/checklist/scan?month=${currentMonth}&year=${currentYear}`)
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as {error?:string}).error ?? `Fetch failed (${res.status})`) }
      const json = await res.json()
      setScanStatus(json)
      setScanMsg(`✓ Status refreshed`)
    } catch (e) {
      setScanMsg(`✗ ${e instanceof Error ? e.message : 'Error'}`)
    } finally {
      setScanning(false)
    }
  }

  // ── Checklist export ────────────────────────────────────────────────────────
  const exportChecklist = async () => {
    setExporting(true)
    setExportMsg('')
    try {
      const res = await fetch('/api/pacing/checklist/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: currentMonth, year: currentYear }),
      })
      if (!res.ok) {
        const json = await res.json()
        throw new Error(json.error ?? 'Export failed')
      }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      const MONTH_NAMES_LOCAL = ['','January','February','March','April','May','June',
        'July','August','September','October','November','December']
      a.href     = url
      a.download = `Monthly Checklist ${MONTH_NAMES_LOCAL[currentMonth]} ${currentYear}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
      setExportMsg('✓ Downloaded')
    } catch (e) {
      setExportMsg(`✗ ${e instanceof Error ? e.message : 'Export failed'}`)
    } finally {
      setExporting(false)
    }
  }

  // ── Campaign Sheet import ───────────────────────────────────────────────────
  const runImport = async () => {
    setImporting(true)
    try {
      const lines = importText.trim().split('\n').filter(Boolean)
      // Expected CSV: client_name,platform,campaign_type,jan,feb,...,dec
      // Or paste from the TTD/Social/YouTube tabs
      const rows: Array<{ client_name: string; platform: string; campaign_type: string; planned_amount: number }> = []
      for (const line of lines) {
        const parts = line.split(',').map(p => p.replace(/["""$,\s]/g, '').trim())
        if (parts.length < 4) continue
        const [client, campaign, ...months] = parts
        const monthIdx = currentMonth - 1
        const amount = parseFloat(months[monthIdx] ?? '0')
        if (!client || !campaign || isNaN(amount)) continue
        // Detect platform from campaign type
        const isYouTube = campaign.toLowerCase().includes('youtube')
        const platform = campaign === 'CTV' || campaign === 'Display' || campaign === 'Audio' || isYouTube
          ? 'TTD'
          : campaign.startsWith('Meta') || campaign === 'TikTok' || campaign === 'LinkedIn'
            || campaign === 'Reddit' || campaign.includes('FB') || campaign.includes('IG')
            || campaign === 'NextDoor' || campaign === 'Nextdoor'
          ? 'Social'
          : 'TTD'
        rows.push({ client_name: client, platform, campaign_type: campaign, planned_amount: amount })
      }
      if (!rows.length) { alert('No valid rows parsed. Check format.'); return }
      const res  = await fetch('/api/pacing/budgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year: currentYear, month: currentMonth, rows }) })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as {error?:string}).error ?? `Import failed (${res.status})`) }
      const json = await res.json()
      alert(`✓ Imported ${json.count} budget rows`)
      window.location.reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  const inputClass = 'bg-[#1a1d2a] border border-[#333] text-white text-sm rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#0075a9]'
  const btnClass   = 'px-3 py-1.5 text-sm font-semibold rounded transition-colors'

  // ── Shared triage row renderer (used by triage, clients, and sorted views) ──
  function renderTriageRow(r: PacingRow) {
    const fl        = flightLabel(r)
    const barStyle  = getPacingStyle(r.deviation_pct ?? 0)
    const staleKey  = `${r.client_name}|${r.platform}|${r.campaign_type}`
    const currImps  = currImpsByKey.get(staleKey) ?? 0
    const prevImps  = prevSpendByKey.get(staleKey)
    const isStale   = prevImps !== undefined && prevImps > 0 && currImps === prevImps
    const actualPct = r.planned_amount > 0 ? (r.actual_spend / r.planned_amount) * 100 : 0
    const isOverflow = actualPct > 100
    const barPct    = Math.min(actualPct, 100)
    const expectedPct = r.planned_amount > 0 && r.expected_spend > 0
      ? Math.min((r.expected_spend / r.planned_amount) * 100, 100) : null
    const platChip  = getPlatformChip(r.platform)

    return (
      <button key={r.planned_budget_id} onClick={() => setSelectedPacing(r)}
        className="w-full text-left px-4 py-3 hover:bg-white/5 transition-colors">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0"
            style={{ backgroundColor: platChip.bg, color: platChip.text }}>
            {r.platform}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white truncate" title={r.client_name}>{r.client_name}</p>
            <p className="text-[11px] text-gray-500">{r.campaign_type || r.platform}</p>
          </div>
          {isStale && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap"
              style={{ backgroundColor: 'rgba(217,119,6,0.2)', color: '#fbbf24' }}>
              ⏸ stale
            </span>
          )}
          {fl && <span className="text-[10px] text-gray-400 whitespace-nowrap hidden sm:inline">{fl}</span>}
          {r.has_creative === false && (
            <span className="text-[10px] font-bold text-red-300 whitespace-nowrap">creative ✗</span>
          )}
          <p className="text-[11px] tabular-nums shrink-0"
            style={{ color: r.deviation_pct === null ? '#666' : r.deviation_pct >= 0 ? '#4ade80' : '#f87171' }}>
            {r.deviation_pct === null ? 'no data' : `${r.deviation_pct > 0 ? '+' : ''}${r.deviation_pct}%`}
          </p>
        </div>
        {/* Progress bar with expected tick and overflow glow */}
        {r.planned_amount > 0 && (
          <div className="relative mb-1.5"
            style={{ padding: '3px 0', ...(isOverflow ? { filter: `drop-shadow(0 0 3px ${barStyle.bg})` } : {}) }}>
            <div className="w-full rounded-full overflow-hidden"
              style={{ backgroundColor: isOverflow ? `${barStyle.bg}33` : '#1e2130', height: '7px' }}>
              <div className="h-full rounded-full transition-all duration-500"
                style={{ width: `${barPct}%`, backgroundColor: barStyle.bg }} />
            </div>
            {expectedPct !== null && (
              <div className="absolute pointer-events-none"
                style={{ left: `calc(${expectedPct}% - 1px)`, top: 0, bottom: 0, width: '2px', backgroundColor: 'rgba(255,255,255,0.55)', borderRadius: '1px' }} />
            )}
          </div>
        )}
        {/* Numbers */}
        {r.planned_amount > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-gray-400 tabular-nums">
              {fmtUnit(r.actual_spend, r.campaign_type)}
              {r.expected_spend > 0 && (
                <span className="text-gray-600"> / {fmtUnit(r.expected_spend, r.campaign_type)} exp</span>
              )}
            </span>
            <span className="text-[10px] tabular-nums" style={{ color: isOverflow ? barStyle.bg : '#4b5563' }}>
              {isOverflow
                ? `+${Math.round(actualPct - 100)}% over · ${fmtUnit(r.planned_amount, r.campaign_type)} planned`
                : `${fmtUnit(r.planned_amount, r.campaign_type)} planned`}
            </span>
          </div>
        )}
        {/* Recommended budget to serve ~5% more impressions than planned, at current CPM */}
        {r.recommended_budget != null && (
          <div className="mt-1 text-[10px] tabular-nums text-cyan-300/80">
            Rec. budget for +5% imps: <span className="font-semibold">{fmt(r.recommended_budget, 'currency')}</span>
          </div>
        )}
      </button>
    )
  }

  return (
    <div className="min-h-screen bg-[#0f1117] text-gray-100 font-[family-name:var(--font-montserrat)]">

      {/* ── Nav bar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-5 py-3 bg-[#c8c8c8] border-b border-[#aaaaaa]">
        <img src="/fte-logo.svg" alt="FTE" className="h-8 w-auto" />
        <span className="text-[#003057] font-bold text-sm tracking-wide">Campaign Pacing</span>
        <div className="flex-1" />
        <Link href="/board"        className="text-xs text-[#003057] hover:text-[#73308a] font-semibold transition-colors">Board</Link>
        <Link href="/copy-tracker" className="text-xs text-[#003057] hover:text-[#73308a] font-semibold transition-colors">Copy Tracker</Link>
        <Link href="/calendar"     className="text-xs text-[#003057] hover:text-[#73308a] font-semibold transition-colors">Calendar</Link>
        <Link href="/clients"      className="text-xs text-[#003057] hover:text-[#73308a] font-semibold transition-colors">Clients</Link>
      </div>

      <div className="max-w-screen-2xl mx-auto px-5 py-6 space-y-5">

        {/* ── Header row ────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">
              {MONTH_NAMES[currentMonth]} {currentYear} · Pacing
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">
              Data through day {dayOfMonth} of {daysInMonth} · {Math.round((dayOfMonth/daysInMonth)*100)}% through month
            </p>
          </div>

          {/* View toggle */}
          <div className="flex rounded-lg overflow-hidden border border-[#333] text-xs font-semibold">
            {(['triage','pacing','clients','mappings','import','checklist'] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`px-4 py-2 capitalize transition-colors ${view === v ? 'bg-[#0075a9] text-white' : 'bg-[#1a1d2a] text-gray-400 hover:text-white'}`}>
                {v === 'triage' ? 'Triage' : v === 'pacing' ? 'Table' : v === 'clients' ? 'Clients' : v === 'import' ? 'Budget Import' : v === 'mappings' ? 'Name Mappings' : 'Checklist'}
              </button>
            ))}
          </div>
        </div>

        {/* ── Sort controls (triage / table / clients) ────────────────────── */}
        {(view === 'triage' || view === 'pacing' || view === 'clients') && (
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-gray-500 font-medium">Sort:</span>
            <div className="flex rounded-lg overflow-hidden border border-[#333] text-[11px] font-semibold">
              {([['default','Default'],['underspend','Under first'],['overspend','Over first']] as const).map(([mode, label]) => (
                <button key={mode} onClick={() => setSortMode(mode)}
                  className={`px-3 py-1.5 transition-colors ${sortMode === mode ? 'bg-[#0075a9] text-white' : 'bg-[#1a1d2a] text-gray-400 hover:text-white'}`}>
                  {label}
                </button>
              ))}
            </div>
            {sortMode !== 'default' && (
              <span className="text-[11px] text-gray-500">
                {sortMode === 'underspend' ? 'Most under-pacing at top' : 'Most over-pacing at top'}
              </span>
            )}
          </div>
        )}

        {/* ── Platform filter + search (triage + clients views) ───────────── */}
        {(view === 'triage' || view === 'clients') && (
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex rounded-lg overflow-hidden border border-[#333] text-xs font-semibold">
              {(['all','ttd','social','youtube'] as const).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-2 uppercase transition-colors ${tab === t ? 'bg-[#0075a9] text-white' : 'bg-[#1a1d2a] text-gray-400 hover:text-white'}`}>
                  {t === 'all' ? 'All' : t.toUpperCase()}
                </button>
              ))}
            </div>
            <input
              value={searchQ} onChange={e => setSearchQ(e.target.value)}
              placeholder="Search client…" className={`${inputClass} w-48`}
            />
            {searchQ && (
              <button onClick={() => setSearchQ('')} className="text-xs text-gray-500 hover:text-white">✕ clear</button>
            )}
          </div>
        )}

        {/* ── Upload strip ──────────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-3 items-center">
          {/* TTD upload */}
          <div className="flex items-center gap-2 bg-[#1a1d2a] border border-[#333] rounded-lg px-4 py-2.5">
            <span className="text-xs font-semibold text-gray-300">TTD Report</span>
            {ttdUpload ? (
              <span className="text-xs text-green-400">
                ✓ {new Date(ttdUpload.created_at).toLocaleString()} · {fmt(ttdUpload.total_impressions ?? 0, 'impressions')} imps
              </span>
            ) : (
              <span className="text-xs text-gray-500">No upload this month</span>
            )}
            <button onClick={() => ttdRef.current?.click()}
              disabled={uploading === 'ttd'}
              className={`${btnClass} bg-[#003057] hover:bg-[#0075a9] text-white text-xs ml-2`}>
              {uploading === 'ttd' ? 'Uploading…' : ttdUpload ? 'Re-upload' : 'Upload Report'}
            </button>
            <input ref={ttdRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload('ttd', f) }} />
          </div>

          {/* Facebook upload */}
          <div className="flex items-center gap-2 bg-[#1a1d2a] border border-[#333] rounded-lg px-4 py-2.5">
            <span className="text-xs font-semibold text-gray-300">Facebook (TapClicks)</span>
            {fbUpload ? (
              <span className="text-xs text-green-400">
                ✓ {new Date(fbUpload.created_at).toLocaleString()} · {fmt(fbUpload.total_spend ?? 0)}
              </span>
            ) : (
              <span className="text-xs text-gray-500">No upload this month</span>
            )}
            <button onClick={() => fbRef.current?.click()}
              disabled={uploading === 'facebook'}
              className={`${btnClass} bg-[#003057] hover:bg-[#0075a9] text-white text-xs ml-2`}>
              {uploading === 'facebook' ? 'Uploading…' : fbUpload ? 'Re-upload' : 'Upload Excel'}
            </button>
            <input ref={fbRef} type="file" accept=".xlsx,.xls" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload('facebook', f) }} />
          </div>

          {uploadMsg && (
            <span className={`text-xs font-medium ${uploadMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
              {uploadMsg}
            </span>
          )}
        </div>

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* TRIAGE VIEW (landing) */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {view === 'triage' && (
          <div className="space-y-4">

            {/* Severity count chips */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {SEVERITY_ORDER.map(sev => (
                <div key={sev} className="bg-[#1a1d2a] border border-[#333] rounded-xl px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SEVERITY_META[sev].dot }} />
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">{SEVERITY_META[sev].label}</p>
                  </div>
                  <p className="text-2xl font-bold text-white mt-1">{triageGroups[sev].length}</p>
                </div>
              ))}
            </div>

            {filteredPacing.length === 0 ? (
              <div className="bg-[#1a1d2a] border border-[#333] rounded-xl p-8 text-center">
                {initialPacing.length === 0 ? (
                  <>
                    <p className="text-gray-400 text-sm">Nothing to triage for {MONTH_NAMES[currentMonth]} yet.</p>
                    <p className="text-gray-500 text-xs mt-1">
                      Load budgets via <button onClick={() => setView('import')} className="text-[#0075a9] underline">Budget Import</button>,
                      then upload TTD / Facebook spend above to populate the triage view.
                    </p>
                  </>
                ) : (
                  <p className="text-gray-400 text-sm">No campaigns match the current filter.</p>
                )}
              </div>
            ) : sortedTriageSections !== null ? (
              /* ── Sorted flat sections (under/over first) ── */
              <div className="space-y-4">
                {sortedTriageSections.map(section => (
                  <div key={section.label} className="rounded-xl border border-[#333] overflow-hidden">
                    <div className="px-4 py-2.5 flex items-center gap-2 border-b border-white/5 bg-[#1a1d2a]">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: section.color }} />
                      <span className="text-xs font-bold uppercase tracking-wide text-white">{section.label}</span>
                      <span className="text-xs text-gray-400">· {section.rows.length}</span>
                    </div>
                    <div className="divide-y divide-white/5">
                      {section.rows.map(r => renderTriageRow(r))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              /* ── Default severity-grouped view ── */
              <div className="space-y-4">
                {SEVERITY_ORDER.map(sev => {
                  const rows = triageGroups[sev]
                  if (rows.length === 0) return null
                  return (
                    <div key={sev} className={`rounded-xl border ${SEVERITY_META[sev].bar} overflow-hidden`}>
                      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-white/5">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SEVERITY_META[sev].dot }} />
                        <span className="text-xs font-bold uppercase tracking-wide text-white">{SEVERITY_META[sev].label}</span>
                        <span className="text-xs text-gray-400">· {rows.length}</span>
                      </div>
                      <div className="divide-y divide-white/5">
                        {rows.map(r => renderTriageRow(r))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* PACING TABLE VIEW */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {view === 'pacing' && (
          <div className="space-y-4">

            {/* Summary cards — one row per unit present (impressions and/or dollars) */}
            <div className="space-y-2">
              {summaryUnits.map(u => {
                const style = getPacingStyle(u.variance)
                const unitWord = u.unit === 'impressions' ? 'imps' : 'spend'
                return (
                  <div key={u.unit}>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1 ml-0.5">{u.label}</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: 'Monthly Budget', value: fmt(u.planned,  u.unit), sub: `planned ${unitWord}` },
                        { label: 'Expected MTD',   value: fmt(u.expected, u.unit), sub: `through day ${dayOfMonth}` },
                        { label: 'Actual MTD',     value: fmt(u.actual,   u.unit), sub: `actual ${unitWord}` },
                        { label: 'Pacing',         value: u.variance !== null ? `${u.variance > 0 ? '+' : ''}${u.variance.toFixed(1)}%` : '—', sub: style.label },
                      ].map(c => (
                        <div key={c.label} className="bg-[#1a1d2a] border border-[#333] rounded-xl px-4 py-3">
                          <p className="text-[10px] text-gray-500 uppercase tracking-widest">{c.label}</p>
                          <p className="text-xl font-bold text-white mt-1">{c.value}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">{c.sub}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Platform tabs + search */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex rounded-lg overflow-hidden border border-[#333] text-xs font-semibold">
                {(['all','ttd','social','youtube'] as const).map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    className={`px-4 py-2 uppercase transition-colors ${tab === t ? 'bg-[#0075a9] text-white' : 'bg-[#1a1d2a] text-gray-400 hover:text-white'}`}>
                    {t}
                  </button>
                ))}
              </div>
              <input
                value={searchQ} onChange={e => setSearchQ(e.target.value)}
                placeholder="Search client…" className={`${inputClass} w-48`}
              />
              {searchQ && (
                <button onClick={() => setSearchQ('')} className="text-xs text-gray-500 hover:text-white">✕ clear</button>
              )}
              <span className="text-xs text-gray-500 ml-auto">{pacingRows.length} campaigns</span>
            </div>

            {/* Pacing table */}
            {budgets.length === 0 ? (
              <div className="bg-[#1a1d2a] border border-[#333] rounded-xl p-8 text-center">
                <p className="text-gray-400 text-sm">No planned budgets loaded for {MONTH_NAMES[currentMonth]}.</p>
                <p className="text-gray-500 text-xs mt-1">Use <button onClick={() => setView('import')} className="text-[#0075a9] underline">Budget Import</button> to load from budget workbook.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-[#333] overflow-hidden">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-[#1a1d2a] text-[10px] text-gray-400 uppercase tracking-widest">
                      <th className="text-left px-4 py-3 font-semibold">Client</th>
                      <th className="text-left px-3 py-3 font-semibold">Platform</th>
                      <th className="text-left px-3 py-3 font-semibold">Type</th>
                      <th className="text-right px-3 py-3 font-semibold">Planned</th>
                      <th className="text-right px-3 py-3 font-semibold">Expected MTD</th>
                      <th className="text-right px-3 py-3 font-semibold">Actual MTD</th>
                      <th className="text-right px-3 py-3 font-semibold">Variance</th>
                      <th className="text-left px-4 py-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPacingRows.map((row, i) => {
                      const style      = getPacingStyle(row.variance ?? null)
                      const impBased   = isImpressionBased(row.campaign_type)
                      const actualDisp = impBased ? row.actualImps : row.actual
                      const varianceAmt = actualDisp !== null && row.expected > 0
                        ? actualDisp - row.expected : null
                      return (
                        <tr key={row.id}
                          style={{ backgroundColor: i % 2 === 0 ? 'rgba(26,29,42,0.5)' : 'rgba(20,23,35,0.5)' }}
                          className="border-t border-[#1e2130] hover:bg-[#1e2a3a] transition-colors">
                          <td className="px-4 py-2.5 font-medium text-white max-w-[200px] truncate" title={row.client_name}>
                            {row.client_name}
                          </td>
                          <td className="px-3 py-2.5 text-gray-300 text-xs">{row.platform}</td>
                          <td className="px-3 py-2.5 text-gray-300 text-xs">{row.campaign_type || '—'}</td>
                          <td className="px-3 py-2.5 text-right text-gray-300 text-xs tabular-nums">{fmtUnit(row.planned_amount, row.campaign_type)}</td>
                          <td className="px-3 py-2.5 text-right text-gray-400 text-xs tabular-nums">{fmtUnit(row.expected, row.campaign_type)}</td>
                          <td className="px-3 py-2.5 text-right text-xs tabular-nums font-medium"
                            style={{ color: actualDisp !== null ? '#fff' : '#555' }}>
                            {actualDisp !== null ? fmtUnit(actualDisp, row.campaign_type) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right text-xs tabular-nums"
                            style={{ color: varianceAmt === null ? '#555' : varianceAmt >= 0 ? '#4ade80' : '#f87171' }}>
                            {varianceAmt !== null ? `${varianceAmt > 0 ? '+' : ''}${fmtUnit(varianceAmt, row.campaign_type)}` : '—'}
                          </td>
                          <td className="px-4 py-2">
                            {actualDisp !== null ? (
                              <span className="inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold whitespace-nowrap"
                                style={{ backgroundColor: style.bg, color: style.text }}>
                                {style.label}
                              </span>
                            ) : (
                              <span className="text-[10px] text-gray-600">Awaiting upload</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Unmapped campaigns */}
            {unmappedRows.length > 0 && (
              <div className="rounded-xl border border-yellow-800/50 overflow-hidden">
                <div className="bg-yellow-900/20 px-4 py-2.5 flex items-center justify-between">
                  <span className="text-yellow-400 text-xs font-bold uppercase tracking-wide">
                    ⚠ {unmappedRows.length} Unmapped Campaigns
                  </span>
                  <span className="text-yellow-600 text-xs">These appear in reports but have no Campaign Sheet match — pick a budget line to assign</span>
                </div>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#1a1d2a] text-[10px] text-gray-500 uppercase tracking-widest">
                      <th className="text-left px-4 py-2 font-semibold">Source</th>
                      <th className="text-left px-4 py-2 font-semibold">Advertiser</th>
                      <th className="text-left px-4 py-2 font-semibold">Campaign</th>
                      <th className="text-right px-4 py-2 font-semibold">Spend</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {unmappedRows.map(r => (
                      <tr key={r.id} className="border-t border-[#1e2130]">
                        <td className="px-4 py-2 uppercase text-gray-500">{r.report_source}</td>
                        <td className="px-4 py-2 text-gray-300">{r.report_advertiser}</td>
                        <td className="px-4 py-2 text-gray-400">{r.report_campaign || '(all)'}</td>
                        <td className="px-4 py-2 text-right text-white tabular-nums">{fmt(r.spend)}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1">
                            <select
                              value={rowAssignments[r.id] ?? ''}
                              onChange={e => setRowAssignments(a => ({ ...a, [r.id]: e.target.value }))}
                              className={inputClass + ' text-[10px] max-w-[200px]'}>
                              <option value="">— pick budget line —</option>
                              {(['TTD', 'Social', 'YouTube', 'SEM'] as const).map(platform => {
                                const opts = budgetOptions.filter(o => o.platform === platform)
                                return opts.length > 0 ? (
                                  <optgroup key={platform} label={platform}>
                                    {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                  </optgroup>
                                ) : null
                              })}
                            </select>
                            <button
                              disabled={!rowAssignments[r.id] || savingRowId === r.id}
                              onClick={() => assignRow(r, rowAssignments[r.id])}
                              className={`${btnClass} bg-[#0075a9] hover:bg-[#003057] text-white text-[10px] disabled:opacity-40`}>
                              {savingRowId === r.id ? '…' : 'Save'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* CLIENTS VIEW */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {view === 'clients' && (
          <div className="space-y-2">
            {sortedClientRollups.length === 0 ? (
              <div className="bg-[#1a1d2a] border border-[#333] rounded-xl p-8 text-center">
                {initialPacing.length === 0 ? (
                  <>
                    <p className="text-gray-400 text-sm">Nothing to triage for {MONTH_NAMES[currentMonth]} yet.</p>
                    <p className="text-gray-500 text-xs mt-1">
                      Load budgets via <button onClick={() => setView('import')} className="text-[#0075a9] underline">Budget Import</button>,
                      then upload TTD / Facebook spend above to populate this view.
                    </p>
                  </>
                ) : (
                  <p className="text-gray-400 text-sm">No clients match the current filter.</p>
                )}
              </div>
            ) : sortedClientRollups.map(client => {
              const isExpanded = expandedClients.has(client.client_name)
              const meta = SEVERITY_META[client.worstSeverity]
              // One bar per unit the client actually runs (impressions and/or dollars).
              const unitBars = ([
                { unit: 'impressions' as const, agg: client.imp, dev: client.impDeviationPct },
                { unit: 'currency' as const,    agg: client.usd, dev: client.usdDeviationPct },
              ]).filter(u => u.agg.planned > 0 || u.agg.actual > 0)
              return (
                <div key={client.client_name} className={`rounded-xl border ${SEVERITY_META[client.worstSeverity].bar} overflow-hidden`}>
                  {/* Client row — click to expand */}
                  <button
                    onClick={() => setExpandedClients(prev => {
                      const next = new Set(prev)
                      if (next.has(client.client_name)) next.delete(client.client_name)
                      else next.add(client.client_name)
                      return next
                    })}
                    className="w-full text-left px-4 py-3 hover:bg-white/5 transition-colors">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: meta.dot }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-white truncate">{client.client_name}</p>
                        <p className="text-[10px] text-gray-500">
                          {client.campaigns.length} campaign{client.campaigns.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {unitBars.length === 0 && <span className="text-[11px] text-gray-600">no data</span>}
                        {unitBars.map(u => (
                          <span key={u.unit} className="text-[11px] tabular-nums"
                            style={{ color: u.dev === null ? '#666' : u.dev >= 0 ? '#4ade80' : '#f87171' }}
                            title={u.unit === 'impressions' ? 'TTD (impressions)' : 'Social (dollars)'}>
                            {u.unit === 'impressions' ? 'TTD ' : '$ '}
                            {u.dev === null ? '—' : `${u.dev > 0 ? '+' : ''}${u.dev.toFixed(1)}%`}
                          </span>
                        ))}
                      </div>
                      <span className="text-gray-600 text-[10px] shrink-0">{isExpanded ? '▲' : '▼'}</span>
                    </div>
                    {/* Progress bar per unit */}
                    {unitBars.map(u => {
                      const barStyle   = getPacingStyle(u.dev ?? null)
                      const actualPct  = u.agg.planned > 0 ? Math.min((u.agg.actual / u.agg.planned) * 100, 100) : 0
                      const expectedPct = u.agg.planned > 0 && u.agg.expected > 0
                        ? Math.min((u.agg.expected / u.agg.planned) * 100, 100) : null
                      const isOverflow = u.agg.planned > 0 && u.agg.actual > u.agg.planned
                      return (
                        <div key={u.unit} className="relative mb-1"
                          style={isOverflow ? { filter: `drop-shadow(0 0 3px ${barStyle.bg})` } : {}}>
                          <div className="w-full rounded-full overflow-hidden"
                            style={{ backgroundColor: isOverflow ? `${barStyle.bg}33` : '#1e2130', height: '5px' }}>
                            <div className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${actualPct}%`, backgroundColor: barStyle.bg }} />
                          </div>
                          {expectedPct !== null && (
                            <div className="absolute pointer-events-none"
                              style={{ left: `calc(${expectedPct}% - 1px)`, top: 0, bottom: 0, width: '2px', backgroundColor: 'rgba(255,255,255,0.45)', borderRadius: '1px' }} />
                          )}
                        </div>
                      )
                    })}
                  </button>
                  {/* Expanded individual campaigns */}
                  {isExpanded && (
                    <div className="divide-y divide-white/5 border-t border-white/5">
                      {client.campaigns.map(r => renderTriageRow(r))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* MAPPINGS VIEW */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {view === 'mappings' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-400">
                {mappings.length} active mappings. Campaign names from reports → Campaign Sheet entries.
              </p>
              <button onClick={() => setNewMapping({ report_source: 'ttd', report_campaign: '', planned_campaign_type: '' })}
                className={`${btnClass} bg-[#0075a9] hover:bg-[#003057] text-white`}>
                + New Mapping
              </button>
            </div>

            {/* New mapping form */}
            {newMapping && (
              <div className="bg-[#1a1d2a] border border-[#0075a9] rounded-xl p-4 space-y-3">
                <p className="text-sm font-bold text-[#0075a9]">New Mapping</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div className="space-y-1">
                    <label className="text-gray-400">Report Source</label>
                    <select value={newMapping.report_source ?? 'ttd'} onChange={e => setNewMapping(m => ({ ...m, report_source: e.target.value as 'ttd'|'facebook' }))}
                      className={inputClass + ' w-full'}>
                      <option value="ttd">TTD</option>
                      <option value="facebook">Facebook</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-gray-400">Report Advertiser / Account</label>
                    <input value={newMapping.report_advertiser ?? ''} onChange={e => setNewMapping(m => ({ ...m, report_advertiser: e.target.value }))}
                      placeholder="e.g. Placeholder Construction" className={inputClass + ' w-full'} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-gray-400">Report Campaign (blank = all)</label>
                    <input value={newMapping.report_campaign ?? ''} onChange={e => setNewMapping(m => ({ ...m, report_campaign: e.target.value }))}
                      placeholder="e.g. Placeholder CTV" className={inputClass + ' w-full'} />
                  </div>
                  <div className="space-y-1 col-span-2 md:col-span-3">
                    <label className="text-gray-400">Campaign Sheet Budget Line</label>
                    <select
                      value={newMapping.planned_client && newMapping.planned_platform && newMapping.planned_campaign_type !== undefined
                        ? `${newMapping.planned_client}||${newMapping.planned_platform}||${newMapping.planned_campaign_type}`
                        : ''}
                      onChange={e => {
                        if (!e.target.value) return
                        const [planned_client, planned_platform, planned_campaign_type] = e.target.value.split('||')
                        setNewMapping(m => ({ ...m, planned_client, planned_platform, planned_campaign_type }))
                      }}
                      className={inputClass + ' w-full'}>
                      <option value="">— pick budget line —</option>
                      {(['TTD', 'Social', 'YouTube', 'SEM'] as const).map(platform => {
                        const opts = budgetOptions.filter(o => o.platform === platform)
                        return opts.length > 0 ? (
                          <optgroup key={platform} label={platform}>
                            {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </optgroup>
                        ) : null
                      })}
                    </select>
                  </div>
                  <div className="space-y-1 col-span-2 md:col-span-3">
                    <label className="text-gray-400">Notes (optional)</label>
                    <input value={newMapping.notes ?? ''} onChange={e => setNewMapping(m => ({ ...m, notes: e.target.value }))}
                      placeholder="e.g. May need split by location" className={inputClass + ' w-full'} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveMapping} disabled={savingMap}
                    className={`${btnClass} bg-[#0075a9] hover:bg-[#003057] text-white`}>
                    {savingMap ? 'Saving…' : 'Save Mapping'}
                  </button>
                  <button onClick={() => setNewMapping(null)}
                    className={`${btnClass} bg-[#2a2d3a] hover:bg-[#333] text-gray-300`}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Mappings table */}
            <div className="rounded-xl border border-[#333] overflow-hidden">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-[#1a1d2a] text-[10px] text-gray-400 uppercase tracking-widest">
                    <th className="text-left px-4 py-3 font-semibold">Source</th>
                    <th className="text-left px-4 py-3 font-semibold">Report Advertiser</th>
                    <th className="text-left px-4 py-3 font-semibold">Report Campaign</th>
                    <th className="text-left px-4 py-3 font-semibold">→ Sheet Client</th>
                    <th className="text-left px-3 py-3 font-semibold">Platform</th>
                    <th className="text-left px-3 py-3 font-semibold">Type</th>
                    <th className="text-left px-3 py-3 font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m, i) => (
                    <tr key={m.id}
                      style={{ backgroundColor: i % 2 === 0 ? 'rgba(26,29,42,0.5)' : 'rgba(20,23,35,0.5)' }}
                      className="border-t border-[#1e2130]">
                      <td className="px-4 py-2.5 uppercase text-gray-500 font-semibold">{m.report_source}</td>
                      <td className="px-4 py-2.5 text-gray-200">{m.report_advertiser}</td>
                      <td className="px-4 py-2.5 text-gray-400">{m.report_campaign || <span className="text-gray-600 italic">all campaigns</span>}</td>
                      <td className="px-4 py-2.5 text-[#4ade80] font-medium">{m.planned_client}</td>
                      <td className="px-3 py-2.5 text-gray-400">{m.planned_platform}</td>
                      <td className="px-3 py-2.5 text-gray-400">{m.planned_campaign_type || '—'}</td>
                      <td className="px-3 py-2.5 text-gray-600 max-w-[200px] truncate" title={m.notes ?? ''}>
                        {m.notes ? <span className="text-yellow-600">⚠ {m.notes}</span> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-600">
              Mappings flagged with ⚠ need review — they use a wildcard match and may include multiple campaign types in the same budget line.
            </p>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* CHECKLIST VIEW */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {view === 'checklist' && (
          <div className="space-y-5 max-w-3xl">

            {/* Export card */}
            <div className="bg-[#1a1d2a] border border-[#333] rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-bold text-white">Export Monthly Checklist</p>
                  <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                    Downloads an Excel file with <span className="text-gray-200">Digital</span> and <span className="text-gray-200">Social</span> tabs
                    in the standard checklist format. Pre-populated columns:
                  </p>
                  <ul className="text-xs text-gray-500 mt-2 space-y-0.5 ml-3">
                    <li>• <span className="text-gray-300">Campaign / Platform / Budget</span> — from planned budgets</li>
                    <li>• <span className="text-gray-300">Creative Uploaded / Copy Tracker Updated</span> — from Drive CT scan</li>
                    <li>• <span className="text-gray-300">Live Budget Check</span> — from uploaded TTD / Facebook reports</li>
                    <li>• <span className="text-gray-300">Ready to Launch</span> — GO / BLOCKED based on creative status</li>
                  </ul>
                  <p className="text-xs text-gray-600 mt-2">All other columns (Shell Created, Pixel, Geofencing, etc.) left blank for manual fill.</p>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <button onClick={exportChecklist} disabled={exporting}
                    className={`${btnClass} bg-[#22c55e] hover:bg-[#16a34a] text-white text-xs whitespace-nowrap`}>
                    {exporting ? 'Generating…' : '⬇ Export Excel'}
                  </button>
                  {exportMsg && (
                    <span className={`text-xs font-medium ${exportMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
                      {exportMsg}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Creative check status */}
            <div className="bg-[#1a1d2a] border border-[#333] rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-white">Creative Check Status</p>
                <div className="flex items-center gap-2">
                  {scanMsg && (
                    <span className={`text-xs font-medium ${scanMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
                      {scanMsg}
                    </span>
                  )}
                  <button onClick={fetchScanStatus} disabled={scanning}
                    className={`${btnClass} bg-[#0075a9] hover:bg-[#005f8c] text-white text-xs whitespace-nowrap`}>
                    {scanning ? 'Checking…' : '↻ Refresh Status'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">
                The creative check reads each client&apos;s media plan Google Sheet (Copy Tracker tabs) and flags whether
                creatives exist for {MONTH_NAMES[currentMonth]}. Runs weekly (Mondays) · ask Claude to &ldquo;run the creative scan&rdquo; for an immediate refresh.
              </p>

              {/* Stats row */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-[#0f1117] rounded-lg px-4 py-3 border border-[#2a2d3a]">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest">Clients Tracked</p>
                  <p className="text-lg font-bold text-white mt-1">
                    {scanStatus ? scanStatus.total_clients : '—'}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">media plan files</p>
                </div>
                <div className="bg-[#0f1117] rounded-lg px-4 py-3 border border-[#2a2d3a]">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest">Scanned</p>
                  <p className={`text-lg font-bold mt-1 ${scanStatus && scanStatus.scanned_count > 0 ? 'text-green-400' : 'text-yellow-400'}`}>
                    {scanStatus ? scanStatus.scanned_count : '—'}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">for {MONTH_NAMES[currentMonth]}</p>
                </div>
                <div className="bg-[#0f1117] rounded-lg px-4 py-3 border border-[#2a2d3a]">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest">Last Scan</p>
                  <p className="text-sm font-bold text-white mt-1">
                    {scanStatus?.last_scanned_at
                      ? new Date(scanStatus.last_scanned_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : '—'}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {scanStatus?.last_scanned_at
                      ? new Date(scanStatus.last_scanned_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                      : 'never run'}
                  </p>
                </div>
              </div>

              {/* Results table — shown if data exists */}
              {scanStatus && scanStatus.results.length > 0 && (
                <div className="border-t border-[#2a2d3a] pt-3">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">Scan Results</p>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {scanStatus.results.map((r, i) => (
                      <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-[#1a1d2a]">
                        <span className="text-gray-300">{r.client_name}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-gray-500">{r.platform}</span>
                          <span className={`font-bold ${r.has_creative ? 'text-green-400' : r.has_creative === false ? 'text-red-400' : 'text-gray-500'}`}>
                            {r.has_creative === true ? '✓ Creative' : r.has_creative === false ? '✗ Missing' : '?'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Not yet scanned list */}
              {scanStatus && scanStatus.not_scanned.length > 0 && (
                <p className="text-xs text-gray-600 border-t border-[#2a2d3a] pt-3">
                  <span className="text-gray-400">Not yet scanned ({scanStatus.not_scanned.length}):</span>{' '}
                  {scanStatus.not_scanned.slice(0, 8).join(', ')}
                  {scanStatus.not_scanned.length > 8 ? ` +${scanStatus.not_scanned.length - 8} more` : ''}
                </p>
              )}

              {!scanStatus && (
                <p className="text-xs text-gray-600 border-t border-[#2a2d3a] pt-3">
                  Click <span className="text-gray-400">↻ Refresh Status</span> to load current scan data,
                  or ask Claude to &ldquo;run the creative scan for {MONTH_NAMES[currentMonth]} {currentYear}&rdquo;.
                </p>
              )}
            </div>

          </div>
        )}

        {/* ════════════════════════════════════════════════════════════════════ */}
        {/* BUDGET IMPORT VIEW */}
        {/* ════════════════════════════════════════════════════════════════════ */}
        {view === 'import' && (
          <div className="space-y-4 max-w-3xl">
            <div className="bg-[#1a1d2a] border border-[#333] rounded-xl p-5 space-y-3">
              <p className="text-sm font-bold text-white">Import Planned Budgets — {MONTH_NAMES[currentMonth]} {currentYear}</p>
              <p className="text-xs text-gray-400 leading-relaxed">
                Paste rows from the TTD, Social, or YouTube tabs of the budget workbook. Format: one row per line, comma-separated:
                <br />
                <code className="bg-[#0f1117] px-2 py-0.5 rounded text-green-400 text-[11px]">
                  Client Name, Campaign Type, Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec
                </code>
                <br />
                The importer will detect the platform from the Campaign Type column (CTV/Display/Audio → TTD; Meta/TikTok/etc → Social).
                Dollar signs, quotes, and commas within numbers are stripped automatically.
              </p>
              <textarea
                value={importText}
                onChange={e => setImportText(e.target.value)}
                rows={12}
                placeholder={`Placeholder Construction,CTV,41667,108333,108333,108333,58333,58333,58333,...\nPlaceholder Construction,Display,86957,86957,...`}
                className="w-full bg-[#0f1117] border border-[#333] text-green-300 text-xs font-mono rounded-lg p-3 focus:outline-none focus:ring-1 focus:ring-[#0075a9] resize-y"
              />
              <div className="flex gap-3 items-center">
                <button onClick={runImport} disabled={importing || !importText.trim()}
                  className={`${btnClass} bg-[#0075a9] hover:bg-[#003057] text-white`}>
                  {importing ? 'Importing…' : 'Import Budgets'}
                </button>
                <button onClick={() => setImportText('')} className={`${btnClass} bg-[#2a2d3a] text-gray-400 hover:text-white`}>
                  Clear
                </button>
                <span className="text-xs text-gray-600">
                  {importText.trim().split('\n').filter(Boolean).length} rows in paste
                </span>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* CAMPAIGN DETAIL SIDE PANEL (read-only) */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      {selectedPacing && (() => {
        const r = selectedPacing
        const cMeta = initialClientMeta.find(m => m.client_name === r.client_name)
        const kMeta = initialCampaignMeta.find(m =>
          m.client_name === r.client_name && m.platform === r.platform && m.campaign_type === r.campaign_type)
        const tasks = initialTasks.filter(t =>
          t.client_name === r.client_name &&
          (t.platform === null || t.platform === r.platform) &&
          (t.campaign_type === null || t.campaign_type === r.campaign_type))
        const meta = SEVERITY_META[r.severity]
        return (
          <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelectedPacing(null)}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative w-full max-w-md h-full bg-[#12141c] border-l border-[#333] overflow-y-auto"
              onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div className="sticky top-0 bg-[#12141c] border-b border-[#2a2d3a] px-5 py-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: meta.dot }} />
                    <span className="text-[10px] font-bold uppercase tracking-wide text-gray-300">{meta.label}</span>
                  </div>
                  <h2 className="text-lg font-bold text-white mt-1 truncate" title={r.client_name}>{r.client_name}</h2>
                  <p className="text-xs text-gray-500">{r.platform}{r.campaign_type ? ` · ${r.campaign_type}` : ''}</p>
                </div>
                <button onClick={() => setSelectedPacing(null)} className="text-gray-500 hover:text-white text-xl leading-none">✕</button>
              </div>

              <div className="px-5 py-4 space-y-5">
                {/* Suggested action */}
                <div className="rounded-lg border border-[#2a2d3a] bg-[#0f1117] p-3">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Suggested action</p>
                  <p className="text-sm text-gray-200">{suggestedAction(r)}</p>
                </div>

                {/* Pacing numbers */}
                <div className="grid grid-cols-3 gap-2">
                  {([['Planned', r.planned_amount], ['Expected', r.expected_spend], ['Actual', r.actual_spend]] as const).map(([l, v]) => (
                    <div key={l} className="bg-[#0f1117] rounded-lg px-3 py-2 border border-[#2a2d3a]">
                      <p className="text-[9px] text-gray-500 uppercase tracking-widest">{l}</p>
                      <p className="text-sm font-bold text-white mt-0.5 tabular-nums">{fmtUnit(v, r.campaign_type)}</p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
                  <span>Pacing:{' '}
                    <span style={{ color: r.deviation_pct === null ? '#666' : r.deviation_pct >= 0 ? '#4ade80' : '#f87171' }}>
                      {r.deviation_pct === null ? '—' : `${r.deviation_pct > 0 ? '+' : ''}${r.deviation_pct}%`}
                    </span>
                  </span>
                  <span>Flight: {r.flight_status === 'no_dates' ? 'not set' : r.flight_status.replace('_', ' ')}</span>
                  <span>Creative: {r.has_creative === true ? '✓' : r.has_creative === false ? '✗ missing' : 'not checked'}</span>
                </div>
                {r.flight_start_date && r.flight_end_date && (
                  <p className="text-[11px] text-gray-500">Flight {r.flight_start_date} → {r.flight_end_date}</p>
                )}

                {/* Client metadata */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Client</p>
                  {cMeta && (cMeta.geography || cMeta.notes) ? (
                    <div className="space-y-1 text-sm">
                      {cMeta.geography && <p className="text-gray-300"><span className="text-gray-500">Geography:</span> {cMeta.geography}</p>}
                      {cMeta.notes && <p className="text-gray-300 whitespace-pre-wrap">{cMeta.notes}</p>}
                    </div>
                  ) : <p className="text-gray-600 text-xs italic">No client metadata yet.</p>}
                </div>

                {/* Campaign metadata */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Campaign</p>
                  {kMeta && (kMeta.audiences || kMeta.notes) ? (
                    <div className="space-y-1 text-sm">
                      {kMeta.audiences && <p className="text-gray-300"><span className="text-gray-500">Audiences:</span> {kMeta.audiences}</p>}
                      {kMeta.notes && <p className="text-gray-300 whitespace-pre-wrap">{kMeta.notes}</p>}
                    </div>
                  ) : <p className="text-gray-600 text-xs italic">No campaign metadata yet.</p>}
                </div>

                {/* Open tasks */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1.5">Open tasks ({tasks.length})</p>
                  {tasks.length > 0 ? (
                    <div className="space-y-2">
                      {tasks.map(t => (
                        <div key={t.id} className="rounded-lg border border-[#2a2d3a] bg-[#0f1117] p-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded text-white"
                              style={{ backgroundColor: t.priority === 'high' ? '#7f1d1d' : t.priority === 'medium' ? '#78350f' : '#374151' }}>
                              {t.priority}
                            </span>
                            <span className="text-[9px] text-gray-500 uppercase">{t.status.replace('_', ' ')}</span>
                            {t.due_date && <span className="text-[9px] text-gray-500 ml-auto">due {t.due_date}</span>}
                          </div>
                          <p className="text-sm text-gray-200 mt-1">{t.title}</p>
                          {t.description && <p className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">{t.description}</p>}
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-gray-600 text-xs italic">No open tasks.</p>}
                  <p className="text-[10px] text-gray-600 mt-2">Editing tasks &amp; metadata comes in a follow-up — read-only for now.</p>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
