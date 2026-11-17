import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import type { AdviewerCampaignFile, AdviewerStatus } from '@/types'

const FILE_SELECT =
  'id, campaign_id, file_name, file_url, position, status, client_notes, render_mode, fb_page_name, fb_body_text, fb_headline, fb_subheadline, fb_cta, landing_page_url, created_at, updated_at'

// Edit the copy on a manually-uploaded creative (adviewer_campaign_files row) after
// the campaign already exists — previously the only way to change copy was to delete
// the campaign and rebuild it. Writer-gated; runs via the service-role client so it
// bypasses RLS (mirrors the upload + dashboard mutation routes).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireWriter()
  if (denied) return denied

  const { id } = await params
  if (!id) return NextResponse.json({ error: 'Missing creative id' }, { status: 400 })

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
    .from('adviewer_campaign_files')
    .select('status, client_notes')
    .eq('id', id)
    .single()

  if (readErr || !current) {
    return NextResponse.json({ error: readErr?.message ?? 'Creative not found' }, { status: 404 })
  }

  const update: {
    fb_page_name: string | null
    fb_body_text: string | null
    fb_headline: string | null
    fb_subheadline: string | null
    fb_cta: string | null
    landing_page_url: string | null
    updated_at: string
    status?: AdviewerStatus
    client_notes?: AdviewerCampaignFile['client_notes']
  } = {
    fb_page_name: trimOrNull(body.fb_page_name),
    fb_body_text: trimOrNull(body.fb_body_text),
    fb_headline: trimOrNull(body.fb_headline),
    fb_subheadline: trimOrNull(body.fb_subheadline),
    fb_cta: trimOrNull(body.fb_cta),
    landing_page_url: trimOrNull(body.landing_page_url),
    updated_at: new Date().toISOString(),
  }

  // If the client already reviewed this creative, changing its copy makes that
  // approval/change-request stale — flip it back to pending so they re-review the
  // new copy. Pins/reviewer are preserved: they annotate the image, not the copy.
  const wasReviewed = (current.status as AdviewerStatus) !== 'pending'
  if (wasReviewed) {
    update.status = 'pending'
    const notes = (current.client_notes ?? {}) as NonNullable<AdviewerCampaignFile['client_notes']>
    update.client_notes = { ...notes, status: 'pending' }
  }

  const { data: row, error: writeErr } = await admin
    .from('adviewer_campaign_files')
    .update(update)
    .eq('id', id)
    .select(FILE_SELECT)
    .single()

  if (writeErr) {
    return NextResponse.json({ error: writeErr.message }, { status: 500 })
  }

  return NextResponse.json({ file: row, reviewReset: wasReviewed })
}
