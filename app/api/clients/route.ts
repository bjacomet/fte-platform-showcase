import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { BLANK_CLIENT_FORM, validateClientForm, type ClientFormInput, type FieldErrors } from '@/lib/clientAdmin'

/**
 * Add or edit a client from the Clients page. One request writes both
 * `public.clients` and `ops.client_accounts` in a single transaction through
 * `public.admin_save_client` (service-role only; it calls `ops.begin` itself,
 * so every ops change lands in `ops.audit_log` with the staff member's email).
 *
 * POST { clientId: string | null, form: ClientFormInput }
 *   200 { client, account }
 *   400 { error, fieldErrors }    validation or duplicate name/abbreviation
 */
export async function POST(req: NextRequest) {
  const denied = await requireWriter()
  if (denied) return denied

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const email = user?.email ?? 'unknown'

  let body: { clientId?: unknown; form?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 })
  }
  const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId : null
  if (!body.form || typeof body.form !== 'object') {
    return NextResponse.json({ error: 'Missing form.' }, { status: 400 })
  }
  // Unknown keys are dropped; missing ones fall back to blank.
  const raw = body.form as Record<string, unknown>
  const form = Object.fromEntries(
    Object.entries(BLANK_CLIENT_FORM).map(([k, blank]) => {
      const v = raw[k]
      if (typeof blank === 'boolean') return [k, typeof v === 'boolean' ? v : blank]
      return [k, typeof v === 'string' ? v : blank]
    }),
  ) as unknown as ClientFormInput

  const admin = createAdminClient()
  const { data: existing, error: listErr } = await admin.from('clients').select('id, name, abbreviation')
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 })

  const { errors, client, account } = validateClientForm(form, existing ?? [], clientId)
  if (!client || !account) {
    return NextResponse.json({ error: 'Fix the highlighted fields.', fieldErrors: errors }, { status: 400 })
  }

  const { data, error } = await admin.rpc('admin_save_client', {
    p_client_id: clientId,
    p_client: client,
    p_account: account,
    p_actor: `app:${email}`,
    p_reason: `Clients page: ${clientId ? 'edited' : 'added'} client "${client.name}"`,
  })

  if (error) {
    if (error.code === '23505') {
      const fieldErrors: FieldErrors = error.message.includes('abbreviation')
        ? { abbreviation: 'Another client already uses this abbreviation.' }
        : { name: 'A client with this name already exists (check inactive clients too).' }
      return NextResponse.json({ error: 'Fix the highlighted fields.', fieldErrors }, { status: 400 })
    }
    if (error.code === 'PGRST202') {
      return NextResponse.json(
        { error: 'The database is missing admin_save_client — run supabase/add_client_admin_rpc.sql.' },
        { status: 500 },
      )
    }
    if (error.code === 'P0002') return NextResponse.json({ error: 'That client no longer exists.' }, { status: 404 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}
