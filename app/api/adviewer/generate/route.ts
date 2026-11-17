import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { generateAdviewerForCard } from '@/lib/adviewerGenerate'

export async function POST(req: NextRequest) {
  const auth = await createClient()

  const { data: { user } } = await auth.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Service role, gated by the getUser() check above. Publishing to Adviewer is a
  // capability every logged-in staff member has — anyone can drag a card into
  // "Ready for Adviewer" (cards UPDATE is open, see open_board_cluster_to_authenticated.sql)
  // — but client-side writes to adviewer_* are writer-only RLS
  // (restrict_writes_to_writers.sql). Running this route on the caller's session
  // silently dropped the adviewer_campaign_cards insert for non-writers while still
  // writing the card's preview URL, producing links to campaigns the card wasn't in.
  const supabase = createAdminClient()

  const body = await req.json() as { card_id: string }
  const { card_id } = body
  if (!card_id) return NextResponse.json({ error: 'card_id required' }, { status: 400 })

  const result = await generateAdviewerForCard(supabase, card_id)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ campaignId: result.campaignId, token: result.token, previewUrl: result.previewUrl })
}
