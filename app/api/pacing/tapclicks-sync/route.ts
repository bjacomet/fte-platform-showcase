import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { fetchTtdCampaignsMtd, type TtdCampaignMtd } from '@/lib/tapclicks'

export const maxDuration = 120

const SYNC_USER = 'tapclicks-sync'

interface Mapping {
  id: string
  report_source: string
  report_advertiser: string
  report_campaign: string
}

// TapClicks spells some advertisers differently from the TTD export the manual
// upload reads ("Acme Trailers" vs "Acme Trailer", "Smith, Jones, &
// Lee" vs "Smith Jones, Lee"); campaign names match exactly.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '')

function resolve(
  row: TtdCampaignMtd,
  ttdAdvertiser: string | undefined,
  mappings: Mapping[],
): string | null {
  const camp = row.campaign.toLowerCase()
  const advMatches = (m: Mapping) =>
    (ttdAdvertiser && m.report_advertiser.toLowerCase() === ttdAdvertiser.toLowerCase()) ||
    norm(m.report_advertiser) === norm(row.advertiser)

  // Same precedence as the manual upload: an explicit campaign mapping wins,
  // then the advertiser catch-all (report_campaign = '').
  const exact = mappings.filter(m => m.report_campaign.toLowerCase() === camp)
  if (exact.length) return (exact.find(advMatches) ?? exact[0]).id
  const wild = mappings.find(m => m.report_campaign === '' && advMatches(m))
  return wild?.id ?? null
}

async function syncMonth(year: number, month: number, dryRun: boolean) {
  const supabase = createAdminClient()
  const rows = await fetchTtdCampaignsMtd(year, month)

  const { data: mappingData, error: mapErr } = await supabase
    .from('campaign_mappings')
    .select('id, report_source, report_advertiser, report_campaign')
    .eq('active', true)
    .ilike('report_source', 'ttd')
  if (mapErr) throw new Error(`load mappings: ${mapErr.message}`)
  const mappings = (mappingData ?? []) as Mapping[]

  // TTD-style advertiser name per campaign, learned from recent manual uploads,
  // so stored rows look exactly like a TTD export row.
  const { data: recentUploads } = await supabase
    .from('spend_uploads')
    .select('id')
    .eq('report_source', 'ttd')
    .neq('uploaded_by', SYNC_USER)
    .order('created_at', { ascending: false })
    .limit(3)
  const aliasByCampaign = new Map<string, string>()
  const ids = (recentUploads ?? []).map(u => u.id as string)
  if (ids.length) {
    const { data: hist } = await supabase
      .from('spend_data')
      .select('report_campaign, report_advertiser, upload_id')
      .in('upload_id', ids)
    for (const id of ids) {
      for (const h of hist ?? []) {
        if (h.upload_id !== id) continue
        const key = String(h.report_campaign).toLowerCase()
        if (!aliasByCampaign.has(key)) aliasByCampaign.set(key, String(h.report_advertiser))
      }
    }
  }
  for (const m of mappings) {
    if (m.report_campaign && !aliasByCampaign.has(m.report_campaign.toLowerCase())) {
      aliasByCampaign.set(m.report_campaign.toLowerCase(), m.report_advertiser)
    }
  }

  const spendRows = rows.map(r => {
    const alias = aliasByCampaign.get(r.campaign.toLowerCase())
    return {
      report_source: 'ttd',
      report_advertiser: alias ?? r.advertiser,
      report_campaign: r.campaign,
      report_ad_group: null,
      // TapClicks' TTD feed has no cost field. Pacing for Display/CTV/Audio is
      // impression-based; recommended_budget is suppressed when spend is 0.
      spend: 0,
      impressions: r.impressions,
      clicks: r.clicks,
      mapping_id: resolve(r, alias, mappings),
    }
  })

  const totalImpressions = spendRows.reduce((s, r) => s + r.impressions, 0)
  const unmapped = spendRows.filter(r => !r.mapping_id && r.impressions > 0).map(r => r.report_campaign)
  const summary = {
    year, month, campaigns: spendRows.length, totalImpressions,
    unmappedWithDelivery: unmapped,
  }
  if (dryRun || !spendRows.length) return { ...summary, written: false }

  // TapClicks runs through yesterday. v_pacing_current paces expected delivery
  // to this date, not to today, or every line reads a day behind.
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)

  const { data: upload, error: upErr } = await supabase
    .from('spend_uploads')
    .insert({
      report_source: 'ttd',
      report_month: month,
      report_year: year,
      uploaded_by: SYNC_USER,
      row_count: spendRows.length,
      total_spend: 0,
      total_impressions: totalImpressions,
      data_through: yesterday < monthEnd ? yesterday : monthEnd,
    })
    .select('id')
    .single()
  if (upErr || !upload) throw new Error(`create upload: ${upErr?.message ?? 'no row'}`)

  const { error: insErr } = await supabase
    .from('spend_data')
    .insert(spendRows.map(r => ({ ...r, upload_id: upload.id })))
  if (insErr) {
    await supabase.from('spend_uploads').delete().eq('id', upload.id)
    throw new Error(`store rows: ${insErr.message}`)
  }
  // Replace, don't accumulate: one TapClicks upload per month. Older syncs are
  // deleted only after the new one is stored (spend_data cascades), so a failed
  // run never leaves the month without an is_latest upload. Manual uploads stay
  // as history; the insert above became is_latest via trg_spend_upload_latest.
  const { error: delErr } = await supabase
    .from('spend_uploads')
    .delete()
    .eq('report_source', 'ttd')
    .eq('report_month', month)
    .eq('report_year', year)
    .eq('uploaded_by', SYNC_USER)
    .neq('id', upload.id)
  if (delErr) console.error('[tapclicks sync] clear previous sync:', delErr.message)

  return { ...summary, written: true, uploadId: upload.id }
}

/**
 * Daily TTD delivery feed for /pacing from the TapClicks API (current through
 * yesterday). CRON_SECRET-guarded. `?dryRun=1` reports without writing;
 * `?year=&month=` targets a specific month. In the first 3 days of a month the
 * previous month is re-synced too, so its final days land.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const params = req.nextUrl.searchParams
  const dryRun = params.get('dryRun') === '1'

  try {
    const now = new Date()
    const targets: Array<[number, number]> = []
    if (params.get('year') && params.get('month')) {
      targets.push([Number(params.get('year')), Number(params.get('month'))])
    } else {
      const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1
      targets.push([y, m])
      if (now.getUTCDate() <= 3) targets.push(m === 1 ? [y - 1, 12] : [y, m - 1])
    }
    const results = []
    for (const [y, m] of targets) results.push(await syncMonth(y, m, dryRun))
    return NextResponse.json({ ok: true, dryRun, results })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[tapclicks sync]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
