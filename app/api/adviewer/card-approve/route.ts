import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import type { CampaignCardReview } from '@/types'
import { rollUpCampaignFromScopes } from '@/lib/adviewerReviewToken'

// Manual "AM approve" for a board card whose client signed off OUTSIDE the Adviewer
// platform (e.g. by email). Marks the card approved in every OPEN campaign it
// belongs to, resolves any open client pins on it, clears the board "Changes" flag
// (cards.approval_status = 'approved'), and — when a campaign's board cards are ALL
// approved — sends that campaign to the Lookbook (status 'approved' + archived).
//
// Writer-gated + service-role: adviewer_* writes are staff-tier RLS (public.is_writer),
// so routing through the service role is what makes a non-admin staffer's action
// actually stick instead of being silently dropped — same pattern as campaign/[id].
//
// Rollup counts BOARD CARDS ONLY: a mixed campaign's direct file uploads
// (adviewer_campaign_files) are intentionally not counted toward completion. When a
// completing approval still has unapproved uploaded files, the confirm payload
// carries an `unapprovedFiles` count per campaign so the UI can warn the AM.
//
// The approve writes + completeness check + archive run in ONE transaction inside
// the `adviewer_am_approve` Postgres function, which takes SELECT ... FOR UPDATE on
// the target campaigns. That serializes two AMs approving the last cards of the same
// campaign at once — otherwise each could read the other as still pending and neither
// would archive, leaving the campaign fully approved but stuck out of the Lookbook.
// The reads below only decide whether to show the confirm prompt.

interface LinkRow {
  id: string
  campaign_id: string
  status: string
  client_notes: CampaignCardReview | null
}

// Every pin id on a card link — card-level pins + per-size file_pins.
function allPinIds(notes: CampaignCardReview | null): string[] {
  if (!notes) return []
  const ids = (notes.pins ?? []).map((p) => p.id)
  for (const arr of Object.values(notes.file_pins ?? {})) {
    for (const p of arr ?? []) ids.push(p.id)
  }
  return ids
}

