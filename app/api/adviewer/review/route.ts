import { createAdminClient } from '@/lib/supabase/server'
import { resolveReviewToken, rollUpCampaignFromScopes } from '@/lib/adviewerReviewToken'
import type { AdviewerStatus, CampaignCardReview, ReviewPin } from '@/types'

// Public, token-gated write path for the Adviewer client review.
//
// The review page (/adviewer/c/[token]) is viewed by clients with no login — the
// anon Supabase role has no write policy on adviewer_campaign_* (writes are
// is_writer()-only), so a client dropping pins or submitting feedback from the
// browser was silently rejected by RLS and their notes vanished. Only logged-in
// FTE writers could leave notes that stuck.
//
// This route writes with the service-role client after validating the token and
// confirming the target row is within that token's authority, so anyone with the
// link can leave notes without opening the tables to arbitrary anon writes. Same
// trust model as get_client_review / the review portal: holding the link is the
// authorization.
//
// TWO KINDS OF TOKEN. A campaign token speaks for the whole campaign. A scope
// token speaks for ONE Atlas location, and the difference is enforced here rather
// than in the page:
//
//   * a card write must target a card belonging to that location,
//   * a campaign-file write is rejected outright (files carry no location, so a
//     scoped link never shows them),
//   * `kind: 'campaign'` writes the LOCATION'S status onto its scope row and
//     lets the campaign follow only when every location agrees.
//   * a card verdict from a location goes to location_status and
//     client_notes.location_review — never to status or corporate's reviewer,
//     note and per-size approvals. Pins share one list but a location only
//     adds or removes its own (mergeLocationNotes / mergePins).
//
// Before this, one location approving its 4 creatives stamped the whole 22-
// location campaign `approved`, and one location asking for a change flipped all
// 22 to `needs_revision`.

const STATUSES = new Set(['pending', 'approved', 'needs_revision'])

interface Body {
  token?: string
  kind?: 'card' | 'file' | 'campaign'
  id?: string
  client_notes?: unknown
  status?: string
}

export async function POST(req: Request) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { token, kind, id, client_notes, status } = body
  if (!token || !kind) return Response.json({ error: 'Missing token or kind' }, { status: 400 })
  if (status !== undefined && !STATUSES.has(status)) {
    return Response.json({ error: 'Invalid status' }, { status: 400 })
  }

  const admin = createAdminClient()

  const resolved = await resolveReviewToken(admin, token)
  if (!resolved) return Response.json({ error: 'Invalid token' }, { status: 404 })
  const { campaignId, scope } = resolved

  const now = new Date().toISOString()

  if (kind === 'campaign') {
    if (status === undefined) return Response.json({ error: 'Missing status' }, { status: 400 })

    // A location's review writes the location's own row. The campaign moves on its
    // own only when a location asks for changes (to surface it to staff); staff
    // file an all-approved campaign themselves — see rollUpCampaignFromScopes.
    if (scope) {
      const { error } = await admin
        .from('adviewer_campaign_scopes')
        .update({ status, updated_at: now })
        .eq('id', scope.id)
      if (error) return Response.json({ error: error.message }, { status: 500 })
      const campaignStatus = await rollUpCampaignFromScopes(admin, campaignId)
      return Response.json({ ok: true, scope: status, campaign: campaignStatus })
    }

    const { error } = await admin
      .from('adviewer_campaigns')
      .update({ status, updated_at: now })
      .eq('id', campaignId)
    if (error) return Response.json({ error: error.message }, { status: 500 })
    return Response.json({ ok: true })
  }

  if (!id) return Response.json({ error: 'Missing id' }, { status: 400 })

  // Uploaded campaign files belong to the campaign as a whole and carry no
  // location, so a scoped link is never shown one and must not write to one.
  if (kind === 'file' && scope) {
    return Response.json({ error: 'Not available on a location link' }, { status: 403 })
  }

  if (kind === 'file') {
    const { data: row } = await admin
      .from('adviewer_campaign_files')
      .select('id')
      .eq('id', id)
      .eq('campaign_id', campaignId)
      .maybeSingle()
    if (!row) return Response.json({ error: 'Not found in campaign' }, { status: 404 })
  } else {
    // Confirm the target row belongs to this campaign before writing — prevents a
    // link holder from editing another campaign's rows by guessing an id — and,
    // on a scope token, that the card is this location's.
    const { data: row } = await admin
      .from('adviewer_campaign_cards')
      .select('id, card:cards(atlas_location_id)')
      .eq('id', id)
      .eq('campaign_id', campaignId)
      .maybeSingle()
    if (!row) return Response.json({ error: 'Not found in campaign' }, { status: 404 })

    if (scope) {
      const card = (row as unknown as { card: { atlas_location_id: string | null } | null }).card
      if (!card || card.atlas_location_id !== scope.atlasLocationId) {
        return Response.json({ error: 'Not found in campaign' }, { status: 404 })
      }

      // A location's answer on a card is ITS answer: location_status plus
      // client_notes.location_review. Corporate's status, reviewer, note and
      // per-size approvals are carried over untouched from the stored row.
      const { data: current } = await admin
        .from('adviewer_campaign_cards')
        .select('client_notes')
        .eq('id', id)
        .maybeSingle()
      const update: Record<string, unknown> = { updated_at: now }
      if (status !== undefined) update.location_status = status
      if (client_notes !== undefined || status !== undefined) {
        update.client_notes = mergeLocationNotes(
          (current?.client_notes ?? null) as CampaignCardReview | null,
          (client_notes ?? null) as CampaignCardReview | null,
          status as AdviewerStatus | undefined,
        )
      }
      const { error } = await admin.from('adviewer_campaign_cards').update(update).eq('id', id)
      if (error) return Response.json({ error: error.message }, { status: 500 })
      return Response.json({ ok: true })
    }
  }

  const table = kind === 'card' ? 'adviewer_campaign_cards' : 'adviewer_campaign_files'

  const update: Record<string, unknown> = { updated_at: now }
  if (client_notes !== undefined) update.client_notes = client_notes
  if (status !== undefined) update.status = status

  // Corporate's page rebuilds client_notes from its own fields and from the pins
  // it loaded at page open, which would drop the location's answer stored beside
  // them — and any pin the location added since. Carry both over from the stored
  // row: the location's answer as is, and its pins via mergeCorporatePins.
  if (kind === 'card' && client_notes && typeof client_notes === 'object') {
    const { data: current } = await admin
      .from('adviewer_campaign_cards')
      .select('client_notes')
      .eq('id', id)
      .maybeSingle()
    const stored = (current?.client_notes ?? null) as CampaignCardReview | null
    const incoming = client_notes as CampaignCardReview
    const merged: CampaignCardReview = { ...incoming }
    if (stored?.location_review) merged.location_review = stored.location_review
    if (incoming.pins !== undefined || stored?.pins?.some((p) => p.by === 'location')) {
      merged.pins = mergeCorporatePins(stored?.pins, incoming.pins)
    }
    if (incoming.file_pins !== undefined || hasLocationFilePins(stored?.file_pins)) {
      merged.file_pins = mergeCorporateFilePins(stored?.file_pins, incoming.file_pins)
    }
    update.client_notes = merged
  }

  const { error } = await admin.from(table).update(update).eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}

