import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'

// Rename / move / reorder a Lookbook folder, or delete it. Staff-gated + service-role.
// Deleting cascades to child folders (parent_id ON DELETE CASCADE) and un-files any
// campaigns in it (adviewer_campaigns.lookbook_folder_id ON DELETE SET NULL) — the
// campaigns, their cards, files and tokens are never touched.
//
// ── WHY `kind` GATES EVERYTHING BELOW ────────────────────────────────────────
//
// The client → year → month folders are not decoration; they are the index
// adviewer_ensure_lookbook_path() navigates. It finds them BY NAME:
//
//   where parent_id = v_client_folder and name = v_year  and kind = 'year'
//   where parent_id = v_year_folder   and name = v_month and kind = 'month'
//
// so renaming `August` to `August Refresh`, or moving it out from under its
// year, does not rename a label — it makes the lookup miss. The next campaign
// approved for that client silently inserts a SECOND `August` beside it and the
// month's campaigns split across two folders with nothing on screen explaining
// why. The client folder is the exception: it is found by client_id, so its
// name is free text.
//
// The same applies to DELETE, harder. Deleting a client root cascades every
// year and month under it and un-files every campaign that client has ever
// archived, in one request, from a menu item that looks like any other.

type FolderKind = 'client' | 'year' | 'month' | 'custom'

interface FolderRow {
  id: string
  kind: FolderKind
  name: string
  parent_id: string | null
  client_id: string | null
}

const STRUCTURAL: FolderKind[] = ['year', 'month']

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireWriter()
  if (denied) return denied
  const { id } = await params

  let body: { name?: string; parent_id?: string | null; position?: number }
  try {
    body = (await req.json()) as { name?: string; parent_id?: string | null; position?: number }
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const supabase = createAdminClient()

  const { data: folder, error: readErr } = await supabase
    .from('adviewer_lookbook_folders')
    .select('id, kind, name, parent_id, client_id')
    .eq('id', id)
    .maybeSingle<FolderRow>()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (typeof body.name === 'string') {
    const n = body.name.trim()
    if (!n) return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 })
    if (STRUCTURAL.includes(folder.kind)) {
      return NextResponse.json(
        {
          error: `"${folder.name}" is a ${folder.kind} folder, and campaigns are filed into it by name. Renaming it would send the next ${folder.kind === 'year' ? 'year' : 'month'}'s campaigns into a new folder beside this one. Make a custom folder instead if you need a different label.`,
        },
        { status: 409 },
      )
    }
    patch.name = n
  }

  if ('parent_id' in body) {
    const next = body.parent_id ?? null

    if (next === id) {
      return NextResponse.json({ error: 'A folder cannot be its own parent' }, { status: 400 })
    }
    if (folder.kind === 'client') {
      return NextResponse.json(
        { error: 'A client folder is the root of its tree and cannot be moved — the filing lookup expects it to have no parent.' },
        { status: 409 },
      )
    }
    if (STRUCTURAL.includes(folder.kind)) {
      return NextResponse.json(
        { error: `A ${folder.kind} folder is found by its position in the tree, so moving it would split that ${folder.kind}'s campaigns across two folders.` },
        { status: 409 },
      )
    }

    // A real ancestor walk, server-side. The comment this replaces said deeper
    // cycles were prevented because "the UI never offers a folder's own subtree
    // as a move target" — but there is no folder-move UI at all, so the
    // invariant it leaned on did not exist. Two PATCHes (A→B, B→A) were enough
    // to make the client's depthOf() and path() loops spin forever and freeze
    // the tab for every campaign of that client.
    if (next) {
      const { data: all, error: allErr } = await supabase
        .from('adviewer_lookbook_folders')
        .select('id, parent_id, client_id')
      if (allErr) return NextResponse.json({ error: allErr.message }, { status: 500 })

      const target = (all ?? []).find((f) => f.id === next)
      if (!target) return NextResponse.json({ error: 'Target folder not found' }, { status: 404 })
      if (target.client_id !== folder.client_id) {
        return NextResponse.json({ error: "A folder can't be moved into another client's Lookbook." }, { status: 400 })
      }

      const parentOf = new Map((all ?? []).map((f) => [f.id as string, (f.parent_id as string | null) ?? null]))
      let cursor: string | null = next
      // Bounded as well as cycle-checked: if the data is ALREADY cyclic from
      // before this guard existed, an unbounded walk would hang the route too.
      for (let hops = 0; cursor && hops <= parentOf.size; hops++) {
        if (cursor === id) {
          return NextResponse.json(
            { error: 'That would put the folder inside itself.' },
            { status: 400 },
          )
        }
        cursor = parentOf.get(cursor) ?? null
      }
    }

    patch.parent_id = next
  }

  if (typeof body.position === 'number') patch.position = body.position

  const { data, error } = await supabase
    .from('adviewer_lookbook_folders')
    .update(patch)
    .eq('id', id)
    .select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireWriter()
  if (denied) return denied
  const { id } = await params

  const supabase = createAdminClient()

  const { data: folder, error: readErr } = await supabase
    .from('adviewer_lookbook_folders')
    .select('id, kind, name, parent_id, client_id')
    .eq('id', id)
    .maybeSingle<FolderRow>()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 })

  if (folder.kind === 'client') {
    return NextResponse.json(
      {
        error: `"${folder.name}" is the root folder for this client. Deleting it would remove every year and month beneath it and un-file every campaign this client has archived. Delete the folders inside it instead.`,
      },
      { status: 409 },
    )
  }

  // A year or month may go once it is genuinely empty — an old, unused year is
  // reasonable to clear. What is not reasonable is doing it silently while
  // campaigns are still filed in it: the cascade un-files them and they
  // reappear as loose tiles in the Lookbook root with no explanation.
  if (STRUCTURAL.includes(folder.kind)) {
    const [{ count: childCount, error: childErr }, { count: campaignCount, error: campErr }] = await Promise.all([
      supabase.from('adviewer_lookbook_folders').select('id', { count: 'exact', head: true }).eq('parent_id', id),
      supabase.from('adviewer_campaigns').select('id', { count: 'exact', head: true }).eq('lookbook_folder_id', id),
    ])
    // A failed count must not read as "empty" — the delete below cascades.
    const countErr = childErr ?? campErr
    if (countErr) return NextResponse.json({ error: countErr.message }, { status: 500 })
    const children = childCount ?? 0
    const campaigns = campaignCount ?? 0
    if (children > 0 || campaigns > 0) {
      const parts = [
        children > 0 ? `${children} folder${children === 1 ? '' : 's'}` : null,
        campaigns > 0 ? `${campaigns} campaign${campaigns === 1 ? '' : 's'}` : null,
      ].filter(Boolean)
      const only = children + campaigns === 1
      return NextResponse.json(
        {
          error: `"${folder.name}" still holds ${parts.join(' and ')}. Move ${only ? 'it' : 'them'} out first — deleting this would un-file ${only ? 'it' : 'them'}.`,
        },
        { status: 409 },
      )
    }
  }

  const { error } = await supabase.from('adviewer_lookbook_folders').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
