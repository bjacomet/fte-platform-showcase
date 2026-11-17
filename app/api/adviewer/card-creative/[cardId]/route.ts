import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { resetCardApproval } from '@/lib/adviewerCardEdit'

// Edit the copy on a BOARD CARD from inside the Adviewer review.
//
// The sibling route (app/api/adviewer/creative/[id]) does this for creatives
// uploaded straight into Adviewer, which live in adviewer_campaign_files. Board
// cards are different rows entirely: the copy lives on `cards`, and
// app/adviewer/c/[token] reads those columns at render — so an edit here shows on
// the client's link with no re-publish.
//
// Writer-gated, service-role (mirrors the upload + dashboard mutation routes). The
// client must never reach this: the Edit panel is behind `canEdit` on the staff
// side of the same component.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ cardId: string }> },
) {
  const denied = await requireWriter()
  if (denied) return denied

  const { cardId } = await params
  if (!cardId) return NextResponse.json({ error: 'Missing card id' }, { status: 400 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const trimOrNull = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s.length > 0 ? s : null
  }

  const admin = createAdminClient()

  // Refuse archived cards. An archived card is pulled work, hidden from every
  // client-facing surface; editing one would be invisible and would still reset
  // approval, which is worse than doing nothing.
  const { data: card, error: readErr } = await admin
    .from('cards')
    .select('id, archived')
    .eq('id', cardId)
    .single()
  if (readErr || !card) {
    return NextResponse.json({ error: readErr?.message ?? 'Card not found' }, { status: 404 })
  }
  if (card.archived) {
    return NextResponse.json({ error: 'That card is archived and cannot be edited' }, { status: 409 })
  }

  // fb_page_name is deliberately NOT editable here. It is derived from the
  // location's advertiser_name (supabase/add_atlas_advertiser_name.sql) and a
  // per-card override would silently diverge from every other card for that
  // practice. Change it on the location instead.
  const { error: writeErr } = await admin
    .from('cards')
    .update({
      fb_body_text: trimOrNull(body.fb_body_text),
      fb_headline: trimOrNull(body.fb_headline),
      fb_subheadline: trimOrNull(body.fb_subheadline),
      fb_cta: trimOrNull(body.fb_cta),
      updated_at: new Date().toISOString(),
    })
    .eq('id', cardId)

  if (writeErr) return NextResponse.json({ error: writeErr.message }, { status: 500 })

  // The client signed off on different words — send it back for re-review.
  let reset
  try {
    reset = await resetCardApproval(admin, cardId)
  } catch (e) {
    // The copy IS saved at this point. Say so rather than implying a clean failure.
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: `Copy saved, but resetting approval failed: ${msg}`, copySaved: true },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, ...reset })
}
