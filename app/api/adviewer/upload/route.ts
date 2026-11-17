import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/writers'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isStaffUser())) return NextResponse.json({ error: 'Forbidden — staff access only' }, { status: 403 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const campaignId = formData.get('campaign_id') as string | null
  const position = parseInt(formData.get('position') as string ?? '0', 10)

  // Optional "social" render mode + Facebook copy — when render_mode is 'social'
  // the campaign preview renders this file inside the FB feed mockup instead of
  // the raw display frame. All copy fields are optional.
  const renderMode = (formData.get('render_mode') as string) === 'social' ? 'social' : 'display'
  const trimOrNull = (v: FormDataEntryValue | null) => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s.length > 0 ? s : null
  }
  const fbPageName = trimOrNull(formData.get('fb_page_name'))
  const fbBodyText = trimOrNull(formData.get('fb_body_text'))
  const fbHeadline = trimOrNull(formData.get('fb_headline'))
  const fbSubheadline = trimOrNull(formData.get('fb_subheadline'))
  const fbCta = trimOrNull(formData.get('fb_cta'))
  const landingPageUrl = trimOrNull(formData.get('landing_page_url'))

  if (!file || !campaignId) {
    return NextResponse.json({ error: 'Missing file or campaign_id' }, { status: 400 })
  }

  // Server-side validation — don't trust client-provided MIME type
  const ALLOWED_TYPES = ['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime']
  const ALLOWED_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov']
  const MAX_SIZE_BYTES = 50 * 1024 * 1024 // 50 MB

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_TYPES.includes(file.type) || !ALLOWED_EXTS.includes(ext)) {
    return NextResponse.json({ error: 'File type not allowed' }, { status: 400 })
  }
  if (file.size > MAX_SIZE_BYTES) {
    return NextResponse.json({ error: 'File exceeds 50 MB limit' }, { status: 400 })
  }
  const fileName = `${campaignId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

  const adminClient = createAdminClient()
  const { error: uploadError } = await adminClient.storage
    .from('creative-files')
    .upload(`adviewer/${fileName}`, file, { contentType: file.type, upsert: false })

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 })
  }

  const { data: { publicUrl } } = adminClient.storage
    .from('creative-files')
    .getPublicUrl(`adviewer/${fileName}`)

  const { data: row, error: insertError } = await adminClient
    .from('adviewer_campaign_files')
    .insert({
      campaign_id: campaignId,
      file_name: file.name,
      file_url: publicUrl,
      position,
      status: 'pending',
      render_mode: renderMode,
      fb_page_name: fbPageName,
      fb_body_text: fbBodyText,
      fb_headline: fbHeadline,
      fb_subheadline: fbSubheadline,
      fb_cta: fbCta,
      landing_page_url: landingPageUrl,
    })
    .select('id, campaign_id, file_name, file_url, position, status, client_notes, render_mode, fb_page_name, fb_body_text, fb_headline, fb_subheadline, fb_cta, landing_page_url, created_at, updated_at')
    .single()

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json(row)
}
