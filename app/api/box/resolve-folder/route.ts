import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBoxToken, parseFolderUrl } from '@/lib/box'

const BOX_API = 'https://api.box.com/2.0'

/**
 * POST — resolve a Box shared link (the card's build_link) to the numeric Build
 * folder id and store it on cards.box_folder_id, so the Box file-sync webhook
 * (/api/box/webhook) can match FILE.UPLOADED events for this card. Best-effort:
 * callers should not fail the card save if this errors (Box may be disconnected).
 *
 * Body: { sharedLink: string, cardId: string }
 * Returns: { folderId } on success.
 */
export async function POST(req: NextRequest) {
  let body: { sharedLink?: string; cardId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sharedLink = body.sharedLink?.trim()
  const cardId = body.cardId?.trim()
  if (!sharedLink || !cardId) {
    return NextResponse.json({ error: 'Missing sharedLink or cardId' }, { status: 400 })
  }

  // Staff-only: the middleware exempts /api/*, and this route resolves a caller-
  // supplied Box shared link with the shared Box token. Guard before any Box call.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Direct folder URLs (box.com/folder/<numeric>) can be parsed without a Box call.
  let folderId = parseFolderUrl(sharedLink)

  if (!folderId) {
    let token: string
    try {
      token = await getBoxToken()
    } catch {
      return NextResponse.json({ error: 'Box not connected' }, { status: 503 })
    }

    const itemRes = await fetch(`${BOX_API}/shared_items?fields=id,type,parent`, {
      headers: {
        Authorization: `Bearer ${token}`,
        BoxApi: `shared_link=${sharedLink}`,
      },
    })
    if (!itemRes.ok) {
      return NextResponse.json(
        { error: `Could not resolve Box shared link: ${itemRes.status}` },
        { status: 502 }
      )
    }
    const item = await itemRes.json() as { id: string; type: string; parent?: { id: string } | null }
    // A build link may point at the Build folder itself or a file inside it; the webhook
    // matches on the parent folder id, so resolve files up to their containing folder.
    folderId = item.type === 'folder' ? item.id : item.parent?.id ?? null
  }

  if (!folderId) {
    return NextResponse.json({ error: 'Shared link did not resolve to a folder' }, { status: 422 })
  }

  const { error } = await supabase.from('cards').update({ box_folder_id: folderId }).eq('id', cardId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ folderId })
}
