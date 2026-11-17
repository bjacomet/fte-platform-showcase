import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

interface CloneRequest {
  sourceCardId: string
  title: string
  flightStartDate: string
  flightEndDate: string
  utmCampaignSuffix: string
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: CloneRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { sourceCardId, title, flightStartDate, flightEndDate, utmCampaignSuffix } = body
  if (!sourceCardId || !title?.trim()) {
    return NextResponse.json({ error: 'sourceCardId and title are required' }, { status: 400 })
  }

  // Fetch source card
  const { data: source, error: sourceErr } = await supabase
    .from('cards')
    .select('*')
    .eq('id', sourceCardId)
    .single()

  if (sourceErr || !source) {
    return NextResponse.json({ error: 'Source card not found' }, { status: 404 })
  }

  // Determine the root card id for lineage tracking (always point to original root)
  const rootId: string = source.source_card_id ?? source.id

  // Compute next run_number: max across all cards sharing the same root
  const { data: siblings } = await supabase
    .from('cards')
    .select('run_number')
    .or(`id.eq.${rootId},source_card_id.eq.${rootId}`)

  const maxRun = siblings?.reduce((max: number, s: { run_number: number | null }) => Math.max(max, s.run_number ?? 1), 1) ?? 1
  const nextRun = maxRun + 1

  // Find Queue column (first column by position)
  const { data: queueCol } = await supabase
    .from('columns')
    .select('id')
    .order('position', { ascending: true })
    .limit(1)
    .single()

  if (!queueCol) {
    return NextResponse.json({ error: 'No columns found' }, { status: 500 })
  }

  // Build new UTM campaign: base campaign + suffix
  const baseCampaign = source.utm_campaign ?? ''
  const newCampaign = utmCampaignSuffix
    ? baseCampaign
      ? `${baseCampaign}_${utmCampaignSuffix}`
      : utmCampaignSuffix
    : baseCampaign

  // Get max position in queue column
  const { data: posRows } = await supabase
    .from('cards')
    .select('position')
    .eq('column_id', queueCol.id)
    .order('position', { ascending: false })
    .limit(1)

  const newPosition = ((posRows?.[0]?.position) ?? -1) + 1

  // Create the cloned card
  const { data: newCard, error: insertErr } = await supabase
    .from('cards')
    .insert({
      title: title.trim(),
      client_id: source.client_id,
      column_id: queueCol.id,
      media_type: source.media_type,
      description: source.description,
      creative_brief: source.creative_brief,
      fb_page_name: source.fb_page_name,
      fb_body_text: source.fb_body_text,
      fb_headline: source.fb_headline,
      fb_link_description: source.fb_link_description,
      fb_cta: source.fb_cta,
      landing_page_url: source.landing_page_url,
      utm_campaign: newCampaign,
      utm_channel: source.utm_channel,
      creative_name: source.creative_name,
      flight_start_date: flightStartDate || null,
      flight_end_date: flightEndDate || null,
      box_folder_id: source.box_folder_id,
      ttd_ad_group_id: source.ttd_ad_group_id,
      preview_image_url: source.preview_image_url,
      approval_status: 'none',
      archived: false,
      calendar_only: false,
      position: newPosition,
      source_card_id: rootId,
      run_number: nextRun,
    })
    .select()
    .single()

  if (insertErr || !newCard) {
    console.error('Clone insert error:', insertErr)
    return NextResponse.json({ error: 'Failed to create card' }, { status: 500 })
  }

  // Clone card_files — new rows pointing to same file URLs (zero storage cost)
  const { data: sourceFiles } = await supabase
    .from('card_files')
    .select('*')
    .eq('card_id', sourceCardId)

  if (sourceFiles && sourceFiles.length > 0) {
    const filesToInsert = sourceFiles.map((f: NonNullable<typeof sourceFiles>[number]) => ({
      card_id: newCard.id,
      file_name: f.file_name,
      file_url: f.file_url,
      file_type: f.file_type,
      dimensions: f.dimensions,
      approval_status: 'none',
    }))
    await supabase.from('card_files').insert(filesToInsert)
  }

  // Clone carousel slides for Carousel Ad cards (same image URLs, no storage cost)
  if (source.media_type === 'Carousel Ad') {
    const { data: sourceSlides } = await supabase
      .from('carousel_slides')
      .select('*')
      .eq('card_id', sourceCardId)
      .order('position', { ascending: true })

    if (sourceSlides && sourceSlides.length > 0) {
      const slidesToInsert = sourceSlides.map((s: NonNullable<typeof sourceSlides>[number]) => ({
        card_id: newCard.id,
        position: s.position,
        headline: s.headline,
        link_description: s.link_description,
        landing_page_url: s.landing_page_url,
        image_url: s.image_url,
      }))
      await supabase.from('carousel_slides').insert(slidesToInsert)
    }
  }

  // Log activity
  await supabase.from('card_activity').insert({
    card_id: newCard.id,
    actor: 'Team',
    action: 'created',
    detail: `Cloned from card "${source.title}" (Run ${source.run_number ?? 1}) via Copy Tracker`,
  })

  return NextResponse.json({ card: newCard }, { status: 201 })
}
