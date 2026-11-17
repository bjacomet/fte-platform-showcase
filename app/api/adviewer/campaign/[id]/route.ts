import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'

// Dashboard campaign lifecycle actions (archive / reset / approve / delete). Gated on
// requireWriter() = any logged-in STAFF member (authenticated, not an Adviewer
// client-portal account); the writes then run on the service-role admin client, which
// bypasses RLS. Client-side writes to adviewer_* go through the same staff tier
// (public.is_writer()); routing these through the service role is what makes a
// non-admin staffer's action actually stick instead of being silently dropped.

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireWriter()
  if (denied) return denied

  const { id } = await params
  const { action, folder_id } = await req.json() as { action: 'archive' | 'reset' | 'approve' | 'set-folder'; folder_id?: string | null }

  const supabase = createAdminClient()

  if (action === 'archive') {
    // Send to Lookbook. Linked cards keep their adpiler_preview_url: an archived
    // campaign still renders by token, so the board's "View in Adviewer" button
    // stays valid (deliberate — unlike delete, which clears the URLs below).
    const { error } = await supabase
      .from('adviewer_campaigns')
      .update({ archived: true })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const { error: fileErr } = await supabase.rpc('adviewer_ensure_lookbook_path', { p_campaign_id: id })
    if (fileErr) console.error('[campaign archive] auto-file failed', id, fileErr.message)
    return NextResponse.json({ ok: true })
  }

  if (action === 'reset') {
    const now = new Date().toISOString()
    // Per-location scopes are review state too, and a reset that skips them is
    // not merely incomplete — it is actively wrong now that
    // rollUpCampaignFromScopes owns `archived`. Left at their old values, a set
    // of stale all-approved scopes rolls the campaign straight back to approved
    // and files it into the Lookbook while the locations are still reviewing
    // the reset creatives. Latent only while no campaign has scopes. Done FIRST
    // so a failure partway through can't leave cards reset under approved scopes.
    //
    // `sent_at` is deliberately KEPT. Those links did go out; that is history,
    // and it is the only "have we asked them yet" signal there is — clearing it
    // walks staff into re-sending links already sitting in someone's inbox.
    // `closed_by`/`closed_note` ARE cleared, because they record a sign-off this
    // reset is undoing, and "approved by email — Maria" next to a pending status
    // is worse than no note at all. The token is never touched, by anything.
    const { error: scopeErr } = await supabase
      .from('adviewer_campaign_scopes')
      .update({ status: 'pending', closed_by: null, closed_note: null, updated_at: now })
      .eq('campaign_id', id)
    if (scopeErr) return NextResponse.json({ error: scopeErr.message }, { status: 500 })

    const { error: campErr } = await supabase
      .from('adviewer_campaigns')
      .update({ status: 'pending', updated_at: now })
      .eq('id', id)
    if (campErr) return NextResponse.json({ error: campErr.message }, { status: 500 })

    const { error: cardsErr } = await supabase
      .from('adviewer_campaign_cards')
      .update({ status: 'pending', location_status: null, client_notes: null, updated_at: now })
      .eq('campaign_id', id)
    if (cardsErr) return NextResponse.json({ error: cardsErr.message }, { status: 500 })

    return NextResponse.json({ ok: true })
  }

  if (action === 'approve') {
    // One-click admin approve: mark the campaign approved AND send it to the
    // Lookbook in one step. Linked cards keep their adpiler_preview_url (like
    // archive) so the board's "View in Adviewer" button stays valid.
    const now = new Date().toISOString()
    const { error } = await supabase
      .from('adviewer_campaigns')
      .update({ status: 'approved', archived: true, updated_at: now })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Approve the creatives too, not just the campaign. The Lookbook lists only
    // creatives whose own status is 'approved', so filing the campaign alone put
    // it in the Lookbook reading "0 creatives" with a placeholder tile, and none
    // of its work could reach a Creative Deck (PR #94 review). Staff use
    // this button to push a campaign live when Atlas approval never fully arrives,
    // so a creative nobody responded to is approved by that decision.
    //
    // Only PENDING items flip. A creative at needs_revision has an open change
    // request; approving it here would bury that request, so it stays as it is —
    // fix it and approve it on the card, or reset it, and it joins the Lookbook.
    // The same goes for a LOCATION's change request, which lives in
    // location_status (add_location_card_verdicts.sql), not status.
    // Archived board cards are skipped: they are pulled work, hidden from every
    // client surface.
    const { data: links, error: linkErr } = await supabase
      .from('adviewer_campaign_cards')
      .select('id, card_id, card:cards(archived)')
      .eq('campaign_id', id)
      .eq('status', 'pending')
      .or('location_status.is.null,location_status.neq.needs_revision')
    if (linkErr) return NextResponse.json({ error: linkErr.message }, { status: 500 })
    const live = ((links ?? []) as unknown as { id: string; card_id: string; card: { archived: boolean | null } | null }[])
      .filter((l) => l.card?.archived !== true)
    if (live.length > 0) {
      const { error: ccErr } = await supabase
        .from('adviewer_campaign_cards')
        .update({ status: 'approved', updated_at: now })
        .in('id', live.map((l) => l.id))
      if (ccErr) return NextResponse.json({ error: ccErr.message }, { status: 500 })
      // Keep the board's approval dot in step, as the AM card-approve path does.
      const { error: cardErr } = await supabase
        .from('cards')
        .update({ approval_status: 'approved' })
        .in('id', live.map((l) => l.card_id))
      if (cardErr) return NextResponse.json({ error: cardErr.message }, { status: 500 })
    }
    const { error: cfErr } = await supabase
      .from('adviewer_campaign_files')
      .update({ status: 'approved', updated_at: now })
      .eq('campaign_id', id)
      .eq('status', 'pending')
    if (cfErr) return NextResponse.json({ error: cfErr.message }, { status: 500 })

    const { error: fileErr } = await supabase.rpc('adviewer_ensure_lookbook_path', { p_campaign_id: id })
    if (fileErr) console.error('[campaign approve] auto-file failed', id, fileErr.message)
    return NextResponse.json({ ok: true })
  }

  if (action === 'set-folder') {
    // Move a campaign into a Lookbook folder (or null to unfile). Metadata only —
    // the campaign's cards, files and token are untouched.
    //
    // The folder has to belong to this campaign's client. The UI only ever offers
    // that client's folders, so this never fires from the app — but the route is
    // reachable directly, and a campaign filed under another client's tree is
    // both invisible where staff look for it and sitting inside a folder tree
    // shared with that other client's work.
    if (folder_id) {
      const { data: campaign } = await supabase
        .from('adviewer_campaigns').select('client_id').eq('id', id).maybeSingle()
      const { data: folder } = await supabase
        .from('adviewer_lookbook_folders').select('client_id').eq('id', folder_id).maybeSingle()
      if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 })
      if (campaign?.client_id && folder.client_id && campaign.client_id !== folder.client_id) {
        return NextResponse.json(
          { error: 'That folder belongs to a different client.' },
          { status: 409 },
        )
      }
    }
    const { data, error } = await supabase
      .from('adviewer_campaigns')
      .update({ lookbook_folder_id: folder_id ?? null, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireWriter()
  if (denied) return denied

  const { id } = await params

  const supabase = createAdminClient()

  // Clear adpiler_preview_url on linked board cards first so the "View in Adviewer"
  // button disappears — the campaign it points at is about to be gone.
  const { data: linked, error: linkedErr } = await supabase
    .from('adviewer_campaign_cards')
    .select('card_id')
    .eq('campaign_id', id)
  if (linkedErr) return NextResponse.json({ error: linkedErr.message }, { status: 500 })

  if (linked && linked.length > 0) {
    const { error: urlErr } = await supabase
      .from('cards')
      .update({ adpiler_preview_url: null })
      .in('id', linked.map(r => r.card_id))
    if (urlErr) return NextResponse.json({ error: urlErr.message }, { status: 500 })
  }

  const { error } = await supabase.from('adviewer_campaigns').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
