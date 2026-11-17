import { createServerClient } from '@supabase/ssr'
import { notFound } from 'next/navigation'
import ClientCalendarView, {
  type CalendarClient,
  type CalendarPost,
} from '@/components/ClientCalendarView'
import { normalizeMonth } from '@/lib/calendar'

export const dynamic = 'force-dynamic'

interface TokenSearchParams {
  year?: string
  month?: string
}

interface RpcResponse {
  client: CalendarClient
  year: number
  month: number
  box_link_url: string | null
  posts: Array<{
    id: string
    title: string
    media_type: string | null
    flight_start_date: string | null
    fb_page_name: string | null
    fb_body_text: string | null
    fb_headline: string | null
    fb_link_description: string | null
    fb_cta: string | null
    landing_page_url: string | null
    preview_image_url: string | null
    first_image_path: string | null
    carousel_slides: Array<{
      id: string
      position: number
      headline: string | null
      link_description: string | null
      landing_page_url: string | null
      image_url: string | null
    }> | null
  }>
}

export default async function ClientCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<TokenSearchParams>
}) {
  const { token } = await params
  const qs = await searchParams
  const { year, month } = normalizeMonth(qs.year, qs.month)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } }
  )

  const { data, error } = await supabase.rpc('get_client_calendar', {
    p_token: token,
    p_year: year,
    p_month: month,
  })

  if (error || !data) {
    notFound()
  }

  const payload = data as RpcResponse

  // Resolve each post's image: prefer preview_image_url (direct URL), fall back to first_image_path (storage).
  const posts: CalendarPost[] = payload.posts.map((p) => {
    let imageUrl: string | null = p.preview_image_url ?? null
    if (!imageUrl && p.first_image_path) {
      const { data: urlData } = supabase.storage
        .from('creative-files')
        .getPublicUrl(p.first_image_path)
      imageUrl = urlData?.publicUrl ?? null
    }
    return {
      id: p.id,
      title: p.title,
      media_type: p.media_type,
      flight_start_date: p.flight_start_date,
      fb_page_name: p.fb_page_name,
      fb_body_text: p.fb_body_text,
      fb_headline: p.fb_headline,
      fb_link_description: p.fb_link_description,
      fb_cta: p.fb_cta,
      landing_page_url: p.landing_page_url,
      image_url: imageUrl,
      carousel_slides: p.carousel_slides ?? [],
    }
  })

  return (
    <ClientCalendarView
      token={token}
      client={payload.client}
      year={year}
      month={month}
      boxLinkUrl={payload.box_link_url}
      posts={posts}
    />
  )
}
