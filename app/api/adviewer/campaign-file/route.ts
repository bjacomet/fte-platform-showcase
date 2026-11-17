import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'

// Record a creative that was just uploaded DIRECTLY to storage (see
// /api/adviewer/upload/sign) against an existing campaign. JSON only — no file — so
// the request body is tiny regardless of the creative's size. Staff-gated (any
// authenticated non-client account, via requireWriter()); the row is inserted with
// the service role. Appends at the end of the campaign's files.

interface Body {
  campaign_id?: string
  file_name?: string
  file_url?: string
  render_mode?: string
  fb_page_name?: string
  fb_body_text?: string
  fb_headline?: string
  fb_subheadline?: string
  fb_cta?: string
  landing_page_url?: string
}

const trimOrNull = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length > 0 ? s : null
}

export async function POST(req: NextRequest) {
  const denied = await requireWriter()
  if (denied) return denied

  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const { campaign_id: campaignId, file_name: fileName, file_url: fileUrl } = body
  if (!campaignId || !fileName || !fileUrl) {
    return NextResponse.json({ error: 'Missing campaign_id, file_name or file_url' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Append after the campaign's existing files.
  const { data: last } = await admin
    .from('adviewer_campaign_files')
    .select('position')
    .eq('campaign_id', campaignId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle()
  const position = ((last?.position as number | undefined) ?? -1) + 1

  const renderMode = body.render_mode === 'social' ? 'social' : 'display'

  const { data: row, error: insertError } = await admin
    .from('adviewer_campaign_files')
    .insert({
      campaign_id: campaignId,
      file_name: fileName,
      file_url: fileUrl,
      position,
      status: 'pending',
      render_mode: renderMode,
      fb_page_name: trimOrNull(body.fb_page_name),
      fb_body_text: trimOrNull(body.fb_body_text),
      fb_headline: trimOrNull(body.fb_headline),
      fb_subheadline: trimOrNull(body.fb_subheadline),
      fb_cta: trimOrNull(body.fb_cta),
      landing_page_url: trimOrNull(body.landing_page_url),
    })
    .select('id, campaign_id, file_name, file_url, position, status, client_notes, render_mode, fb_page_name, fb_body_text, fb_headline, fb_subheadline, fb_cta, landing_page_url, created_at, updated_at')
    .single()

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }
  return NextResponse.json(row)
}
