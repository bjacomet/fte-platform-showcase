import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/writers'

export async function POST(req: NextRequest) {
  // Staff-only authoring endpoint — require an authenticated session before
  // touching the service-role client (was previously world-writable).
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isStaffUser())) return NextResponse.json({ error: 'Forbidden — staff access only' }, { status: 403 })

  const { title, client_id, card_ids } = await req.json() as {
    title: string
    client_id: string
    card_ids: string[]
  }

  if (!title?.trim() || !client_id) {
    return NextResponse.json({ error: 'title and client_id are required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Create campaign
  const { data: campaign, error: campaignError } = await supabase
    .from('adviewer_campaigns')
    .insert({ title: title.trim(), client_id })
    .select('id, token')
    .single()

  if (campaignError || !campaign) {
    return NextResponse.json({ error: campaignError?.message ?? 'Failed to create campaign' }, { status: 500 })
  }

  // Insert campaign cards in order (skip if file-only campaign)
  if (card_ids?.length) {
    const cardRows = card_ids.map((card_id, i) => ({
      campaign_id: campaign.id,
      card_id,
      position: i,
    }))

    const { error: cardsError } = await supabase
      .from('adviewer_campaign_cards')
      .insert(cardRows)

    if (cardsError) {
      // Roll back campaign
      await supabase.from('adviewer_campaigns').delete().eq('id', campaign.id)
      return NextResponse.json({ error: cardsError.message }, { status: 500 })
    }
  }

  return NextResponse.json({
    campaign_id: campaign.id,
    token: campaign.token,
    previewUrl: `/adviewer/c/${campaign.token}`,
  })
}
