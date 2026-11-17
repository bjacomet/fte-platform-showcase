import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requirePacingUser } from '@/lib/pacingAuth'

// GET: fetch planned budgets for a given month/year
export async function GET(req: NextRequest) {
  const denied = await requirePacingUser()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  const month = parseInt(searchParams.get('month') ?? '')
  const year  = parseInt(searchParams.get('year')  ?? '')

  if (!month || !year) {
    return NextResponse.json({ error: 'month and year required' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('planned_budgets')
    .select('*')
    .eq('year', year)
    .eq('month', month)
    .order('client_name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ budgets: data ?? [] })
}

// POST: import planned budgets from Campaign Sheet CSV
// Expects JSON body: { year, month, rows: [{client_name, platform, campaign_type, planned_amount}] }
export async function POST(req: NextRequest) {
  const denied = await requirePacingUser()
  if (denied) return denied

  try {
    const body = await req.json()
    const { year, month, rows } = body as {
      year: number
      month: number
      rows: Array<{ client_name: string; platform: string; campaign_type: string; planned_amount: number }>
    }

    if (!year || !month || !rows?.length) {
      return NextResponse.json({ error: 'year, month, and rows required' }, { status: 400 })
    }

    const supabase = createAdminClient()
    const upsertRows = rows.map(r => ({
      year,
      month,
      client_name:    r.client_name,
      platform:       r.platform,
      campaign_type:  r.campaign_type,
      planned_amount: r.planned_amount,
      updated_at:     new Date().toISOString(),
    }))

    const { error } = await supabase
      .from('planned_budgets')
      .upsert(upsertRows, { onConflict: 'year,month,client_name,platform,campaign_type' })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, count: upsertRows.length })
  } catch (err) {
    console.error('Budget import error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
