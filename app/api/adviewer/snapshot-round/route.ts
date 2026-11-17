import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { snapshotCardFileRound } from '@/lib/adviewerHistory'

interface SnapshotBody {
  cardId: string
  fileId: string
  fileName: string
  dimensions: string | null
  thumbUrl: string | null
}

// Freezes the Adviewer change-request round anchored to a card file into
// client_notes.history before the file is deleted (designer-side, from FileUpload).
// Runs under the authenticated user context — same trust model as the resolve POST.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: SnapshotBody
  try {
    body = await req.json() as SnapshotBody
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { cardId, fileId, fileName, dimensions, thumbUrl } = body
  if (!cardId || !fileId || !fileName) {
    return NextResponse.json({ error: 'Missing cardId, fileId, or fileName' }, { status: 400 })
  }

  try {
    await snapshotCardFileRound(supabase, {
      cardId,
      fileId,
      fileName,
      dimensions: dimensions ?? null,
      thumbUrl: thumbUrl ?? null,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Snapshot failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
