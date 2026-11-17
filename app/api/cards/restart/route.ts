import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { handleColumnChange } from '@/lib/flights'
import { notifyColumnWatchers } from '@/lib/slack'

// Copy Tracker "Run again" — re-uses the SAME card row (no clone):
// sets new flight dates, un-archives, moves the card to the channel's
// "Ready for Traffic" column, and flags it as a re-run so it reads as an
// adjustment to an existing campaign rather than a fresh ad to build.
// The flag is cleared by lib/flights.ts when the card re-enters Done.

export type RestartChannel = 'display' | 'social' | 'ctv'

const CHANNEL_COLUMN_TITLES: Record<RestartChannel, string> = {
  display: 'Display - Ready for Traffic',
  social: 'Social - Ready for Traffic',
  ctv: 'CTV - Ready for Traffic',
}

interface RestartRequest {
  cardId: string
  flightStartDate: string
  flightEndDate: string
  channel: RestartChannel
  note?: string
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: RestartRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { cardId, flightStartDate, flightEndDate, channel, note } = body
  if (!cardId || !flightStartDate || !flightEndDate) {
    return NextResponse.json(
      { error: 'cardId, flightStartDate and flightEndDate are required' },
      { status: 400 },
    )
  }
  if (flightStartDate > flightEndDate) {
    return NextResponse.json({ error: 'flightStartDate must be on or before flightEndDate' }, { status: 400 })
  }
  const targetTitle = CHANNEL_COLUMN_TITLES[channel]
  if (!targetTitle) {
    return NextResponse.json({ error: 'channel must be display, social, or ctv' }, { status: 400 })
  }

  const { data: card, error: cardErr } = await supabase
    .from('cards')
    .select('id, title, client_id, column_id, client_portal_status')
    .eq('id', cardId)
    .single()
  if (cardErr || !card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  // Resolve columns by title — never trust a raw column_id from the client
  const { data: columns } = await supabase.from('columns').select('id, title')
  const doneColumnId = columns?.find((c: { id: string; title: string }) => c.title === 'Done')?.id ?? null
  const targetCol = columns?.find((c: { id: string; title: string }) => c.title === targetTitle)
  if (!targetCol) {
    return NextResponse.json({ error: `Column "${targetTitle}" not found on the board` }, { status: 500 })
  }

  // Live guard: a card in Done with an open flight is still running — the UI
  // offers "extend end date" instead of a restart.
  if (doneColumnId && card.column_id === doneColumnId) {
    const { data: openFlight } = await supabase
      .from('card_flights')
      .select('id')
      .eq('card_id', cardId)
      .is('went_dark_at', null)
      .eq('voided', false)
      .limit(1)
      .maybeSingle()
    if (openFlight) {
      return NextResponse.json({ error: 'card_live' }, { status: 409 })
    }
  }

  // Single write puts the card on top of the target column
  const { data: posRows } = await supabase
    .from('cards')
    .select('position')
    .eq('column_id', targetCol.id)
    .order('position', { ascending: true })
    .limit(1)
  const topPosition = ((posRows?.[0]?.position) ?? 1) - 1

  const flightMonth = Number(flightStartDate.slice(5, 7))
  const previousColumnId: string = card.column_id

  const { data: updated, error: updateErr } = await supabase
    .from('cards')
    .update({
      column_id: targetCol.id,
      position: topPosition,
      archived: false,
      calendar_only: false,
      flight_start_date: flightStartDate,
      flight_end_date: flightEndDate,
      flight_month: Number.isFinite(flightMonth) ? flightMonth : null,
      restart_requested_at: new Date().toISOString(),
      restart_requested_by: user.email ?? null,
      restart_note: note?.trim() || null,
      // A manual "running" portal override is now wrong; 'archive_review'
      // stays — the ad remains a legitimate past creative until it re-launches.
      ...(card.client_portal_status === 'running' ? { client_portal_status: null } : {}),
    })
    .eq('id', cardId)
    .select()
    .single()

  if (updateErr || !updated) {
    console.error('Restart update error:', updateErr)
    return NextResponse.json({ error: 'Failed to update card' }, { status: 500 })
  }

  // Closes a stale open flight if the card was parked in Done; no-op otherwise
  if (doneColumnId) {
    await handleColumnChange(supabase, cardId, previousColumnId, targetCol.id, doneColumnId)
  }

  await supabase.from('card_activity').insert({
    card_id: cardId,
    actor: user.email ?? 'Team',
    actor_email: user.email ?? null,
    action: 'moved',
    detail:
      `Re-run requested via Copy Tracker: ${flightStartDate} → ${flightEndDate}, moved to "${targetCol.title}"` +
      (note?.trim() ? ` — ${note.trim()}` : ''),
  })

  try {
    await notifyColumnWatchers(supabase, {
      cardId,
      columnId: targetCol.id,
      clientId: card.client_id,
    })
  } catch (err) {
    console.error('Restart Slack notify failed:', err)
  }

  revalidatePath('/board')
  revalidatePath('/copy-tracker')

  return NextResponse.json({ card: updated })
}
