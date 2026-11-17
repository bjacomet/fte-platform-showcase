import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PACING_ALLOWED } from '@/lib/pacingAuth'
import PacingClient from './PacingClient'

export const dynamic = 'force-dynamic'

export default async function PacingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!user.email || !PACING_ALLOWED.includes(user.email)) redirect('/')

  const now   = new Date()
  const month = now.getMonth() + 1   // 1-indexed
  const year  = now.getFullYear()

  // Load planned budgets for current month
  const { data: budgets } = await supabase
    .from('planned_budgets')
    .select('*')
    .eq('year', year)
    .eq('month', month)
    .order('client_name', { ascending: true })

  // Load latest spend uploads for current month (one per source — is_latest = true).
  // Old uploads are retained as history but must be excluded here, else their
  // spend_data would be summed alongside the current upload and inflate totals.
  const { data: uploads } = await supabase
    .from('spend_uploads')
    .select('*')
    .eq('report_month', month)
    .eq('report_year', year)
    .eq('is_latest', true)
    .order('created_at', { ascending: false })

  // Load spend data with mappings for current month uploads
  const uploadIds = (uploads ?? []).map(u => u.id)
  const { data: spendData } = uploadIds.length
    ? await supabase
        .from('spend_data')
        .select(`
          id, upload_id, report_source, report_advertiser, report_campaign,
          spend, impressions, clicks, mapping_id,
          campaign_mappings(planned_client, planned_platform, planned_campaign_type)
        `)
        .in('upload_id', uploadIds)
    : { data: [] }

  // Find the second-most-recent upload per source (for stale-spend detection)
  const { data: allMonthUploads } = await supabase
    .from('spend_uploads')
    .select('id, report_source')
    .eq('report_month', month)
    .eq('report_year', year)
    .order('created_at', { ascending: false })

  const prevUploadIds: string[] = []
  const _latestSeen = new Set<string>()
  const _prevSeen   = new Set<string>()
  for (const u of (allMonthUploads ?? [])) {
    if (!_latestSeen.has(u.report_source)) { _latestSeen.add(u.report_source); continue }
    if (!_prevSeen.has(u.report_source))   { _prevSeen.add(u.report_source); prevUploadIds.push(u.id) }
  }

  const { data: prevSpendDataRaw } = prevUploadIds.length
    ? await supabase
        .from('spend_data')
        .select(`
          id, upload_id, report_source, report_advertiser, report_campaign,
          spend, impressions, clicks, mapping_id,
          campaign_mappings(planned_client, planned_platform, planned_campaign_type)
        `)
        .in('upload_id', prevUploadIds)
    : { data: [] }

  const normalizedPrevSpend: SpendDataRow[] = ((prevSpendDataRaw ?? []) as unknown as Array<{
    id: string; upload_id: string; report_source: string; report_advertiser: string
    report_campaign: string; spend: number; impressions: number; clicks: number
    mapping_id: string | null
    campaign_mappings: Array<{ planned_client: string; planned_platform: string; planned_campaign_type: string }> | null
  }>).map(r => ({
    ...r,
    campaign_mappings: Array.isArray(r.campaign_mappings) ? (r.campaign_mappings[0] ?? null) : r.campaign_mappings,
  }))

  // Load all active mappings for the mapping manager
  const { data: mappings } = await supabase
    .from('campaign_mappings')
    .select('*')
    .eq('active', true)
    .order('report_source', { ascending: true })
    .order('report_advertiser', { ascending: true })

  // Triage roll-up for the current month — severity computed in v_pacing_current.
  // The view is current-month scoped (current_date) and computes flight-aware
  // expected spend + severity bucket. Client re-groups into the four sections.
  const { data: pacing } = await supabase
    .from('v_pacing_current')
    .select('*')

  // Feeds run through yesterday, so "day N" is the last day the data covers,
  // not today. Same date v_pacing_current paces expected delivery to.
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}-`
  const latestThrough = ((pacing ?? []) as PacingRow[])
    .map(r => r.data_through)
    .filter((d): d is string => !!d && d.startsWith(monthPrefix))
    .sort()
    .at(-1)
  const dataThroughDay = latestThrough ? Number(latestThrough.slice(8, 10)) : Math.max(now.getDate() - 1, 0)

  // Metadata + open tasks for the campaign detail side panel (read-only for now)
  const { data: clientMeta }   = await supabase.from('client_metadata').select('*')
  const { data: campaignMeta } = await supabase.from('campaign_metadata').select('*')
  const { data: tasks }        = await supabase
    .from('campaign_tasks')
    .select('*')
    .neq('status', 'done')
    .order('priority', { ascending: true })

  // Supabase returns campaign_mappings as an array from the join — flatten to single object
  const normalizedSpend: SpendDataRow[] = ((spendData ?? []) as unknown as Array<{
    id: string; upload_id: string; report_source: string; report_advertiser: string
    report_campaign: string; spend: number; impressions: number; clicks: number
    mapping_id: string | null
    campaign_mappings: Array<{ planned_client: string; planned_platform: string; planned_campaign_type: string }> | null
  }>).map(r => ({
    ...r,
    campaign_mappings: Array.isArray(r.campaign_mappings) ? (r.campaign_mappings[0] ?? null) : r.campaign_mappings,
  }))

  return (
    <PacingClient
      userEmail={user.email ?? ''}
      currentMonth={month}
      currentYear={year}
      initialBudgets={(budgets ?? []) as PlannedBudget[]}
      initialUploads={(uploads ?? []) as SpendUpload[]}
      initialSpendData={normalizedSpend}
      initialMappings={(mappings ?? []) as CampaignMapping[]}
      initialPacing={(pacing ?? []) as PacingRow[]}
      initialClientMeta={(clientMeta ?? []) as ClientMetadata[]}
      initialCampaignMeta={(campaignMeta ?? []) as CampaignMetadata[]}
      initialTasks={(tasks ?? []) as CampaignTask[]}
      prevSpendData={normalizedPrevSpend}
      daysInMonth={new Date(year, month, 0).getDate()}
      dayOfMonth={dataThroughDay}
    />
  )
}

// ── Types exported for client ─────────────────────────────────────────────────
export interface PlannedBudget {
  id: string
  year: number
  month: number
  client_name: string
  platform: string
  campaign_type: string
  planned_amount: number
}

export interface SpendUpload {
  id: string
  report_source: string
  report_month: number
  report_year: number
  uploaded_by: string | null
  row_count: number | null
  total_spend: number | null
  total_impressions: number | null
  is_latest: boolean
  created_at: string
}

export interface SpendDataRow {
  id: string
  upload_id: string
  report_source: string
  report_advertiser: string
  report_campaign: string
  spend: number
  impressions: number
  clicks: number
  mapping_id: string | null
  campaign_mappings: {
    planned_client: string
    planned_platform: string
    planned_campaign_type: string
  } | null
}

export interface CampaignMapping {
  id: string
  report_source: string
  report_advertiser: string
  report_campaign: string
  planned_client: string
  planned_platform: string
  planned_campaign_type: string
  notes: string | null
  active: boolean
}

// ── Triage (v_pacing_current view + metadata/tasks) ───────────────────────────
export type PacingSeverity = 'critical' | 'action_needed' | 'watch' | 'clean'
export type FlightStatus = 'no_dates' | 'not_started' | 'active' | 'ended'

export interface PacingRow {
  planned_budget_id: string
  year: number
  month: number
  client_name: string
  platform: string
  campaign_type: string
  planned_amount: number
  actual_spend: number
  expected_spend: number
  deviation_pct: number | null
  recommended_budget: number | null
  flight_start_date: string | null
  flight_end_date: string | null
  flight_status: FlightStatus
  flight_ends_in_days: number | null
  has_creative: boolean | null
  severity: PacingSeverity
  data_through: string | null
}

export interface ClientMetadata {
  client_name: string
  geography: string | null
  notes: string | null
}

export interface CampaignMetadata {
  client_name: string
  platform: string
  campaign_type: string
  audiences: string | null
  notes: string | null
}

export interface CampaignTask {
  id: string
  client_name: string
  platform: string | null
  campaign_type: string | null
  title: string
  description: string | null
  status: 'open' | 'in_progress' | 'done'
  priority: 'high' | 'medium' | 'low'
  due_date: string | null
}
