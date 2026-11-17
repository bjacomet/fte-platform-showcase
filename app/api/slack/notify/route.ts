import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { notifyColumnWatchers } from '@/lib/slack'

// Internal endpoint called by Board.tsx on every column move.
// Finds all users who are watching the destination column + client,
// then sends each a personal Slack DM. Fully best-effort.
// Dispatch logic lives in lib/slack.ts → notifyColumnWatchers so server
// code (e.g. /api/cards/restart) can call it without an HTTP round-trip.
//
// Body: { card_id: string; column_id: string; client_id: string | null }

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    card_id: string
    column_id: string
    client_id: string | null
  }
  const { card_id, column_id, client_id } = body

  if (!card_id || !column_id) {
    return NextResponse.json({ error: 'card_id and column_id are required' }, { status: 400 })
  }

  const sent = await notifyColumnWatchers(supabase, {
    cardId: card_id,
    columnId: column_id,
    clientId: client_id ?? null,
  })

  return NextResponse.json({ ok: true, sent })
}
