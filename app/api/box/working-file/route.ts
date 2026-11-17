import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBoxToken } from '@/lib/box'

const BOX_API = 'https://api.box.com/2.0'

interface BoxItem {
  id: string
  name: string
  type: 'file' | 'folder'
}

interface BoxFolderInfo {
  id: string
  name: string
  parent: { id: string; name: string } | null
}

async function getFolderInfo(folderId: string, token: string): Promise<BoxFolderInfo> {
  const res = await fetch(`${BOX_API}/folders/${folderId}?fields=id,name,parent`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Box folder info failed: ${res.status}`)
  return res.json() as Promise<BoxFolderInfo>
}

async function listFolderItems(folderId: string, token: string): Promise<BoxItem[]> {
  const res = await fetch(`${BOX_API}/folders/${folderId}/items?limit=1000&fields=id,name,type`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Box folder list failed: ${res.status}`)
  const json = await res.json() as { entries: BoxItem[] }
  return json.entries
}

/**
 * GET /api/box/working-file?cardId=xxx&fileName=yyy
 *
 * Finds the PSD in the card's 0-Working Files Box folder that matches the
 * given fileName (same base name, .psd extension). Returns the Box file ID
 * so the client can open it via the boxapp://file/{id} deep link.
 *
 * Box folder structure assumed:
 *   [Campaign folder]
 *     ├── 0-Working Files/   ← PSDs live here
 *     └── Build/             ← cards.box_folder_id points here
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const cardId = req.nextUrl.searchParams.get('cardId')
  const fileName = req.nextUrl.searchParams.get('fileName')

  if (!cardId || !fileName) {
    return NextResponse.json({ error: 'Missing cardId or fileName' }, { status: 400 })
  }

  // Fetch card
  const { data: card } = await supabase
    .from('cards')
    .select('box_folder_id')
    .eq('id', cardId)
    .single()

  if (!card?.box_folder_id) {
    return NextResponse.json({ error: 'No Box folder linked to this card' }, { status: 404 })
  }

  let token: string
  try {
    token = await getBoxToken()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Box not connected' },
      { status: 503 }
    )
  }

  // Build folder → parent campaign folder
  let campaignFolderId: string
  try {
    const buildFolderInfo = await getFolderInfo(card.box_folder_id, token)
    if (!buildFolderInfo.parent?.id) {
      return NextResponse.json({ error: 'Cannot determine parent folder for Box folder' }, { status: 404 })
    }
    campaignFolderId = buildFolderInfo.parent.id
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to get Box folder info' },
      { status: 502 }
    )
  }

  // Campaign folder → find 0-Working Files subfolder
  let workingFilesFolderId: string
  try {
    const campaignItems = await listFolderItems(campaignFolderId, token)
    const workingFolder = campaignItems.find(
      (item) => item.type === 'folder' && item.name === '0-Working Files'
    )
    if (!workingFolder) {
      return NextResponse.json({ error: '0-Working Files folder not found in campaign folder' }, { status: 404 })
    }
    workingFilesFolderId = workingFolder.id
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list campaign folder' },
      { status: 502 }
    )
  }

  // 0-Working Files → find PSD matching base filename
  const baseName = fileName.replace(/\.[^.]+$/, '')
  const psdName = `${baseName}.psd`

  try {
    const workingItems = await listFolderItems(workingFilesFolderId, token)
    const psdFile = workingItems.find(
      (item) => item.type === 'file' && item.name.toLowerCase() === psdName.toLowerCase()
    )
    if (!psdFile) {
      return NextResponse.json(
        { error: `PSD not found: ${psdName}` },
        { status: 404 }
      )
    }
    return NextResponse.json({ fileId: psdFile.id, fileName: psdFile.name })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list working files folder' },
      { status: 502 }
    )
  }
}
