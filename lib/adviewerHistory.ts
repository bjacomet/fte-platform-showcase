import type { SupabaseClient } from '@supabase/supabase-js'
import type { CampaignCardReview, ReviewRound } from '@/types'

interface SnapshotInput {
  cardId: string
  fileId: string
  fileName: string
  dimensions: string | null
  /** Small retained preview; null for HTML5 / when a thumbnail can't be produced. */
  thumbUrl: string | null
}

interface LinkRow {
  id: string
  client_notes: CampaignCardReview | null
}

/**
 * Freeze the Adviewer change-request round anchored to `fileId` before that
 * card_files row is deleted/replaced. For every campaign link of the card that
 * has pins keyed to the file in `client_notes.file_pins`, this:
 *   - appends a resolved ReviewRound to `client_notes.history` (with the thumbnail),
 *   - marks those pins resolved (adds their IDs to `resolved_pins`),
 *   - drops the live `file_pins[fileId]` / `file_reviews[fileId]` entries so they
 *     don't orphan against a now-deleted card_files id.
 * All writes are awaited — never a bare `void` on the lazy supabase builder.
 * No-op for files that carry no per-size pins.
 */
export async function snapshotCardFileRound(
  supabase: SupabaseClient,
  input: SnapshotInput,
): Promise<void> {
  const { cardId, fileId, fileName, dimensions, thumbUrl } = input

  const { data: links } = await supabase
    .from('adviewer_campaign_cards')
    .select('id, client_notes')
    .eq('card_id', cardId)

  if (!links) return

  for (const link of links as LinkRow[]) {
    const notes = link.client_notes
    if (!notes) continue
    const pins = notes.file_pins?.[fileId]
    if (!pins || pins.length === 0) continue

    const history: ReviewRound[] = Array.isArray(notes.history) ? [...notes.history] : []
    history.push({
      round: history.length + 1,
      file_id: fileId,
      file_name: fileName,
      dimensions,
      thumb_url: thumbUrl,
      pins,
      resolved: true,
      resolved_at: new Date().toISOString(),
      submitted_at: notes.submitted_at,
    })

    const nextFilePins = { ...(notes.file_pins ?? {}) }
    delete nextFilePins[fileId]
    const nextFileReviews = { ...(notes.file_reviews ?? {}) }
    delete nextFileReviews[fileId]

    const snapshotIds = new Set(pins.map((p) => p.id))
    const resolvedSet = new Set(notes.resolved_pins ?? [])
    for (const id of snapshotIds) resolvedSet.add(id)

    // Also drop these pins from the flattened `pins` union. Otherwise, once every
    // size of a multi-file card is snapshotted (file_pins empties), the card-feedback
    // route's "no file_groups → show flattened pins" fallback would resurface the
    // already-archived pins as a phantom card-level "Ad preview" block.
    const nextFlatPins = (notes.pins ?? []).filter((p) => !snapshotIds.has(p.id))

    const nextNotes: CampaignCardReview = {
      ...notes,
      pins: nextFlatPins,
      file_pins: nextFilePins,
      file_reviews: nextFileReviews,
      resolved_pins: Array.from(resolvedSet),
      history,
    }

    await supabase
      .from('adviewer_campaign_cards')
      .update({
        client_notes: nextNotes as unknown as CampaignCardReview,
        updated_at: new Date().toISOString(),
      })
      .eq('id', link.id)
  }
}

interface CardPinRoundInput {
  cardId: string
  /**
   * carousel_slides.id → snapshot only pins anchored to that slide (pin.slide_id).
   * null → snapshot the card-level pins (no slide_id) — the single-social case,
   * where a new graphic supersedes the whole round.
   */
  slideId: string | null
  /** Display label for the round, e.g. "Slide 3" or "Ad graphic". */
  label: string
  /** Small retained preview of the OLD graphic; null when one can't be produced. */
  thumbUrl: string | null
}

/**
 * Sibling of snapshotCardFileRound for pins that live in the flat
 * `client_notes.pins` array (carousel slide pins + single-social card pins)
 * rather than in `file_pins`. Freezes the round before a slide's `image_url`
 * (slide editor save / Box per-slide webhook) or a single-social card's
 * `preview_image_url` is replaced:
 *   - appends a resolved ReviewRound to `client_notes.history`,
 *   - marks the affected pins resolved (`resolved_pins`),
 *   - removes them from the live `pins` array so the new graphic starts clean.
 * All writes are awaited — never a bare `void` on the lazy supabase builder.
 * No-op for links with no matching pins.
 */
export async function snapshotCardPinRound(
  supabase: SupabaseClient,
  input: CardPinRoundInput,
): Promise<void> {
  const { cardId, slideId, label, thumbUrl } = input

  const { data: links } = await supabase
    .from('adviewer_campaign_cards')
    .select('id, client_notes')
    .eq('card_id', cardId)

  if (!links) return

  for (const link of links as LinkRow[]) {
    const notes = link.client_notes
    if (!notes) continue
    const allPins = notes.pins ?? []
    const pins = allPins.filter((p) => (slideId ? p.slide_id === slideId : !p.slide_id))
    if (pins.length === 0) continue

    const history: ReviewRound[] = Array.isArray(notes.history) ? [...notes.history] : []
    history.push({
      round: history.length + 1,
      file_id: slideId ?? 'card',
      file_name: label,
      dimensions: null,
      thumb_url: thumbUrl,
      pins,
      resolved: true,
      resolved_at: new Date().toISOString(),
      submitted_at: notes.submitted_at,
    })

    const snapshotIds = new Set(pins.map((p) => p.id))
    const resolvedSet = new Set(notes.resolved_pins ?? [])
    for (const id of snapshotIds) resolvedSet.add(id)

    const nextNotes: CampaignCardReview = {
      ...notes,
      pins: allPins.filter((p) => !snapshotIds.has(p.id)),
      resolved_pins: Array.from(resolvedSet),
      history,
    }

    await supabase
      .from('adviewer_campaign_cards')
      .update({
        client_notes: nextNotes as unknown as CampaignCardReview,
        updated_at: new Date().toISOString(),
      })
      .eq('id', link.id)
  }
}
