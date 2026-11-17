import type { SupabaseClient } from '@supabase/supabase-js'
import type { CampaignCardReview } from '@/types'

/**
 * Reset every campaign link of a board card back to `pending` after a staff edit
 * (carousel slide copy/graphic change made in the Adviewer). A carousel is one
 * review unit, so editing any slide invalidates the whole card's prior sign-off —
 * the client re-reviews. Mirrors the creative/[id] file-edit contract: only rows
 * that were already reviewed are touched; the card, its campaign membership, its
 * token, and its review history are untouched. `client_notes.pins`/history are
 * preserved (they annotate the artwork; the caller handles pin snapshotting on a
 * graphic swap). Returns the number of links reset. Best-effort per row; runs on
 * the service-role client (bypasses writer-only RLS on adviewer_campaign_cards).
 */
export async function resetCardReviewToPending(
  supabase: SupabaseClient,
  cardId: string,
): Promise<number> {
  const { data: links } = await supabase
    .from('adviewer_campaign_cards')
    .select('id, status, location_status, client_notes')
    .eq('card_id', cardId)

  if (!links || links.length === 0) return 0

  let reset = 0
  for (const link of links) {
    // The location's answer is review state too (add_location_card_verdicts.sql).
    if ((link.status as string) === 'pending' && !link.location_status) continue
    const notes = (link.client_notes ?? {}) as CampaignCardReview
    const { location_review: _lr, ...kept } = notes
    void _lr
    const { error } = await supabase
      .from('adviewer_campaign_cards')
      .update({ status: 'pending', location_status: null, client_notes: { ...kept, status: 'pending' }, updated_at: new Date().toISOString() })
      .eq('id', link.id)
    if (!error) reset += 1
  }
  return reset
}
