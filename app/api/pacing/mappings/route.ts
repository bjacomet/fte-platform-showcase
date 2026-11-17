import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requirePacingUser } from '@/lib/pacingAuth'

// GET: all active mappings
export async function GET() {
  const denied = await requirePacingUser()
  if (denied) return denied

  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('campaign_mappings')
    .select('*')
    .eq('active', true)
    .order('report_source', { ascending: true })
    .order('report_advertiser', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ mappings: data ?? [] })
}

// POST: create or update a mapping
// Pass fix_spend_data_id to also update that spend_data row's mapping_id immediately
export async function POST(req: NextRequest) {
  const denied = await requirePacingUser()
  if (denied) return denied

  try {
    const body = await req.json()
    const { id, report_source, report_advertiser, report_campaign, planned_client, planned_platform, planned_campaign_type, notes, fix_spend_data_id } = body

    const supabase = createAdminClient()
    let mappingId: string | null = id ?? null

    if (id) {
      const { error } = await supabase
        .from('campaign_mappings')
        .update({ report_source, report_advertiser, report_campaign, planned_client, planned_platform, planned_campaign_type, notes })
        .eq('id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { data, error } = await supabase
        .from('campaign_mappings')
        .insert({ report_source, report_advertiser, report_campaign: report_campaign ?? '', planned_client, planned_platform, planned_campaign_type: planned_campaign_type ?? '', notes, active: true })
        .select('id')
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      mappingId = data?.id ?? null
    }

    if (fix_spend_data_id && mappingId) {
      await supabase.from('spend_data').update({ mapping_id: mappingId }).eq('id', fix_spend_data_id)
    }

    return NextResponse.json({ success: true, mappingId })
  } catch (err) {
    console.error('Mapping upsert error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// DELETE: deactivate a mapping
export async function DELETE(req: NextRequest) {
  const denied = await requirePacingUser()
  if (denied) return denied

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const supabase = createAdminClient()
  const { error } = await supabase.from('campaign_mappings').update({ active: false }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
