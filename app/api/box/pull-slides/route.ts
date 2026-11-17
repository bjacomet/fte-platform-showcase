import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBoxToken, parseFolderUrl } from '@/lib/box'

const BOX_API = 'https://api.box.com/2.0'

const IMAGE_MIME: Record<string, string> = {
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

interface BoxItem {
  id: string
  name: string
  type: 'file' | 'folder'
}

async function listImages(
  folderId: string,
  token: string,
  sharedLink: string,
): Promise<{ id: string; name: string }[]> {
  const res = await fetch(`${BOX_API}/folders/${folderId}/items?limit=1000&fields=id,name,type`, {
    headers: { Authorization: `Bearer ${token}`, BoxApi: `shared_link=${sharedLink}` },
  })
  if (!res.ok) throw new Error(`Box folder list failed: ${res.status}`)
  const json = await res.json() as { entries: BoxItem[] }
  const images: { id: string; name: string }[] = []
  for (const item of json.entries) {
    if (item.type === 'file') {
      const ext = item.name.split('.').pop()?.toLowerCase() ?? ''
      if (IMAGE_MIME[ext]) images.push({ id: item.id, name: item.name })
    } else if (item.type === 'folder') {
      images.push(...await listImages(item.id, token, sharedLink))
    }
  }
  return images
}

/**
 * POST — import a carousel card's graphics from its Box Build folder onto its slides.
 *
 * Resolves the card's build_link (shared link) to the Build folder, lists the images,
 * matches each to a slide by the trailing "_NN" in the filename (…_03.png → slide 3,
 * position 2, 0-based), downloads it, uploads to Supabase Storage, and sets that slide's
 * image_url — creating slides as needed. Also stores box_folder_id (so the file-sync
 * webhook can match this card) and sets the first slide's image as the board cover.
 *
 * Body: { cardId: string }
 * Returns: { imported: number, folderId } on success.
 */
export async function POST(req: NextRequest) {
  let body: { cardId?: string; sharedLink?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const cardId = body.cardId?.trim()
  if (!cardId) {
    return NextResponse.json({ error: 'Missing cardId' }, { status: 400 })
  }

  const supabase = await createClient()

  // Staff-only: the middleware exempts /api/*, and this route drives the shared
  // Box token off a caller-supplied card. Guard explicitly rather than relying on
  // RLS silently returning no card.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: card } = await supabase
    .from('cards')
    .select('id, build_link')
    .eq('id', cardId)
    .maybeSingle()

  if (!card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }
  // Prefer an explicit link from the caller (e.g. a re-pull with an unsaved edit) over the
  // stored build_link.
  const sharedLink = (body.sharedLink ?? card.build_link ?? '').trim()
  if (!sharedLink) {
    return NextResponse.json({ error: 'Card has no build link' }, { status: 422 })
  }

  let token: string
  try {
    token = await getBoxToken()
  } catch {
    return NextResponse.json({ error: 'Box not connected' }, { status: 503 })
  }

  // Resolve the build link to the numeric Build folder id.
  let folderId = parseFolderUrl(sharedLink)
  if (!folderId) {
    const itemRes = await fetch(`${BOX_API}/shared_items?fields=id,type,parent`, {
      headers: { Authorization: `Bearer ${token}`, BoxApi: `shared_link=${sharedLink}` },
    })
    if (!itemRes.ok) {
      return NextResponse.json({ error: `Could not resolve Box shared link: ${itemRes.status}` }, { status: 502 })
    }
    const item = await itemRes.json() as { id: string; type: string; parent?: { id: string } | null }
    folderId = item.type === 'folder' ? item.id : item.parent?.id ?? null
  }
  if (!folderId) {
    return NextResponse.json({ error: 'Shared link did not resolve to a folder' }, { status: 422 })
  }

  // Store box_folder_id so the file-sync webhook can match this card on future uploads.
  await supabase.from('cards').update({ box_folder_id: folderId }).eq('id', cardId)

  // List images and match each to a slot by its trailing _NN.
  let images: { id: string; name: string }[]
  try {
    images = await listImages(folderId, token, sharedLink)
  } catch {
    return NextResponse.json({ error: 'Failed to list Build folder contents' }, { status: 502 })
  }

  const matched = images
    .map((img) => {
      const m = img.name.match(/_(\d+)\.[^.]+$/)
      return m ? { ...img, slot: parseInt(m[1], 10) - 1 } : null
    })
    .filter((x): x is { id: string; name: string; slot: number } => x !== null)

  if (matched.length === 0) {
    return NextResponse.json({ imported: 0, folderId, note: 'No files with a trailing _NN found' })
  }

  // Existing slides for this card, and the slots we need to cover.
  const { data: existing } = await supabase
    .from('carousel_slides')
    .select('id, position')
    .eq('card_id', cardId)
    .order('position', { ascending: true })

  const slideIdByPosition = new Map<number, string>(
    (existing ?? []).map((s: { id: string; position: number }) => [s.position, s.id]),
  )
  const maxSlot = Math.max(...matched.map((m) => m.slot), (existing ?? []).length - 1)

  // Create any missing slide rows up to the highest slot so positions stay contiguous.
  const nowIso = new Date().toISOString()
  const toCreate: { position: number }[] = []
  for (let k = 0; k <= maxSlot; k++) {
    if (!slideIdByPosition.has(k)) toCreate.push({ position: k })
  }
  if (toCreate.length > 0) {
    const { data: created } = await supabase
      .from('carousel_slides')
      .insert(toCreate.map((c) => ({ card_id: cardId, position: c.position, created_at: nowIso, updated_at: nowIso })))
      .select('id, position')
    for (const s of (created ?? []) as { id: string; position: number }[]) {
      slideIdByPosition.set(s.position, s.id)
    }
  }

  // Download each matched image, upload to Storage, set the slide's image_url.
  let imported = 0
  let coverUrl: string | null = null
  const sortedMatches = [...matched].sort((a, b) => a.slot - b.slot)
  for (const img of sortedMatches) {
    const slideId = slideIdByPosition.get(img.slot)
    if (!slideId) continue

    const fileRes = await fetch(`${BOX_API}/files/${img.id}/content`, {
      headers: { Authorization: `Bearer ${token}`, BoxApi: `shared_link=${sharedLink}` },
      redirect: 'follow',
    })
    if (!fileRes.ok) continue
    const buffer = Buffer.from(await fileRes.arrayBuffer())
    const ext = img.name.split('.').pop()?.toLowerCase() ?? ''
    const safeName = img.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `cards/${cardId}/slides/box_pull_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`

    const { error: upErr } = await supabase.storage
      .from('creative-files')
      .upload(path, buffer, { contentType: IMAGE_MIME[ext], upsert: true })
    if (upErr) continue

    const { data: signed } = await supabase.storage
      .from('creative-files')
      .createSignedUrl(path, 3600 * 24 * 365)
    if (!signed?.signedUrl) continue

    await supabase
      .from('carousel_slides')
      .update({ image_url: signed.signedUrl, updated_at: new Date().toISOString() })
      .eq('id', slideId)

    imported++
    if (coverUrl === null) coverUrl = signed.signedUrl
  }

  // First imported slide (lowest slot) becomes the board cover.
  if (coverUrl) {
    await supabase.from('cards').update({ preview_image_url: coverUrl }).eq('id', cardId)
  }

  return NextResponse.json({ imported, folderId })
}
