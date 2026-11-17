import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { decryptToken, normalizeAdAccountId, listFbCampaigns } from '@/lib/meta'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const rawAccountId = searchParams.get('adAccountId')
  const clientId = searchParams.get('clientId')

  if (!rawAccountId) return NextResponse.json({ error: 'adAccountId required' }, { status: 400 })

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
  const adAccountId = normalizeAdAccountId(rawAccountId)

  const campaigns = await listFbCampaigns(adAccountId, userToken)

  // Fetch the client's connected Facebook page if clientId provided
  let page: { fb_page_id: string; page_name: string } | null = null
  if (clientId) {
    const { data: pageRow } = await admin
      .from('social_pages')
      .select('fb_page_id, page_name')
      .eq('client_id', clientId)
      .eq('status', 'active')
      .limit(1)
      .single()
    page = pageRow ?? null
  }

  return NextResponse.json({ campaigns, page })
}
