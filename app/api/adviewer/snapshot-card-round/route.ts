import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { snapshotCardPinRound } from '@/lib/adviewerHistory'

interface SnapshotBody {
  cardId: string
  // carousel_slides.id for a slide-graphic replacement; null for a single-social
  // card whose preview_image_url is being replaced.
  slideId: string | null
  label: string
  thumbUrl: string | null
}

// Freezes the Adviewer round anchored to a carousel slide (or to a single-social
// card's graphic) into client_notes.history before that graphic is replaced.
// Designer-side sibling of /api/adviewer/snapshot-round — same trust model.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: SnapshotBody
  try {
    body = await req.json() as SnapshotBody
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { cardId, slideId, label, thumbUrl } = body
  if (!cardId || !label) {
    return NextResponse.json({ error: 'Missing cardId or label' }, { status: 400 })
  }

  try {
    await snapshotCardPinRound(supabase, {
      cardId,
      slideId: slideId ?? null,
      label,
      thumbUrl: thumbUrl ?? null,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Snapshot failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
