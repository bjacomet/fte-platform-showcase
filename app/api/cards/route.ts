import { createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { TEMPLATE_OPTIONS, FB_CTA_OPTIONS } from '@/types'

const VALID_MEDIA_TYPES = new Set<string>(TEMPLATE_OPTIONS)
const VALID_CTA_OPTIONS = new Set<string>(FB_CTA_OPTIONS)

interface CreateCardBody {
  title: string
  client_name: string
  media_type?: string
  column_name?: string
  description?: string
  creative_brief?: string
  fb_body_text?: string
  fb_headline?: string
  fb_link_description?: string
  fb_cta?: string
  flight_start_date?: string
}

export async function POST(req: Request) {
  const apiKey = process.env.EXTERNAL_API_KEY
  const authHeader = req.headers.get('authorization')
  if (!apiKey || authHeader !== `Bearer ${apiKey}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: CreateCardBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const {
    title,
    client_name,
    media_type,
    column_name,
    description,
    creative_brief,
    fb_body_text,
    fb_headline,
    fb_link_description,
    fb_cta,
    flight_start_date,
  } = body

  if (!title?.trim()) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }
  if (!client_name?.trim()) {
    return NextResponse.json({ error: 'client_name is required' }, { status: 400 })
  }
  if (media_type && !VALID_MEDIA_TYPES.has(media_type)) {
    return NextResponse.json(
      { error: `Invalid media_type. Valid values: ${TEMPLATE_OPTIONS.join(', ')}` },
      { status: 400 }
    )
  }
  if (fb_cta && !VALID_CTA_OPTIONS.has(fb_cta)) {
    return NextResponse.json(
      { error: `Invalid fb_cta. Valid values: ${FB_CTA_OPTIONS.join(', ')}` },
      { status: 400 }
    )
  }
  if (flight_start_date && !/^\d{4}-\d{2}-\d{2}$/.test(flight_start_date)) {
    return NextResponse.json({ error: 'flight_start_date must be YYYY-MM-DD' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // Resolve client by name (case-insensitive, active only)
  const { data: clientMatches, error: clientErr } = await supabase
    .from('clients')
    .select('id, name')
    .ilike('name', client_name.trim())
    .eq('active', true)
    .limit(2)

  if (clientErr) {
    return NextResponse.json({ error: 'Failed to look up client' }, { status: 500 })
  }
  if (!clientMatches || clientMatches.length === 0) {
    return NextResponse.json({ error: `Client not found: "${client_name}"` }, { status: 400 })
  }
  if (clientMatches.length > 1) {
    return NextResponse.json(
      { error: `Ambiguous client name "${client_name}" — be more specific` },
      { status: 400 }
    )
  }
  const client = clientMatches[0]

  // Resolve column by name, or default to first column (Queue)
  let columnId: string
  if (column_name?.trim()) {
    const { data: col } = await supabase
      .from('columns')
      .select('id')
      .ilike('title', column_name.trim())
      .single()

    if (!col) {
      return NextResponse.json({ error: `Column not found: "${column_name}"` }, { status: 400 })
    }
    columnId = col.id
  } else {
    const { data: firstCol } = await supabase
      .from('columns')
      .select('id')
      .order('position', { ascending: true })
      .limit(1)
      .single()

    if (!firstCol) {
      return NextResponse.json({ error: 'No columns found' }, { status: 500 })
    }
    columnId = firstCol.id
  }

  // Place card at end of target column
  const { data: posRows } = await supabase
    .from('cards')
    .select('position')
    .eq('column_id', columnId)
    .order('position', { ascending: false })
    .limit(1)

  const position = ((posRows?.[0]?.position) ?? -1) + 1

  const { data: card, error: insertErr } = await supabase
    .from('cards')
    .insert({
      title: title.trim(),
      client_id: client.id,
      column_id: columnId,
      media_type: media_type ?? 'Social Ad Request',
      description: description ?? null,
      creative_brief: creative_brief ?? null,
      fb_body_text: fb_body_text ?? null,
      fb_headline: fb_headline ?? null,
      fb_link_description: fb_link_description ?? null,
      fb_cta: fb_cta ?? null,
      flight_start_date: flight_start_date ?? null,
      approval_status: 'none',
      archived: false,
      calendar_only: false,
      position,
    })
    .select('id, title, client_id, column_id')
    .single()

  if (insertErr || !card) {
    console.error('Card insert error:', insertErr)
    return NextResponse.json({ error: 'Failed to create card' }, { status: 500 })
  }

  await supabase.from('card_activity').insert({
    card_id: card.id,
    actor: 'External API',
    action: 'created',
    detail: 'Card created via external API',
  })

  return NextResponse.json(
    { id: card.id, title: card.title, client_id: card.client_id, column_id: card.column_id },
    { status: 201 }
  )
}
