import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import CopyTrackerClient from './CopyTrackerClient'
import type { ArchiveEntry, ArchiveFile, FlightSpan, LineageRun, Client } from '@/types'

export const revalidate = 60

export default async function CopyTrackerPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Resolve Live column first — needed to include Live cards with no flight date in the filter
  const [{ data: columns }, { data: clientsData }] = await Promise.all([
    supabase.from('columns').select('id, title'),
    supabase.from('clients').select('*').eq('active', true).order('name'),
  ])

  const doneColumnId = (columns ?? []).find((c: { id: string; title: string }) => c.title === 'Done')?.id ?? null

  // Include: archived cards, cards with a flight date, OR cards currently in the Done column
  const orFilter = [
    'archived.eq.true',
    'flight_start_date.not.is.null',
    ...(doneColumnId ? [`column_id.eq.${doneColumnId}`] : []),
  ].join(',')

  const { data: cards } = await supabase
    .from('cards')
    .select(`
      id, title, client_id, column_id, media_type, approval_status, description,
      landing_page_url, utm_campaign, utm_channel, preview_image_url,
      flight_start_date, flight_end_date, creative_name, client_portal_status,
      source_card_id, run_number, archived, restart_requested_at,
      fb_headline, fb_body_text, fb_cta, created_at, updated_at,
      clients(id, name, abbreviation, fb_page_logo_url)
    `)
    .or(orFilter)
    .order('created_at', { ascending: false })

  type CardRow = NonNullable<typeof cards>[number]
  const cardList = cards ?? []
  const cardIds = cardList.map((c: CardRow) => c.id)

  const [{ data: files }, { data: flightRows }] = await Promise.all([
    cardIds.length > 0
      ? supabase.from('card_files').select('id, card_id, file_name, file_url, file_type, dimensions').in('card_id', cardIds)
      : Promise.resolve({ data: [] as { id: string; card_id: string; file_name: string; file_url: string; file_type: string | null; dimensions: string | null }[] }),
    cardIds.length > 0
      ? supabase.from('card_flights').select('card_id, went_live_at, went_dark_at').in('card_id', cardIds).eq('voided', false).order('went_live_at', { ascending: false })
      : Promise.resolve({ data: [] as { card_id: string; went_live_at: string; went_dark_at: string | null }[] }),
  ])

  // Latest non-voided flight per card (rows already ordered desc by went_live_at)
  const latestFlight = new Map<string, { went_live_at: string; went_dark_at: string | null }>()
  for (const f of flightRows ?? []) {
    if (!latestFlight.has(f.card_id)) latestFlight.set(f.card_id, f)
  }

  // All non-voided flights per card as date spans, oldest first — the timeline
  // draws one bar per span (end === null means the card is live right now)
  const flightsByCard = new Map<string, FlightSpan[]>()
  for (const f of flightRows ?? []) {
    if (!flightsByCard.has(f.card_id)) flightsByCard.set(f.card_id, [])
    flightsByCard.get(f.card_id)!.push({
      start: f.went_live_at.slice(0, 10),
      end: f.went_dark_at ? f.went_dark_at.slice(0, 10) : null,
    })
  }
  for (const spans of flightsByCard.values()) {
    spans.sort((a, b) => a.start.localeCompare(b.start))
  }

  const todayStr = new Date().toISOString().slice(0, 10)

  const filesByCard = new Map<string, typeof files>()
  for (const f of files ?? []) {
    if (!filesByCard.has(f.card_id)) filesByCard.set(f.card_id, [])
    filesByCard.get(f.card_id)!.push(f)
  }

  // Build lineage map: rootId → sorted array of runs
  const lineageMap = new Map<string, LineageRun[]>()
  for (const c of cardList) {
    const rootId = c.source_card_id ?? c.id
    if (!lineageMap.has(rootId)) lineageMap.set(rootId, [])
    lineageMap.get(rootId)!.push({
      card_id: c.id,
      run_number: c.run_number ?? 1,
      title: c.title,
      flight_start_date: c.flight_start_date,
      flight_end_date: c.flight_end_date,
      adpiler_preview_url: null,
      flights: flightsByCard.get(c.id) ?? [],
      is_live: !!(doneColumnId && c.column_id === doneColumnId),
      archived: c.archived,
    })
  }
  for (const runs of lineageMap.values()) runs.sort((a, b) => a.run_number - b.run_number)

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  function storagePublicUrl(p: string): string {
    return `${SUPABASE_URL}/storage/v1/object/public/creative-files/${p}`
  }

  const archive: ArchiveEntry[] = cardList.map((c: CardRow) => {
    type FileRow = NonNullable<typeof files>[number]
    const cardFiles: ArchiveFile[] = (filesByCard.get(c.id) ?? []).map((f: FileRow) => ({
      id: f.id,
      file_name: f.file_name,
      file_url: f.file_url?.startsWith('http') ? f.file_url : storagePublicUrl(f.file_url),
      file_type: f.file_type,
      dimensions: f.dimensions,
    }))

    const client = c.clients as unknown as { id: string; name: string; abbreviation: string | null; fb_page_logo_url: string | null } | null
    const rootId = c.source_card_id ?? c.id
    const flight = latestFlight.get(c.id)

    // Effective dates: manual flight dates take priority; fall back to card_flights record
    const hasManualDates = !!c.flight_start_date
    const effectiveStart = c.flight_start_date
      ?? (flight ? flight.went_live_at.slice(0, 10) : null)
    const effectiveEnd = c.flight_end_date
      ?? (flight ? (flight.went_dark_at ? flight.went_dark_at.slice(0, 10) : todayStr) : null)

    return {
      id: c.id,
      title: c.title,
      client_id: c.client_id,
      client_name: client?.name ?? null,
      client_abbreviation: client?.abbreviation ?? null,
      client_logo_url: client?.fb_page_logo_url ?? null,
      media_type: c.media_type,
      approval_status: c.approval_status,
      description: c.description,
      landing_page_url: c.landing_page_url,
      utm_campaign: c.utm_campaign,
      utm_channel: c.utm_channel,
      preview_image_url: c.preview_image_url,
      flight_start_date: c.flight_start_date,
      flight_end_date: c.flight_end_date,
      creative_name: c.creative_name,
      source_card_id: c.source_card_id,
      run_number: c.run_number ?? 1,
      adpiler_preview_url: null,
      client_portal_status: (c.client_portal_status as 'pending_approval' | 'running' | 'archive_review' | null) ?? null,
      archived: c.archived,
      is_live: !!(doneColumnId && c.column_id === doneColumnId),
      effective_flight_start: effectiveStart,
      effective_flight_end: effectiveEnd,
      flight_dates_auto: !hasManualDates && !!flight,
      restart_requested_at: c.restart_requested_at,
      fb_headline: c.fb_headline,
      fb_body_text: c.fb_body_text,
      fb_cta: c.fb_cta,
      flights: flightsByCard.get(c.id) ?? [],
      created_at: c.created_at,
      updated_at: c.updated_at,
      files: cardFiles,
      lineage: lineageMap.get(rootId) ?? [],
    }
  })

  return (
    <CopyTrackerClient
      archive={archive}
      clients={(clientsData ?? []) as Client[]}
    />
  )
}
