import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'

// Mint a signed upload URL for a creative going into an EXISTING campaign. The client
// then uploads the file straight to Supabase storage (bypassing this serverless
// function's ~4.5MB request-body limit — which is why pushing a video through
// /api/adviewer/upload fails). After the upload, the client calls
// /api/adviewer/campaign-file to record the row. Staff-gated (any authenticated
// non-client account, via requireWriter()); the signed URL is minted with the
// service role so bucket RLS doesn't block staff uploads.

const ALLOWED_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp', 'mp4', 'mov']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(req: NextRequest) {
  const denied = await requireWriter()
  if (denied) return denied

  let body: { campaign_id?: string; file_name?: string }
  try {
    body = (await req.json()) as { campaign_id?: string; file_name?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }
  const { campaign_id: campaignId, file_name: fileName } = body
  if (!campaignId || !fileName) {
    return NextResponse.json({ error: 'Missing campaign_id or file_name' }, { status: 400 })
  }

  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_EXTS.includes(ext)) {
    return NextResponse.json({ error: 'File type not allowed' }, { status: 400 })
  }

  // campaignId lands directly in the storage path — reject anything that isn't a real
  // campaign UUID so a `../box-sync/…` value can't traverse into other bucket prefixes.
  if (!UUID_RE.test(campaignId)) {
    return NextResponse.json({ error: 'Invalid campaign_id' }, { status: 400 })
  }
  const admin = createAdminClient()
  const { data: campaign } = await admin.from('adviewer_campaigns').select('id').eq('id', campaignId).maybeSingle()
  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  const path = `adviewer/${campaignId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  const { data, error } = await admin.storage.from('creative-files').createSignedUploadUrl(path)
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Could not create upload URL' }, { status: 500 })
  }
  const { data: { publicUrl } } = admin.storage.from('creative-files').getPublicUrl(path)
  return NextResponse.json({ path: data.path, token: data.token, publicUrl })
}
