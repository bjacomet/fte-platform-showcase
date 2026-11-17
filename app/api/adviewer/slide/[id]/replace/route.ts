import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { resetCardReviewToPending } from '@/lib/adviewerReviewReset'
import { snapshotCardPinRound } from '@/lib/adviewerHistory'

const SLIDE_SELECT =
  'id, card_id, position, headline, subheadline, link_description, display_link, graphic_headline, graphic_subhead, landing_page_url, image_url, adpiler_preview_url, created_at, updated_at'

// Carousel slides are image-only (video belongs on an Instant Experience card).
const ALLOWED_TYPES = ['image/gif', 'image/png', 'image/jpeg', 'image/webp']
const ALLOWED_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp']
const MAX_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB
const BUCKET = 'creative-files'

function bucketPath(fileUrl: string): string | null {
  // Signed URLs (…/object/sign/creative-files/<path>?token=) and public URLs
  // (…/object/public/creative-files/<path>) both carry the in-bucket path after
  // the bucket marker. Strip any query string.
  const marker = `/${BUCKET}/`
  const i = fileUrl.indexOf(marker)
  if (i === -1) return null
  return fileUrl.slice(i + marker.length).split('?')[0]
}

// Replace a carousel slide's graphic from inside the Adviewer preview (gap #2).
// Generalizes the creative/[id]/replace contract to carousel_slides: upload the new
// image, snapshot the slide's pins into history (auto-resolved — a new graphic
// supersedes the round), swap image_url, reset the parent card's review to pending,
// then hard-delete the old blob. Writer-gated; service-role storage + DB.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireWriter()
  if (denied) return denied

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing slide id' }, { status: 400 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'Missing file' }, { status: 400 })

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_TYPES.includes(file.type) || !ALLOWED_EXTS.includes(ext)) {
    return NextResponse.json({ error: 'Carousel slides are images only (gif/png/jpg/webp). For video, use an Instant Experience card.' }, { status: 400 })
  }
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: 'File exceeds 50 MB limit' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: current, error: readErr } = await admin
    .from('carousel_slides')
    .select('card_id, position, image_url')
    .eq('id', id)
    .single()
  if (readErr || !current) {
    return NextResponse.json({ error: readErr?.message ?? 'Slide not found' }, { status: 404 })
  }

  const path = `cards/${current.card_id}/slides/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 })

  const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(path, 3600 * 24 * 365)
  const newUrl = signed?.signedUrl ?? admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl

  // Freeze the slide's pins before the graphic changes (best-effort — never blocks
  // the replace). The old image URL doubles as the retained thumbnail.
  if (current.image_url) {
    try {
      await snapshotCardPinRound(admin, {
        cardId: current.card_id,
        slideId: id,
        label: `Slide ${current.position + 1}`,
        thumbUrl: current.image_url,
      })
    } catch (e) {
      console.warn(`[adviewer/slide/replace] pin snapshot failed for slide ${id}: ${(e as Error).message}`)
    }
  }

  const { data: row, error: writeErr } = await admin
    .from('carousel_slides')
    .update({ image_url: newUrl, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(SLIDE_SELECT)
    .single()
  if (writeErr) {
    return NextResponse.json({ error: writeErr.message }, { status: 500 })
  }

  const reviewReset = await resetCardReviewToPending(admin, current.card_id)

  // Hard-delete the old blob now that the row points at the new file (best-effort).
  const oldPath = current.image_url ? bucketPath(current.image_url) : null
  if (oldPath && oldPath !== path) {
    const { error: removeErr } = await admin.storage.from(BUCKET).remove([oldPath])
    if (removeErr) console.warn(`[adviewer/slide/replace] old blob not deleted (${oldPath}): ${removeErr.message}`)
  }

  return NextResponse.json({ slide: row, reviewReset: reviewReset > 0 })
}
