import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import ProjectClient from './ProjectClient'

// Raw shape returned by Supabase nested select (FK joins come back as arrays)
interface RawProjectCard {
  id: string
  position: number
  card: {
    id: string
    title: string
    media_type: string | null
    client_portal_status: string | null
    archived: boolean | null
    flight_start_date: string | null
    flight_end_date: string | null
    fb_page_name: string | null
    fb_body_text: string | null
    fb_headline: string | null
    fb_link_description: string | null
    fb_cta: string | null
    landing_page_url: string | null
    adpiler_preview_url: string | null
    companion_banner_link: string | null
    card_files: Array<{ id: string; file_name: string; file_url: string; file_type: string | null; dimensions: string | null; created_at: string }>
  }
}

export const dynamic = 'force-dynamic'

export default async function AdviewerProjectPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/adviewer/login')

  // Resolve adviewer client record
  const { data: adviewerClient } = await supabase
    .from('adviewer_clients')
    .select('id, client_id')
    .eq('auth_user_id', user.id)
    .single()

  if (!adviewerClient) redirect('/adviewer/login')

  // Fetch the project
  const { data: project } = await supabase
    .from('adviewer_projects')
    .select(`
      id, title, description, status, created_at, updated_at,
      client:clients(id, name, fb_page_logo_url)
    `)
    .eq('id', id)
    .eq('client_id', adviewerClient.client_id)
    .single()

  if (!project || project.status === 'archived') notFound()

  // Fetch project cards with full card data + files
  const { data: projectCards } = await supabase
    .from('adviewer_project_cards')
    .select(`
      id, position,
      card:cards(
        id, title, media_type, client_portal_status, archived,
        flight_start_date, flight_end_date,
        fb_page_name, fb_body_text, fb_headline, fb_link_description, fb_cta,
        landing_page_url, adpiler_preview_url, companion_banner_link,
        card_files(id, file_name, file_url, file_type, dimensions, created_at)
      )
    `)
    .eq('project_id', id)
    .order('position', { ascending: true })

  // Same rule as the token portal (/adviewer/c/[token]): an archived board card is
  // pulled work and must not stay in front of a client. Filtered in JS because a
  // PostgREST filter on the embedded `cards` resource returns the project_card row
  // with `card: null` rather than dropping it. The adviewer_project_cards rows stay
  // — they are the record that the card was in this project. Only `archived === true`
  // hides; a null/absent flag stays visible.
  const typedCards = ((projectCards ?? []) as unknown as RawProjectCard[]).filter(
    (pc) => pc.card && pc.card.archived !== true
  )

  // Build public URLs for all files
  const allFiles = typedCards.flatMap((pc) => pc.card?.card_files ?? [])

  const fileUrls: Record<string, string> = {}
  for (const f of allFiles) {
    const { data: urlData } = supabase.storage
      .from('creative-files')
      .getPublicUrl(f.file_url)
    if (urlData?.publicUrl) fileUrls[f.id] = urlData.publicUrl
  }

  // Fetch carousel slides for any carousel cards
  const cardIds = typedCards.map((pc) => pc.card?.id).filter(Boolean) as string[]

  const carouselSlides: Record<string, Array<{
    id: string; card_id: string; position: number
    headline: string | null; link_description: string | null
    landing_page_url: string | null; image_url: string | null
    created_at: string; updated_at: string
  }>> = {}

  if (cardIds.length > 0) {
    const { data: slides } = await supabase
      .from('carousel_slides')
      .select('*')
      .in('card_id', cardIds)
      .order('position', { ascending: true })

    for (const slide of slides ?? []) {
      if (!carouselSlides[slide.card_id]) carouselSlides[slide.card_id] = []
      carouselSlides[slide.card_id].push(slide)
    }
  }

  // Fetch existing feedback for this project from this client
  const { data: existingFeedback } = await supabase
    .from('adviewer_feedback')
    .select('id, card_id, file_id, slide_id, decision, comment, created_at')
    .eq('project_id', id)
    .eq('adviewer_client_id', adviewerClient.id)

  // Log event
  await supabase.from('adviewer_events').insert({
    adviewer_client_id: adviewerClient.id,
    project_id: id,
    event_type: 'project_viewed',
    metadata: { card_count: cardIds.length },
  })

  // Normalize: Supabase returns FK joins as arrays; cast to single objects for the client
  const normalizedProject = {
    ...project,
    client: Array.isArray(project.client) ? (project.client[0] ?? null) : project.client,
  } as {
    id: string; title: string; description: string | null; status: string; updated_at: string
    client: { id: string; name: string; fb_page_logo_url: string | null } | null
  }

  return (
    <ProjectClient
      project={normalizedProject}
      projectCards={typedCards}
      fileUrls={fileUrls}
      carouselSlides={carouselSlides}
      existingFeedback={existingFeedback ?? []}
      adviewerClientId={adviewerClient.id}
    />
  )
}
