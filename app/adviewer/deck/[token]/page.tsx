import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import DeckPreviewClient from './DeckPreviewClient'

export const dynamic = 'force-dynamic'

export default async function DeckPreviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = await createClient()

  const { data: deck } = await supabase
    .from('adviewer_creative_decks')
    .select(`
      id, title, token, client_id, created_at,
      client:clients(id, name, fb_page_logo_url),
      items:adviewer_creative_deck_items(
        id, deck_id, source_type, source_id, position
      )
    `)
    .eq('token', token)
    .single()

  if (!deck) notFound()

  // Sort items by position
  const items = ((deck.items ?? []) as { id: string; source_type: string; source_id: string; position: number }[])
    .sort((a, b) => a.position - b.position)

  // Resolve each item's source data
  const resolvedItems = await Promise.all(
    items.map(async item => {
      if (item.source_type === 'file') {
        const { data: file } = await supabase
          .from('adviewer_campaign_files')
          .select('id, file_name, file_url, position, status')
          .eq('id', item.source_id)
          .single()
        return { ...item, file: (file ?? null) as { id: string; file_name: string; file_url: string | null; position: number; status: string } | null, card: null }
      } else {
        const { data: cc } = await supabase
          .from('adviewer_campaign_cards')
          .select('id, status, card:cards!inner(id, title, media_type)')
          .eq('id', item.source_id)
          .single()
        const raw = cc as { id: string; status: string; card: { id: string; title: string; media_type: string | null }[] } | null
        return {
          ...item,
          file: null,
          card: raw ? { id: raw.id, status: raw.status, card: raw.card[0] ?? null } : null,
        }
      }
    })
  )

  const clientRow = Array.isArray(deck.client) ? deck.client[0] : deck.client as { name: string; fb_page_logo_url: string | null } | null

  return (
    <DeckPreviewClient
      deck={{ ...deck, items: resolvedItems }}
      clientName={clientRow?.name ?? null}
      clientLogo={clientRow?.fb_page_logo_url ?? null}
    />
  )
}
