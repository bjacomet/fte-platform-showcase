import { createServerClient } from '@supabase/ssr'
import ReviewClient from './ReviewClient'
import ExpiredReview from './ExpiredReview'

export const dynamic = 'force-dynamic'

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } }
  )

  const { data, error } = await supabase.rpc('get_client_review', {
    p_token: token,
  })

  if (error || !data) {
    return <ExpiredReview />
  }

  // Build public URLs for all files — bucket is public so no signing needed
  const allFiles = (data.cards ?? []).flatMap(
    (c: { files?: Array<{ id: string; file_url: string }> }) => c.files ?? []
  )

  const fileUrls: Record<string, string> = {}
  for (const f of allFiles as Array<{ id: string; file_url: string }>) {
    const { data: urlData } = supabase.storage
      .from('creative-files')
      .getPublicUrl(f.file_url)
    if (urlData?.publicUrl) fileUrls[f.id] = urlData.publicUrl
  }

  // Fetch carousel slides for any carousel cards
  const cardIds = (data.cards ?? []).map((c: { id: string }) => c.id)
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

  return <ReviewClient data={data} token={token} fileUrls={fileUrls} carouselSlides={carouselSlides} />
}
