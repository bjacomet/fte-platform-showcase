import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

interface DeckItem {
  source_type: 'file' | 'card'
  source_id: string
  position: number
}

interface CreateDeckPayload {
  title: string
  client_id: string | null
  items: DeckItem[]
}

export async function POST(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as CreateDeckPayload

  if (!body.title?.trim() || !Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'title and items are required' }, { status: 400 })
  }

  // Create the deck
  const { data: deck, error: deckError } = await supabase
    .from('adviewer_creative_decks')
    .insert({
      title: body.title.trim(),
      client_id: body.client_id ?? null,
    })
    .select('id, title, token, client_id, created_at, client:clients(id, name, fb_page_logo_url)')
    .single()

  if (deckError || !deck) {
    return NextResponse.json({ error: deckError?.message ?? 'Failed to create deck' }, { status: 500 })
  }

  // Insert items
  const { error: itemsError } = await supabase
    .from('adviewer_creative_deck_items')
    .insert(
      body.items.map(item => ({
        deck_id: deck.id,
        source_type: item.source_type,
        source_id: item.source_id,
        position: item.position,
      }))
    )

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 })
  }

  return NextResponse.json({ token: deck.token, deck })
}
