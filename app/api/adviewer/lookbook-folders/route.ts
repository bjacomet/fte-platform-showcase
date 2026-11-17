import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'

// Create a team-made folder in the Lookbook tree. Staff-gated (requireWriter = any
// logged-in staff, not an adviewer_clients account) + service-role, matching the
// other adviewer_* write routes. Always kind='custom' — the auto-structure folders
// (client/year/month) are created only by adviewer_ensure_lookbook_path.
export async function POST(req: NextRequest) {
  const denied = await requireWriter()
  if (denied) return denied

  let body: { client_id?: string; parent_id?: string | null; name?: string }
  try {
    body = (await req.json()) as { client_id?: string; parent_id?: string | null; name?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const name = body.name?.trim()
  if (!body.client_id || !name) {
    return NextResponse.json({ error: 'Missing client_id or name' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // A hand-made folder is always kind='custom', but adviewer_ensure_lookbook_path
  // looks for kind='year'/'month' — so pre-creating "2026" under a client, which
  // is a reasonable thing to do, produced a SECOND auto-created "2026" beside it
  // the next time a campaign was filed, and the partial unique index does not
  // cover custom rows. Refusing a duplicate sibling name is the honest half of
  // the fix that needs no migration: the user is told the folder already exists
  // instead of quietly getting two. Making the RPC's lookup name-only is the
  // other half and belongs in a migration.
  const dupeQuery = supabase
    .from('adviewer_lookbook_folders')
    .select('id, kind')
    .eq('client_id', body.client_id)
    // Escaped so `_` / `%` in a folder name match literally, not as wildcards.
    .ilike('name', name.replace(/[\\%_]/g, (c) => `\\${c}`))
  const { data: dupes, error: dupeErr } = body.parent_id
    ? await dupeQuery.eq('parent_id', body.parent_id)
    : await dupeQuery.is('parent_id', null)
  if (dupeErr) return NextResponse.json({ error: dupeErr.message }, { status: 500 })
  if (dupes && dupes.length > 0) {
    const kind = (dupes[0] as { kind: string }).kind
    return NextResponse.json(
      {
        error: kind === 'custom'
          ? `A folder called "${name}" is already here.`
          : `"${name}" already exists here as the ${kind} folder campaigns are filed into. Pick a different name.`,
      },
      { status: 409 },
    )
  }

  const { data, error } = await supabase
    .from('adviewer_lookbook_folders')
    .insert({ client_id: body.client_id, parent_id: body.parent_id ?? null, name, kind: 'custom' })
    .select('id, client_id, parent_id, name, kind, position, created_at, updated_at')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, folder: data })
}
