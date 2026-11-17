import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import type { AdviewerCampaignFile } from '@/types'

const FILE_SELECT =
  'id, campaign_id, file_name, file_url, position, status, client_notes, render_mode, fb_page_name, fb_body_text, fb_headline, fb_subheadline, fb_cta, landing_page_url, created_at, updated_at'

const ALLOWED_TYPES = ['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime']
const ALLOWED_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov']
const MAX_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB
const BUCKET = 'creative-files'

// Extract the in-bucket path from a public storage URL, or null if it isn't one
// of ours (external / build-link URLs are left alone — never deleted).
function bucketPath(fileUrl: string): string | null {
  const marker = `/${BUCKET}/`
  const i = fileUrl.indexOf(marker)
  return i === -1 ? null : fileUrl.slice(i + marker.length)
}

// Replace the graphic on a manually-uploaded creative (adviewer_campaign_files) in
// place — swap the file, hard-delete the old blob, and reset the review (the new
// image invalidates any prior approval, and old pins were placed on the old image).
// Writer-gated; service-role storage + DB (mirrors the upload route).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireWriter()
  if (denied) return denied

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing creative id' }, { status: 400 })

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

  const { data: current, error: readErr } = await admin
    .from('adviewer_campaign_files')
    .select('campaign_id, file_url, client_notes')
    .eq('id', id)
    .single()
  if (readErr || !current) {
    return NextResponse.json({ error: readErr?.message ?? 'Creative not found' }, { status: 404 })
  }

  const newPath = `adviewer/${current.campaign_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(newPath, file, { contentType: file.type, upsert: false })
  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 })

  const { data: { publicUrl } } = admin.storage.from(BUCKET).getPublicUrl(newPath)

  // New graphic → the whole prior review is stale: reset to pending and drop the
  // pins AND the change-request note (both referred to the old image). Keep only the
  // reviewer name for context.
  const notes = (current.client_notes ?? {}) as NonNullable<AdviewerCampaignFile['client_notes']>
  const { data: row, error: writeErr } = await admin
    .from('adviewer_campaign_files')
    .update({
      file_url: publicUrl,
      file_name: file.name,
      status: 'pending',
      client_notes: { reviewer: notes.reviewer, status: 'pending', pins: [] },
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(FILE_SELECT)
    .single()
  if (writeErr) {
    return NextResponse.json({ error: writeErr.message }, { status: 500 })
  }

  // Hard-delete the old blob now that the row points at the new file. Best-effort:
  // a failed cleanup must not fail the replace (the row is already updated), but log
  // it so orphaned blobs are noticeable in ops.
  const oldPath = bucketPath(current.file_url)
  if (oldPath && oldPath !== newPath) {
    const { error: removeErr } = await admin.storage.from(BUCKET).remove([oldPath])
    if (removeErr) console.warn(`[adviewer/creative/replace] old blob not deleted (${oldPath}): ${removeErr.message}`)
  }

  return NextResponse.json({ file: row })
}
