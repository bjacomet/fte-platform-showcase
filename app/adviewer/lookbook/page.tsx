import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import LookbookClient from './LookbookClient'
import type { AdviewerCampaign, AdviewerCreativeDeck, AdviewerLookbookFolder } from '@/types'

export const dynamic = 'force-dynamic'

export default async function LookbookPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/adviewer/login')

  // Staff only
  const { data: adviewerClient } = await supabase
    .from('adviewer_clients')
    .select('id')
    .eq('auth_user_id', user.id)
    .single()
  if (adviewerClient) redirect('/adviewer/projects')

  const [{ data: campaigns }, { data: decks }, { data: folders }] = await Promise.all([
    supabase
      .from('adviewer_campaigns')
      .select(`
        id, title, token, status, archived, client_id, lookbook_folder_id, created_at, updated_at,
        client:clients(id, name, fb_page_logo_url),
        campaign_cards:adviewer_campaign_cards(
          id, position, status, client_notes,
          card:cards(id, title, media_type, archived, preview_image_url, card_files(id, file_name, file_url, file_type, dimensions, created_at))
        ),
        campaign_files:adviewer_campaign_files(id, file_name, file_url, position, status)
      `)
      .eq('archived', true)
      .order('updated_at', { ascending: false }),

    supabase
      .from('adviewer_creative_decks')
      .select(`
        id, title, token, client_id, created_at,
        client:clients(id, name, fb_page_logo_url),
        items:adviewer_creative_deck_items(id, deck_id, source_type, source_id, position)
      `)
      .order('created_at', { ascending: false }),

    supabase
      .from('adviewer_lookbook_folders')
      .select('id, client_id, parent_id, name, kind, position, created_at, updated_at')
      .order('position', { ascending: true }),
  ])

  return (
    <LookbookClient
      campaigns={(campaigns ?? []) as unknown as AdviewerCampaign[]}
      decks={(decks ?? []) as unknown as AdviewerCreativeDeck[]}
      folders={(folders ?? []) as unknown as AdviewerLookbookFolder[]}
    />
  )
}
