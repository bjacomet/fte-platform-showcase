import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { resetCardReviewToPending } from '@/lib/adviewerReviewReset'

const SLIDE_SELECT =
  'id, card_id, position, headline, subheadline, link_description, display_link, graphic_headline, graphic_subhead, landing_page_url, image_url, adpiler_preview_url, created_at, updated_at'

// Edit a carousel slide's copy from inside the Adviewer preview (universal-controls
// gap #2 — carousel slides used to render read-only). Generalizes the creative/[id]
// copy-edit contract to operate on carousel_slides. Writer-gated; service-role so it
// bypasses the writer-only RLS on carousel_slides + adviewer_campaign_cards. A
// carousel is ONE review unit, so any slide edit resets the parent card's review to
// pending (the client re-reviews) while keeping the card/campaign/token/history.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireWriter()
  if (denied) return denied

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing slide id' }, { status: 400 })

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

  const { data: current, error: readErr } = await admin
    .from('carousel_slides')
    .select('card_id')
    .eq('id', id)
    .single()
  if (readErr || !current) {
    return NextResponse.json({ error: readErr?.message ?? 'Slide not found' }, { status: 404 })
  }

  const { data: row, error: writeErr } = await admin
    .from('carousel_slides')
    .update({
      headline: trimOrNull(body.headline),
      subheadline: trimOrNull(body.subheadline),
      display_link: trimOrNull(body.display_link),
      landing_page_url: trimOrNull(body.landing_page_url),
      graphic_headline: trimOrNull(body.graphic_headline),
      graphic_subhead: trimOrNull(body.graphic_subhead),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(SLIDE_SELECT)
    .single()
  if (writeErr) {
    return NextResponse.json({ error: writeErr.message }, { status: 500 })
  }

  const reviewReset = await resetCardReviewToPending(admin, current.card_id)

  return NextResponse.json({ slide: row, reviewReset: reviewReset > 0 })
}
