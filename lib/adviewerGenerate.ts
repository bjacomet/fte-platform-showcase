import type { SupabaseClient } from '@supabase/supabase-js'

export type GenerateResult =
  | { ok: true; campaignId: string; token: string; previewUrl: string }
  | { ok: false; status: number; error: string }

/**
 * Core Adviewer publish logic: find-or-create the client's open campaign, attach
 * the card idempotently, write the whole-campaign link to cards.adpiler_preview_url,
 * and (for carousels) populate each slide's #slide-N deep link.
 *
 * Client-agnostic — works with either a session-scoped Supabase client (the
 * user-facing /api/adviewer/generate route) or the service-role admin client
 * (the /api/adviewer/reconcile cron backstop). This is the single source of
 * truth for generation so the interactive path and the cron can't drift.
 */
export async function generateAdviewerForCard(
  supabase: SupabaseClient,
  cardId: string,
): Promise<GenerateResult> {
  const { data: card, error: cardError } = await supabase
    .from('cards')
    .select('id, title, client_id, media_type, adviewer_standalone, clients(id, name)')
    .eq('id', cardId)
    .single()

  if (cardError || !card) {
    return { ok: false, status: 404, error: 'Card not found' }
  }

  const clientId = card.client_id ?? null
  const clientsRaw = card.clients as unknown as { name: string } | { name: string }[] | null
  const clientName = (Array.isArray(clientsRaw) ? clientsRaw[0]?.name : clientsRaw?.name) ?? 'Client'

  // Standalone one-off cards route to the client's persistent "Design Requests"
  // bucket (month-agnostic); everything else lands in the current month's campaign.
  const standalone = card.adviewer_standalone === true

  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)

  let campaignId: string
  let campaignToken: string

  const lookup = supabase
    .from('adviewer_campaigns')
    .select('id, token')
    .eq('client_id', clientId)
    // Reuse the client's open campaign whatever the client has already said about it.
    // Matching only 'pending' meant that as soon as a client requested changes the
    // campaign flipped to 'needs_revision', dropped out of this lookup, and the next
    // published card silently created a SECOND campaign for the same client/month.
    // 'approved' stays excluded on purpose: the client-portal review path writes
    // status without archiving, so an approved-but-unarchived campaign exists and must
    // not quietly absorb creative nobody has reviewed.
    .in('status', ['pending', 'needs_revision'])
    .eq('kind', standalone ? 'design_requests' : 'monthly')
    // Never re-attach to an archived (Lookbook) campaign — a re-published card would
    // otherwise resurface a campaign already sent to the Lookbook. Fall through to
    // creating a fresh campaign instead.
    .eq('archived', false)
    .order('created_at', { ascending: false })
    .limit(1)
  const { data: existing } = await (standalone ? lookup : lookup.gte('created_at', monthStart.toISOString())).maybeSingle()

  if (existing) {
    campaignId = existing.id
    campaignToken = existing.token
  } else {
    const monthLabel = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    const campaignTitle = standalone ? `${clientName} — Design Requests` : `${clientName} — ${monthLabel}`

    const { data: created, error: createError } = await supabase
      .from('adviewer_campaigns')
      .insert({ title: campaignTitle, client_id: clientId, status: 'pending', kind: standalone ? 'design_requests' : 'monthly' })
      .select('id, token')
      .single()

    if (createError || !created) {
      return { ok: false, status: 500, error: createError?.message ?? 'Failed to create campaign' }
    }

    campaignId = created.id
    campaignToken = created.token
  }

  // Add card to campaign (idempotent — unique constraint on campaign_id + card_id)
  const { data: existingCard } = await supabase
    .from('adviewer_campaign_cards')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('card_id', cardId)
    .maybeSingle()

  if (!existingCard) {
    const { count } = await supabase
      .from('adviewer_campaign_cards')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)

    const { error: linkError } = await supabase.from('adviewer_campaign_cards').insert({
      campaign_id: campaignId,
      card_id: cardId,
      position: (count ?? 0),
      status: 'pending',
    })

    // Fail loudly: writing the card's preview URL below while this insert failed is
    // what produced "link opens a campaign without my creative in it" (2026-07-24).
    if (linkError) {
      return { ok: false, status: 500, error: `Failed to add card to campaign: ${linkError.message}` }
    }
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://your-app.vercel.app'
  const previewUrl = `${baseUrl}/adviewer/c/${campaignToken}`

  const { error: urlError } = await supabase
    .from('cards')
    .update({ adpiler_preview_url: previewUrl, updated_at: new Date().toISOString() })
    .eq('id', cardId)

  if (urlError) {
    return { ok: false, status: 500, error: `Failed to write preview URL to card: ${urlError.message}` }
  }

  // Per-slide deep links for carousels ({previewUrl}#slide-{position}). Non-fatal —
  // the card-level link (the one the board shows) is already written; only the
  // per-slide deep links would be missing.
  if (card.media_type === 'Carousel Ad') {
    const { data: slides } = await supabase
      .from('carousel_slides')
      .select('id, position')
      .eq('card_id', cardId)

    const slideResults = await Promise.all(
      (slides ?? []).map((s: { id: string; position: number }) =>
        supabase
          .from('carousel_slides')
          .update({ adpiler_preview_url: `${previewUrl}#slide-${s.position}`, updated_at: new Date().toISOString() })
          .eq('id', s.id)
      )
    )

    const slideErrors = slideResults.filter((r) => r.error)
    if (slideErrors.length > 0) {
      console.error('Failed to write per-slide Adviewer deep links:', slideErrors.map((r) => r.error?.message).join('; '))
    }
  }

  return { ok: true, campaignId, token: campaignToken, previewUrl }
}
