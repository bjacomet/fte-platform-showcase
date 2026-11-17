/**
 * Approval reset for a board card edited from inside Adviewer.
 *
 * A staff edit to a card's copy or graphic invalidates whatever the client signed
 * off on, so the card goes back to pending. Shared by the copy PATCH and the
 * graphic replace so the two can never drift apart.
 *
 * ── The archived-campaign case (team decision, 2026-09-16) ───────────────────
 *
 * `adviewer_am_approve` sets a fully-approved campaign to `status='approved',
 * archived=true` — that is the Lookbook. Editing a card inside such a campaign and
 * resetting only the card would leave an archived, "approved" campaign containing a
 * pending card, with nothing on screen saying so.
 *
 * The dashboard's existing `reset` action (app/api/adviewer/campaign/[id]) cannot be
 * reused for this: it never clears `archived`, so the campaign would stay in the
 * Lookbook, and it resets EVERY card in the campaign and nulls every card's
 * client_notes — which would destroy the client's written feedback on every other
 * card. Nothing else in the codebase un-archives a campaign.
 *
 * So this pulls the campaign back out, narrowly: `archived=false, status='pending'`
 * on the campaign, and a status flip on THIS card's link only. Every other card's
 * status and notes are left exactly as they were.
 *
 * It is self-healing: once the edited card is re-approved, `adviewer_am_approve`
 * sees every board card approved again and rolls the campaign back into the
 * Lookbook on its own. No manual step and no second state to remember.
 *
 * client_notes are PRESERVED, with only the embedded status flipped to pending —
 * mirroring the uploaded-creative PATCH. The client's words are about the creative
 * and are the audit trail; only their verdict is stale.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CardApprovalResetResult {
  /** Links flipped back to pending. */
  linkIds: string[]
  /** Campaigns pulled back out of the Lookbook by this edit. */
  unarchivedCampaignIds: string[]
}

type LinkRow = {
  id: string
  campaign_id: string
  status: string
  location_status: string | null
  client_notes: Record<string, unknown> | null
}

export async function resetCardApproval(
  admin: SupabaseClient,
  cardId: string,
): Promise<CardApprovalResetResult> {
  const now = new Date().toISOString()

  const { data: linkRows, error: linksErr } = await admin
    .from('adviewer_campaign_cards')
    .select('id, campaign_id, status, location_status, client_notes')
    .eq('card_id', cardId)
  if (linksErr) throw new Error(`Reading campaign links failed: ${linksErr.message}`)

  const links = (linkRows ?? []) as LinkRow[]

  // The board card itself. 'none' is the schema default for a card that has not
  // been through client sign-off (schema.sql: approval_status text default 'none').
  const { error: cardErr } = await admin
    .from('cards')
    .update({ approval_status: 'none', updated_at: now })
    .eq('id', cardId)
  if (cardErr) throw new Error(`Resetting the card failed: ${cardErr.message}`)

  // This card's links only. Notes preserved; embedded status flipped.
  const linkIds: string[] = []
  for (const link of links) {
    // The location's answer is review state too (add_location_card_verdicts.sql).
    if (link.status === 'pending' && !link.location_status) continue
    const { location_review: _lr, ...notes } = link.client_notes ?? {}
    void _lr
    const { error } = await admin
      .from('adviewer_campaign_cards')
      .update({ status: 'pending', location_status: null, client_notes: { ...notes, status: 'pending' }, updated_at: now })
      .eq('id', link.id)
    if (error) throw new Error(`Resetting a campaign link failed: ${error.message}`)
    linkIds.push(link.id)
  }

  // Pull any archived (Lookbook) campaign holding this card back into review.
  const campaignIds = [...new Set(links.map((l) => l.campaign_id))]
  const unarchivedCampaignIds: string[] = []
  if (campaignIds.length > 0) {
    const { data: campaigns, error: campErr } = await admin
      .from('adviewer_campaigns')
      .select('id, archived')
      .in('id', campaignIds)
    if (campErr) throw new Error(`Reading campaigns failed: ${campErr.message}`)

    for (const c of (campaigns ?? []) as { id: string; archived: boolean }[]) {
      if (!c.archived) continue
      const { error } = await admin
        .from('adviewer_campaigns')
        .update({ archived: false, status: 'pending', updated_at: now })
        .eq('id', c.id)
      if (error) throw new Error(`Pulling a campaign out of the Lookbook failed: ${error.message}`)
      unarchivedCampaignIds.push(c.id)
    }
  }

  return { linkIds, unarchivedCampaignIds }
}
