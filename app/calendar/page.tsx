import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import CalendarView from '@/components/CalendarView'
import type { Card, CarouselSlide, Client, Column } from '@/types'
import { POST_STYLE_MEDIA_TYPES, monthBounds, normalizeMonth } from '@/lib/calendar'

export const dynamic = 'force-dynamic'

interface CalendarSearchParams {
  client?: string
  year?: string
  month?: string
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<CalendarSearchParams>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const userEmail = user.email ?? 'unknown'

  // Clients list for the picker, and for resolving the selected client.
  const { data: clientsData } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true })
  const clients = (clientsData ?? []) as Client[]

  // Resolve selected client (URL param → first client → null).
  const requestedClient = params.client
  const selectedClientId =
    requestedClient && clients.some((c) => c.id === requestedClient)
      ? requestedClient
      : clients[0]?.id ?? null

  // Resolve month.
  const { year, month } = normalizeMonth(params.year, params.month)

  // Columns — needed by CardDrawer when a post is clicked.
  const { data: columnsData } = await supabase
    .from('columns')
    .select('*')
    .order('position', { ascending: true })
  const columns = (columnsData ?? []) as Column[]
  const doneColumnId = columns.find((c) => c.title === 'Done')?.id ?? null

  // Fetch the month's posts for the selected client.
  let cards: Card[] = []
  const slidesByCardId: Record<string, CarouselSlide[]> = {}
  const imageUrlByCardId: Record<string, string | null> = {}
  let boxLinkUrl: string | null = null

  if (selectedClientId) {
    const { start, end } = monthBounds(year, month)

    const { data: posts } = await supabase
      .from('cards')
      .select('*, clients(id, name, abbreviation, adpiler_campaign_code, fb_page_logo_url, utm_config, calendar_share_token)')
      .eq('client_id', selectedClientId)
      .eq('archived', false)
      .in('media_type', [...POST_STYLE_MEDIA_TYPES])
      .gte('flight_start_date', start)
      .lt('flight_start_date', end)
      .order('flight_start_date', { ascending: true })
    cards = (posts ?? []) as Card[]

    if (cards.length > 0) {
      const cardIds = cards.map((c) => c.id)

      // Carousel slides for any carousel cards.
      const { data: slides } = await supabase
        .from('carousel_slides')
        .select('*')
        .in('card_id', cardIds)
        .order('position', { ascending: true })
      for (const s of (slides ?? []) as CarouselSlide[]) {
        if (!slidesByCardId[s.card_id]) slidesByCardId[s.card_id] = []
        slidesByCardId[s.card_id].push(s)
      }

      // First image per card — prefer preview_image_url (direct URL or Box link),
      // fall back to the first uploaded file in card_files.
      for (const c of cards) {
        if (c.preview_image_url) imageUrlByCardId[c.id] = c.preview_image_url
      }
      const cardsNeedingFile = cards.filter((c) => !imageUrlByCardId[c.id]).map((c) => c.id)
      if (cardsNeedingFile.length > 0) {
        const { data: files } = await supabase
          .from('card_files')
          .select('card_id, file_url, file_type, created_at')
          .in('card_id', cardsNeedingFile)
          .in('file_type', ['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
          .order('created_at', { ascending: true })

        const seen = new Set<string>()
        for (const f of files ?? []) {
          if (seen.has(f.card_id)) continue
          seen.add(f.card_id)
          const { data: urlData } = supabase.storage
            .from('creative-files')
            .getPublicUrl(f.file_url)
          imageUrlByCardId[f.card_id] = urlData?.publicUrl ?? null
        }
      }
    }

    // Per-month Box link.
    const { data: boxRow } = await supabase
      .from('client_calendar_months')
      .select('box_link_url')
      .eq('client_id', selectedClientId)
      .eq('year', year)
      .eq('month', month)
      .maybeSingle()
    boxLinkUrl = boxRow?.box_link_url ?? null
  }

  return (
    <CalendarView
      clients={clients}
      selectedClientId={selectedClientId}
      year={year}
      month={month}
      cards={cards}
      slidesByCardId={slidesByCardId}
      imageUrlByCardId={imageUrlByCardId}
      boxLinkUrl={boxLinkUrl}
      columns={columns}
      doneColumnId={doneColumnId}
      userEmail={userEmail}
    />
  )
}
