import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requirePacingUser, requirePacingUserOrApiKey } from '@/lib/pacingAuth'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pacing/checklist/scan?month=6&year=2026
// Returns current creative_check_results for the given month + list of
// which clients haven't been scanned yet.
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const denied = await requirePacingUser()
  if (denied) return denied

  try {
    const { searchParams } = new URL(req.url)
    const month = parseInt(searchParams.get('month') ?? '')
    const year  = parseInt(searchParams.get('year')  ?? '')

    if (!month || !year) {
      return NextResponse.json({ error: 'month and year required' }, { status: 400 })
    }

    const supabase = createAdminClient()

    const [{ data: files }, { data: results }] = await Promise.all([
      supabase.from('media_plan_files').select('client_name, drive_file_id').eq('active', true).order('client_name'),
      supabase.from('creative_check_results').select('*').eq('check_month', month).eq('check_year', year),
    ])

    const scannedClients = new Set(
      (results ?? []).map(r => `${r.client_name}||${r.platform}`)
    )

    const allClients = files ?? []
    const notScanned = allClients.filter(f => {
      // A client is "scanned" if both Display and Social results exist
      const hasDisplay = scannedClients.has(`${f.client_name}||Display`)
      const hasSocial  = scannedClients.has(`${f.client_name}||Social`)
      return !hasDisplay && !hasSocial
    })

    const lastScanned = (results ?? []).reduce<string | null>((latest, r) => {
      if (!r.last_checked_at) return latest
      if (!latest) return r.last_checked_at
      return r.last_checked_at > latest ? r.last_checked_at : latest
    }, null)

    return NextResponse.json({
      month,
      year,
      total_clients: allClients.length,
      scanned_count: allClients.length - notScanned.length,
      not_scanned:   notScanned.map(f => f.client_name),
      last_scanned_at: lastScanned,
      results: results ?? [],
    })
  } catch (err) {
    console.error('Scan status error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pacing/checklist/scan
// Body: {
//   month: number
//   year: number
//   results: Array<{
//     client_name: string
//     platform: 'Display' | 'Social' | 'CTV'
//     has_creative: boolean
//     creative_details?: string   // e.g. "M4-Branding, M4-GAF found for July"
//   }>
// }
//
// Upserts scan results into creative_check_results and returns a summary.
// Actual Drive file reading is done externally (Claude session or scheduled task)
// which then POSTs results here.
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const denied = await requirePacingUserOrApiKey(req)
  if (denied) return denied

  try {
    const body = await req.json() as {
      month: number
      year: number
      results: Array<{
        client_name: string
        platform: 'Display' | 'Social' | 'CTV'
        has_creative: boolean
        creative_details?: string
      }>
    }

    const { month, year, results } = body

    if (!month || !year) {
      return NextResponse.json({ error: 'month and year required' }, { status: 400 })
    }

    if (!results || results.length === 0) {
      // No results body: return current status (same as GET)
      const supabase = createAdminClient()
      const { data } = await supabase
        .from('creative_check_results')
        .select('*')
        .eq('check_month', month)
        .eq('check_year', year)

      return NextResponse.json({
        message: 'No results provided. Current scan data returned.',
        results: data ?? [],
      })
    }

    const supabase = createAdminClient()
    const now = new Date().toISOString()

    const upsertRows = results.map(r => ({
      client_name:      r.client_name,
      platform:         r.platform,
      check_month:      month,
      check_year:       year,
      has_creative:     r.has_creative,
      creative_details: r.creative_details ?? null,
      last_checked_at:  now,
    }))

    const { error } = await supabase
      .from('creative_check_results')
      .upsert(upsertRows, {
        onConflict: 'client_name,check_month,check_year,platform',
        ignoreDuplicates: false,
      })

    if (error) throw new Error(error.message)

    const goCount     = results.filter(r => r.has_creative).length
    const blockedCount = results.filter(r => !r.has_creative).length

    return NextResponse.json({
      success:       true,
      upserted:      results.length,
      go_count:      goCount,
      blocked_count: blockedCount,
      scanned_at:    now,
    })
  } catch (err) {
    console.error('Scan upsert error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