export async function POST(req: NextRequest) {
  const denied = await requireWriter()
  if (denied) return denied

  let body: { cardId?: string; confirm?: boolean }
  try {
    body = (await req.json()) as { cardId?: string; confirm?: boolean }
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const { cardId, confirm } = body
  if (!cardId) return NextResponse.json({ error: 'Missing cardId' }, { status: 400 })

  const supabase = createAdminClient()

  // 1. Every campaign membership for this card.
  const { data: links, error: linksErr } = await supabase
    .from('adviewer_campaign_cards')
    .select('id, campaign_id, status, client_notes')
    .eq('card_id', cardId)
  if (linksErr) return NextResponse.json({ error: linksErr.message }, { status: 500 })
  if (!links || links.length === 0) {
    return NextResponse.json({ error: 'Card is not in any campaign' }, { status: 404 })
  }
  const cardLinks = links as unknown as LinkRow[]
  const allCampaignIds = [...new Set(cardLinks.map((l) => l.campaign_id))]

  // 2. Drop campaigns already in the Lookbook (archived) — nothing to do there.
  //
  // EXCEPT an archived campaign sitting at `needs_revision`. Approval is not
  // terminal once per-location review links exist: a campaign gets filed into the
  // Lookbook (by staff), and a location can still come back
  // days later asking for a change — which flips the ARCHIVED campaign to
  // needs_revision. Treating that as "archived, nothing to do" returned a flat
  // 404 and left the AM with no way to re-approve the revised creative short of
  // un-archiving the campaign by hand in SQL. `needs_revision` on an archived
  // campaign is precisely the signal that it was re-opened, so it is re-openable
  // here too.
  //
  // NOTE on adviewer_am_approve, because the obvious assumption is wrong: it ends
  // with `… where id = v_cid and archived = false`, so against a STILL-archived
  // campaign its final UPDATE matches zero rows and silently does nothing. Re-
  // opening therefore depends on the campaign having been un-archived already —
  // which rollUpCampaignFromScopes does the moment a location asks for a change.
  // The invariant the whole path rests on is "a campaign at needs_revision is
  // never archived". See lib/adviewerReviewToken.ts.
  const { data: campaignRows, error: campReadErr } = await supabase
    .from('adviewer_campaigns')
    .select('id, title, archived, status')
    .in('id', allCampaignIds)
  if (campReadErr) return NextResponse.json({ error: campReadErr.message }, { status: 500 })

  const openCampaignIds = new Set(
    (campaignRows ?? []).filter((c) => !c.archived || c.status === 'needs_revision').map((c) => c.id),
  )
  const openLinks = cardLinks.filter((l) => openCampaignIds.has(l.campaign_id))
  if (openLinks.length === 0) {
    return NextResponse.json({ error: 'Card is only in archived campaigns' }, { status: 404 })
  }
  const campaignIds = [...openCampaignIds]

  // 3. Pre-write estimate for the confirm prompt only: which open campaigns WOULD
  //    complete once this card's links flip to approved? Board cards only.
  const { data: siblingRows, error: sibErr } = await supabase
    .from('adviewer_campaign_cards')
    .select('id, campaign_id, status, card:cards(archived)')
    .in('campaign_id', campaignIds)
  if (sibErr) return NextResponse.json({ error: sibErr.message }, { status: 500 })

  // An archived board card is pulled work: it is hidden from the client review and
  // can never be approved there, so counting it made "all approved" unreachable and
  // the campaign could never roll up to the Lookbook. Exclude it from the count on
  // both sides — this pre-check and adviewer_am_approve (supabase/fix_am_approve_
  // ignores_archived_cards.sql), which must agree or the confirm prompt lies.
  const liveSiblings = (siblingRows ?? []).filter(
    (r) => (r.card as unknown as { archived?: boolean | null } | null)?.archived !== true
  )

  const thisCardLinkIds = new Set(openLinks.map((l) => l.id))
  const wouldComplete: string[] = []
  for (const cid of campaignIds) {
    const rows = liveSiblings.filter((r) => r.campaign_id === cid)
    const complete =
      rows.length > 0 && rows.every((r) => r.status === 'approved' || thisCardLinkIds.has(r.id))
    if (complete) wouldComplete.push(cid)
  }

  // 4. Confirm gate: if this would send a campaign to the Lookbook and the caller
  //    hasn't confirmed, ask first and write nothing. Flag any campaign that still
  //    has unapproved uploaded files (not counted toward completion).
  if (wouldComplete.length > 0 && confirm !== true) {
    const { data: fileRows } = await supabase
      .from('adviewer_campaign_files')
      .select('campaign_id, status')
      .in('campaign_id', wouldComplete)
    const unapprovedByCampaign = new Map<string, number>()
    for (const f of fileRows ?? []) {
      if (f.status !== 'approved') {
        unapprovedByCampaign.set(f.campaign_id, (unapprovedByCampaign.get(f.campaign_id) ?? 0) + 1)
      }
    }
    const campaignsToArchive = (campaignRows ?? [])
      .filter((c) => wouldComplete.includes(c.id))
      .map((c) => ({ id: c.id, title: c.title, unapprovedFiles: unapprovedByCampaign.get(c.id) ?? 0 }))
    return NextResponse.json({ needsConfirm: true, campaignsToArchive })
  }

  // 5. Pre-compute resolved client_notes (pins marked resolved) for links that
  //    carry notes; passed into the transaction so the JSON logic stays in TS.
  const notesMap: Record<string, CampaignCardReview> = {}
  for (const link of openLinks) {
    if (link.client_notes) {
      notesMap[link.id] = {
        ...link.client_notes,
        resolved_pins: [...new Set([...(link.client_notes.resolved_pins ?? []), ...allPinIds(link.client_notes)])],
      }
    }
  }

  // 6. Atomic mutation: approve links + card, then roll up any campaign now fully
  //    approved — all under a row lock on the campaigns (see adviewer_am_approve).
  const { data: archived, error: rpcErr } = await supabase.rpc('adviewer_am_approve', {
    p_card_id: cardId,
    p_link_ids: openLinks.map((l) => l.id),
    p_notes: notesMap,
    p_campaign_ids: campaignIds,
  })
  if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 })

  let archivedIds = (archived ?? []) as string[]

  // Scopes are the authority for a campaign that has them.
  //
  // The RPC files a campaign the moment its last CARD is approved — the right
  // rule when one client reviews the whole campaign, the wrong one when 22
  // locations each review a slice. An AM approving the last card of location 3
  // would otherwise archive the campaign out from under the other locations that
  // have not looked yet, and the Lookbook would gain a campaign still mid-review.
  //
  // So for any campaign the RPC just archived that HAS scopes, re-derive from the
  // scopes, and drop it from archivedIds if it did not survive — otherwise the
  // auto-file below would file a campaign we just un-archived. `correcting` is
  // what stops the mixed case being a no-op, which would leave the archive standing.
  if (archivedIds.length > 0) {
    const { data: scopedRows } = await supabase
      .from('adviewer_campaign_scopes')
      .select('campaign_id')
      .in('campaign_id', archivedIds)
    const scoped = new Set((scopedRows ?? []).map((r) => r.campaign_id as string))
    if (scoped.size > 0) {
      const survived: string[] = []
      for (const cid of archivedIds) {
        if (!scoped.has(cid)) { survived.push(cid); continue }
        const rolled = await rollUpCampaignFromScopes(supabase, cid, { correcting: true })
        if (rolled === 'approved') survived.push(cid)
      }
      archivedIds = survived
    }
  }

  // Best-effort auto-file into the Lookbook folder tree. The campaign is already
  // archived, so a failure here must not fail the approve. The RPC is a no-op if
  // it was manually filed.
  //
  // Correcting what this comment used to claim: there is NO later-load fallback,
  // and the backfill in add_lookbook_folders.sql is one-shot — it ran once in
  // August. So a failure here leaves the campaign unfiled indefinitely, showing
  // as a loose tile in the Lookbook root until someone moves it by hand. Logged
  // below for that reason; it is the only trace there will be.
  for (const cid of archivedIds) {
    const { error: fileErr } = await supabase.rpc('adviewer_ensure_lookbook_path', { p_campaign_id: cid })
    if (fileErr) console.error('[card-approve] auto-file failed for campaign', cid, fileErr.message)
  }

  return NextResponse.json({
    ok: true,
    approvedCard: cardId,
    archivedCampaignIds: archivedIds,
  })
}
