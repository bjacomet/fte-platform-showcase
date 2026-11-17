import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Board from '@/components/Board'
import { BOARD_CARD_SELECT } from '@/lib/cardQueries'
import type { BoardCard, Client, Column } from '@/types'
import { VIDEO_DESIGNER_KEY, parseDesigner } from '@/lib/designers'

export const revalidate = 30 // revalidate every 30 seconds instead of every request

export default async function BoardPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const userEmail = user.email ?? 'unknown'
  const userFullName = (user.user_metadata?.full_name as string | undefined)
    ?? (user.user_metadata?.name as string | undefined)
    ?? ''

  const [{ data: columns }, { data: cards }, { data: clients }, { data: bgRow }, { data: videoRow }] = await Promise.all([
    supabase
      .from('columns')
      .select('*')
      .order('position', { ascending: true }),
    supabase
      .from('cards')
      // Slim select — board only needs what cards render; full card is fetched on open
      .select(BOARD_CARD_SELECT)
      .eq('archived', false)
      .eq('calendar_only', false)
      // Atlas cards live on the Atlas-only board (/atlas → Board tab), never the main board.
      .is('atlas_location_id', null)
      .order('position', { ascending: true }),
    supabase
      .from('clients')
      .select('*')
      .eq('active', true)
      .order('name', { ascending: true }),
    supabase.from('app_settings').select('value').eq('key', 'board_background_url').maybeSingle(),
    supabase.from('app_settings').select('value').eq('key', VIDEO_DESIGNER_KEY).maybeSingle(),
  ])

  // Use || (not ??) so an empty-string value also falls through to the default
  const backgroundUrl = bgRow?.value || 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1600&q=80&fit=crop'

  return (
    <Board
      initialColumns={(columns ?? []) as Column[]}
      initialCards={(cards ?? []) as unknown as BoardCard[]}
      clients={(clients ?? []) as Client[]}
      backgroundUrl={backgroundUrl}
      userEmail={userEmail}
      userFullName={userFullName}
      videoDesigner={parseDesigner(videoRow?.value)}
    />
  )
}
