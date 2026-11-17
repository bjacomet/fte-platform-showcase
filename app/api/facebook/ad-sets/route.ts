import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { decryptToken, listFbAdSets } from '@/lib/meta'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const campaignId = searchParams.get('campaignId')
  if (!campaignId) return NextResponse.json({ error: 'campaignId required' }, { status: 400 })

  const admin = createAdminClient()

  const { data: tokenRow } = await admin
    .from('app_settings')
    .select('value')
    .eq('key', 'meta_ads_user_token_encrypted')
    .single()

  if (!tokenRow?.value) {
    return NextResponse.json({
      error: 'No Meta ads token. Reconnect Facebook in Settings.',
    }, { status: 422 })
  }

  const userToken = decryptToken(tokenRow.value)
  const adSets = await listFbAdSets(campaignId, userToken)

  return NextResponse.json({ adSets })
}
