import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/writers'

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isStaffUser())) return NextResponse.json({ error: 'Forbidden — staff access only' }, { status: 403 })

  const body = await req.json() as { clientId?: string; fb_ad_account_id?: string | null }
  if (!body.clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = await admin
    .from('clients')
    .update({ fb_ad_account_id: body.fb_ad_account_id ?? null })
    .eq('id', body.clientId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