// Corporate keeps its fields; the location's go under location_review. Pins are
// one shared list for designers, but each side only controls its own (mergePins).
// Pins: the stored pins that are NOT the location's (corporate's, or from before
// tagging) are kept exactly as stored — the location page never sees them, so
// it can't have removed them. Everything the location sent becomes its pin set,
// tagged by:'location'.
function mergePins(stored: ReviewPin[] | undefined, incoming: ReviewPin[] | undefined): ReviewPin[] {
  const kept = (stored ?? []).filter((p) => p.by !== 'location')
  const keptIds = new Set(kept.map((p) => p.id))
  const mine = (incoming ?? []).filter((p) => !keptIds.has(p.id)).map((p) => ({ ...p, by: 'location' as const }))
  return [...kept, ...mine]
}

// The reverse of mergePins, for corporate's link: the stored location pins are
// kept exactly as stored (the location owns them; corporate's page may be stale
// and not have them), and corporate's own pins are whatever it sent.
function mergeCorporatePins(stored: ReviewPin[] | undefined, incoming: ReviewPin[] | undefined): ReviewPin[] {
  const kept = (stored ?? []).filter((p) => p.by === 'location')
  const keptIds = new Set(kept.map((p) => p.id))
  const mine = (incoming ?? []).filter((p) => p.by !== 'location' && !keptIds.has(p.id))
  return [...mine, ...kept]
}

function mergeCorporateFilePins(
  stored: Record<string, ReviewPin[]> | undefined,
  incoming: Record<string, ReviewPin[]> | undefined,
): Record<string, ReviewPin[]> {
  const out: Record<string, ReviewPin[]> = {}
  for (const key of new Set([...Object.keys(stored ?? {}), ...Object.keys(incoming ?? {})])) {
    const merged = mergeCorporatePins(stored?.[key], incoming?.[key])
    if (merged.length) out[key] = merged
  }
  return out
}

function hasLocationFilePins(filePins: Record<string, ReviewPin[]> | undefined): boolean {
  return Object.values(filePins ?? {}).some((pins) => (pins ?? []).some((p) => p.by === 'location'))
}

function mergeFilePins(
  stored: Record<string, ReviewPin[]> | undefined,
  incoming: Record<string, ReviewPin[]> | undefined,
): Record<string, ReviewPin[]> {
  const out: Record<string, ReviewPin[]> = {}
  for (const key of new Set([...Object.keys(stored ?? {}), ...Object.keys(incoming ?? {})])) {
    const merged = mergePins(stored?.[key], incoming?.[key])
    if (merged.length) out[key] = merged
  }
  return out
}

function mergeLocationNotes(
  stored: CampaignCardReview | null,
  incoming: CampaignCardReview | null,
  status: AdviewerStatus | undefined,
): CampaignCardReview {
  const base = stored ?? ({ reviewer: '' } as CampaignCardReview)
  if (!incoming) {
    return {
      ...base,
      location_review: { ...(base.location_review ?? { status: 'pending' }), status: status ?? base.location_review?.status ?? 'pending' },
    }
  }
  return {
    ...incoming,
    pins: mergePins(base.pins, incoming.pins),
    file_pins: mergeFilePins(base.file_pins, incoming.file_pins),
    // Corporate's answer, as stored.
    reviewer: base.reviewer ?? '',
    submitted_at: base.submitted_at,
    status: base.status,
    note: base.note,
    file_reviews: base.file_reviews,
    caption: base.caption,
    // Designer-owned state the location page must not regress.
    resolved_pins: base.resolved_pins ?? incoming.resolved_pins,
    history: base.history ?? incoming.history,
    location_review: {
      status: status ?? incoming.status ?? 'pending',
      reviewer: incoming.reviewer,
      note: incoming.note,
      submitted_at: incoming.submitted_at,
      file_reviews: incoming.file_reviews,
    },
  }
}
