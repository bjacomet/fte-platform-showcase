// GET /api/videos/stream/[fileId]
//
// Proxy a Box file through our server so the browser's <video> tag can play it
// natively (and we get real currentTime / seek / duration). Streams the body;
// does NOT buffer.
//
// Box returns a 302 to a pre-signed download URL — we follow the redirect
// server-side and pipe the resulting response straight back to the client.
// Range requests are forwarded so scrubbing works.

import { NextResponse } from 'next/server'
import { getBoxToken } from '@/lib/box'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const BOX_API = 'https://api.box.com/2.0'

interface RouteParams {
  fileId: string
}

// The shared Box token can read any file in the org's Box, so this endpoint must
// never proxy an arbitrary fileId. A caller may stream a file only if it is a
// known video version they're entitled to: a logged-in staff member (any
// version), or a share-token holder whose project owns that version. Without
// this check the route is an open Box-file proxy (IDOR via file-id enumeration).
async function canStream(fileId: string, shareToken: string | null): Promise<boolean> {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    // Staff session → RLS lets authenticated read all video_versions.
    const { data } = await supabase
      .from('video_versions')
      .select('id')
      .eq('box_file_id', fileId)
      .limit(1)
    return !!data && data.length > 0
  }

  if (shareToken) {
    // Public client viewer → the SECURITY DEFINER RPC returns only that token's
    // project + its versions. Authorized iff one of them is this file.
    const { data } = await supabase.rpc('get_video_project_by_token', { p_token: shareToken })
    if (!data) return false
    const versions = (data as { versions?: Array<{ box_file_id: string | null }> }).versions ?? []
    return versions.some((v) => v.box_file_id === fileId)
  }

  return false
}

export async function GET(
  req: Request,
  { params }: { params: Promise<RouteParams> },
) {
  try {
    const { fileId } = await params
    if (!/^\d+$/.test(fileId)) {
      return NextResponse.json({ error: 'invalid file id' }, { status: 400 })
    }

    const shareToken = new URL(req.url).searchParams.get('token')
    if (!(await canStream(fileId, shareToken))) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const token = await getBoxToken()

    // Forward Range header for seeking.
    const range = req.headers.get('range')
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    }
    if (range) headers['Range'] = range

    const res = await fetch(`${BOX_API}/files/${fileId}/content`, {
      method: 'GET',
      headers,
      redirect: 'follow',
    })

    if (!res.ok && res.status !== 206) {
      return NextResponse.json(
        { error: `box fetch failed: ${res.status}` },
        { status: res.status },
      )
    }

    // Pass through the streamed body + essential headers.
    const passHeaders = new Headers()
    const copy = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']
    for (const h of copy) {
      const v = res.headers.get(h)
      if (v) passHeaders.set(h, v)
    }
    if (!passHeaders.has('accept-ranges')) passHeaders.set('accept-ranges', 'bytes')

    return new NextResponse(res.body, {
      status: res.status,
      headers: passHeaders,
    })
  } catch (err) {
    console.error('video stream error', err)
    return NextResponse.json({ error: 'stream failed' }, { status: 500 })
  }
}
