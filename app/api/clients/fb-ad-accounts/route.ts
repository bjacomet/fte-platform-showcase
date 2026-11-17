import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/clients/fb-ad-accounts?clientId=...
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 })

  const { data, error } = await supabase
    .from('client_fb_ad_accounts')
    .select('*')
    .eq('client_id', clientId)
    .eq('active', true)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ accounts: data ?? [] })
}

// POST /api/clients/fb-ad-accounts — add an account
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { clientId?: string; accountId?: string; label?: string }
  if (!body.clientId || !body.accountId) {
    return NextResponse.json({ error: 'clientId and accountId required' }, { status: 400 })
  }

  const normalized = body.accountId.trim().startsWith('act_')
    ? body.accountId.trim()
    : `act_${body.accountId.trim()}`

  const { data, error } = await supabase
    .from('client_fb_ad_accounts')
    .insert({ client_id: body.clientId, account_id: normalized, label: body.label?.trim() || null })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ account: data }, { status: 201 })
}

// DELETE /api/clients/fb-ad-accounts — soft-delete (set active=false) or hard delete
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { id?: string }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('client_fb_ad_accounts')
    .delete()
    .eq('id', body.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
