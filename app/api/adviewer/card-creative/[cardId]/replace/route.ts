import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { resetCardApproval } from '@/lib/adviewerCardEdit'
import { snapshotCardFileRound } from '@/lib/adviewerHistory'

const ALLOWED_TYPES = ['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime']
const ALLOWED_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov']
const MAX_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB — see reference_upload_size_limits
const BUCKET = 'creative-files'

/**
 * card_files.file_url stores an in-bucket PATH, not a URL (see the Box sync apply
 * route, which writes `cards/<id>/box_sync_...`). Older rows may hold a full public
 * URL, so accept both and return null for anything external — a build link or an
 * off-bucket URL must never be handed to storage.remove().
 */
function bucketPath(fileUrl: string): string | null {
  if (!fileUrl) return null
  const marker = `/${BUCKET}/`
  const i = fileUrl.indexOf(marker)
  if (i !== -1) return fileUrl.slice(i + marker.length)
  if (/^https?:\/\//i.test(fileUrl)) return null   // external — leave it alone
  return fileUrl                                    // already a bare in-bucket path
}

// Swap the graphic on a BOARD CARD from inside the Adviewer review.
//
// Mirrors app/api/adviewer/creative/[id]/replace (uploaded creatives) but writes
// card_files, and mirrors the Box sync's apply route for the storage path
// convention and the round snapshot. Writer-gated, service-role.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ cardId: string }> },
) {
  const denied = await requireWriter()
  if (denied) return denied

  const { cardId } = await params
  if (!cardId) return NextResponse.json({ error: 'Missing card id' }, { status: 400 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'Missing file' }, { status: 400 })

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_TYPES.includes(file.type) || !ALLOWED_EXTS.includes(ext)) {
    return NextResponse.json({ error: 'File type not allowed' }, { status: 400 })
  }
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: 'File exceeds 50 MB limit' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: card, error: cardErr } = await admin
    .from('cards')
    .select('id, archived')
    .eq('id', cardId)
    .single()
  if (cardErr || !card) {
    return NextResponse.json({ error: cardErr?.message ?? 'Card not found' }, { status: 404 })
  }
  if (card.archived) {
    return NextResponse.json({ error: 'That card is archived and cannot be edited' }, { status: 409 })
  }

  const { data: existingRaw, error: filesErr } = await admin
    .from('card_files')
    .select('id, file_name, file_url, dimensions')
    .eq('card_id', cardId)
  if (filesErr) return NextResponse.json({ error: filesErr.message }, { status: 500 })

  type CardFile = { id: string; file_name: string; file_url: string; dimensions: string | null }
  const existing = (existingRaw ?? []) as CardFile[]

  // Upload FIRST. If this fails nothing has been destroyed and the card is untouched.
  const newPath = `cards/${cardId}/adviewer_edit_${Date.now()}_${file.name}`
  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(newPath, file, { contentType: file.type, upsert: false })
  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 })

  // Freeze any Adviewer round anchored to the outgoing files before the rows go,
  // so the client's prior review stays readable in history. Best-effort, exactly as
  // the Box sync treats it — never block the swap on it.
  for (const f of existing) {
    try {
      await snapshotCardFileRound(admin, {
        cardId,
        fileId: f.id,
        fileName: f.file_name,
        dimensions: f.dimensions,
        thumbUrl: null,
      })
    } catch { /* best-effort */ }
  }

  if (existing.length > 0) {
    const { error: delErr } = await admin.from('card_files').delete().in('id', existing.map((f) => f.id))
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })
  }

  const { error: insertErr } = await admin.from('card_files').insert({
    card_id: cardId,
    file_name: file.name,
    file_url: newPath,
    file_type: file.type,
    approval_status: 'pending',
  })
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 })

  // Only now that the row points at the new file, hard-delete the old blobs.
  // Storage is capped on the free plan, so leaving these would accumulate.
  // Best-effort: an orphaned blob costs space, a failed request costs the edit.
  const stalePaths = existing.map((f) => bucketPath(f.file_url)).filter((p): p is string => !!p)
  if (stalePaths.length > 0) {
    const { error: removeErr } = await admin.storage.from(BUCKET).remove(stalePaths)
    if (removeErr) console.warn(`[adviewer/card-creative/replace] old blobs not deleted: ${removeErr.message}`)
  }

  let reset
  try {
    reset = await resetCardApproval(admin, cardId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      { error: `Graphic replaced, but resetting approval failed: ${msg}`, graphicReplaced: true },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, file_url: newPath, ...reset })
}
