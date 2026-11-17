import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { rollUpCampaignFromScopes } from '@/lib/adviewerReviewToken'
import type { AdviewerStatus } from '@/types'

// Per-location review links for one campaign. Same gating as the rest of the
// adviewer campaign routes: requireWriter() = any logged-in staff member, then
// every write runs on the service-role client so a non-admin staffer's action
// actually sticks instead of being dropped by RLS while the UI updates.
//
// See supabase/add_adviewer_campaign_scopes.sql and
// docs/proposals/adviewer-location-scopes.md for why scopes rather than one
// campaign per location.

// Mirrors app/api/adviewer/review/route.ts. Without it an unexpected string
// reaches the check constraint and comes back as a 500, which the dashboard
// shows as "Could not update this location" — a server fault for what is a bad
// request.
const STATUSES = new Set<AdviewerStatus>(['pending', 'approved', 'needs_revision'])

interface ScopeRow {
  id: string
  campaign_id: string
  atlas_location_id: string | null
  token: string
  status: AdviewerStatus
  sent_at: string | null
  closed_by: string | null
  closed_note: string | null
  created_at: string
  updated_at: string
  atlas_location: { id: string; name: string } | null
}

const SCOPE_SELECT =
  'id, campaign_id, atlas_location_id, token, status, sent_at, closed_by, closed_note, created_at, updated_at, atlas_location:atlas_locations(id, name)'

async function listScopes(campaignId: string): Promise<ScopeRow[]> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('adviewer_campaign_scopes')
    .select(SCOPE_SELECT)
    .eq('campaign_id', campaignId)
  const rows = (data ?? []) as unknown as ScopeRow[]
  // Alphabetical by location so the dashboard panel is scannable and stable;
  // there is no meaningful position ordering between locations.
  return rows.sort((a, b) => (a.atlas_location?.name ?? '').localeCompare(b.atlas_location?.name ?? ''))
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireWriter()
  if (denied) return denied
  const { id } = await params
  return NextResponse.json({ scopes: await listScopes(id) })
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireWriter()
  if (denied) return denied

  const { id } = await params
  const supabase = createAdminClient()

  const { data: campaign, error: campErr } = await supabase
    .from('adviewer_campaigns')
    .select('id, status')
    .eq('id', id)
    .single()
  if (campErr || !campaign) {
    return NextResponse.json({ error: campErr?.message ?? 'Campaign not found' }, { status: 404 })
  }

  // NO APPROVAL GATE. This used to 409 unless campaign.status === 'approved',
  // on the reasoning that links going to third parties shouldn't be mintable
  // before someone signed off. In practice that guard did nothing to protect
  // anyone and a great deal to get in the way: generating a link is not sending
  // it. Nothing here reaches a location until a human copies it and hands it
  // over, so the real control was always the person, not the status check.
  //
  // What the gate did cause: corporate approval archives the campaign, which
  // hides it from the dashboard, which meant staff had to approve, then find the
  // campaign again in a filter built specifically to show archived ones, before
  // they could generate. Three steps of ceremony in front of a copy button, and
  // no way to push links out at all when corporate went quiet.
  //
  // The panel still says whether corporate has signed off. It just doesn't stop
  // anyone. See docs/proposals/adviewer-location-scopes.md.

  const { data: links, error: linkErr } = await supabase
    .from('adviewer_campaign_cards')
    .select('id, card:cards(id, atlas_location_id, archived)')
    .eq('campaign_id', id)
  if (linkErr) return NextResponse.json({ error: linkErr.message }, { status: 500 })

  // Archived cards are pulled work and are already hidden from every client
  // surface, so a location whose only creatives were archived gets no link.
  // Filtered in JS for the same reason page.tsx does it: a PostgREST filter on
  // an embedded resource returns the parent row with card: null rather than
  // dropping it.
  const rows = (links ?? []) as unknown as {
    card: { id: string; atlas_location_id: string | null; archived: boolean | null } | null
  }[]
  const locationIds = [
    ...new Set(
      rows
        .filter((r) => r.card && r.card.archived !== true && r.card.atlas_location_id)
        .map((r) => r.card!.atlas_location_id as string),
    ),
  ]

  if (locationIds.length === 0) {
    return NextResponse.json(
      { error: 'No creatives in this campaign are tied to a location, so there is nothing to split.' },
      { status: 422 },
    )
  }

  // ignoreDuplicates makes this INSERT ... ON CONFLICT DO NOTHING, which is the
  // whole point: a second click may only ADD scopes for locations that gained
  // creatives since. Re-minting a token for a location that already has one
  // would silently break a link already sitting in someone's inbox, and nobody
  // would find out until they clicked it.
  const { error: upsertErr } = await supabase
    .from('adviewer_campaign_scopes')
    .upsert(
      locationIds.map((locationId) => ({ campaign_id: id, atlas_location_id: locationId })),
      { onConflict: 'campaign_id,atlas_location_id', ignoreDuplicates: true },
    )
  if (upsertErr) return NextResponse.json({ error: upsertErr.message }, { status: 500 })

  return NextResponse.json({ scopes: await listScopes(id) })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireWriter()
  if (denied) return denied

  const { id } = await params
  const body = (await req.json()) as {
    scopeId?: string
    status?: AdviewerStatus
    markSent?: boolean
    closedNote?: string | null
  }
  if (!body.scopeId) return NextResponse.json({ error: 'scopeId is required' }, { status: 400 })
  if (body.status !== undefined && !STATUSES.has(body.status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const patch: Record<string, string | null> = { updated_at: new Date().toISOString() }

  if (body.status) patch.status = body.status
  if (body.markSent) patch.sent_at = new Date().toISOString()
  if (body.closedNote !== undefined) {
    patch.closed_note = body.closedNote
    // Stamp who closed it from the session, never from the request body — the
    // note is the record of an off-platform conversation and needs an owner.
    const authed = await createClient()
    const { data: { user } } = await authed.auth.getUser()
    patch.closed_by = body.closedNote === null ? null : (user?.id ?? null)
  }

  const { error } = await supabase
    .from('adviewer_campaign_scopes')
    .update(patch)
    .eq('id', body.scopeId)
    .eq('campaign_id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Recording a sign-off on a location's behalf has to roll up exactly like that
  // location clicking approve on its own link. Without this, Close → Record
  // sign-off moved the scope row and nothing else — so a campaign whose changes
  // all arrived by email (the documented path, and the normal one) could have
  // every one of its locations approved and still sit at needs_revision
  // forever. Only a status write can change the rollup, so markSent alone skips it.
  if (body.status) await rollUpCampaignFromScopes(supabase, id)

  return NextResponse.json({ scopes: await listScopes(id) })
}
