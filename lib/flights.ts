import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Handles card_flights side-effects when a card's column changes.
 *
 * - Moving INTO the Done column   → inserts a new card_flights row (triggered_by: 'column_move')
 * - Moving OUT OF the Done column → closes the open flight by setting went_dark_at
 *
 * Call this after successfully persisting the column_id change to `cards`.
 * This is the single source of truth for flight logic — used by both the
 * drag-and-drop handler (Board.tsx) and the drawer save handler (CardDrawer.tsx).
 */
export async function handleColumnChange(
  supabase: SupabaseClient,
  cardId: string,
  previousColumnId: string,
  newColumnId: string,
  doneColumnId: string,
): Promise<void> {
  if (newColumnId === doneColumnId && previousColumnId !== doneColumnId) {
    // Card moved INTO Done → open a new flight
    await supabase.from('card_flights').insert({
      card_id: cardId,
      previous_column_id: previousColumnId,
      went_live_at: new Date().toISOString(),
      triggered_by: 'column_move',
    })

    // Re-entering Done completes a Copy Tracker re-run request — clear the
    // flag here so every path (drag, drawer save, Brenda) resolves it.
    // The filter makes this a no-op for normal Done moves.
    await supabase
      .from('cards')
      .update({ restart_requested_at: null, restart_requested_by: null, restart_note: null })
      .eq('id', cardId)
      .not('restart_requested_at', 'is', null)
  } else if (previousColumnId === doneColumnId && newColumnId !== doneColumnId) {
    // Card moved OUT OF Done → close the open flight
    const { data: openFlight } = await supabase
      .from('card_flights')
      .select('id')
      .eq('card_id', cardId)
      .is('went_dark_at', null)
      .eq('voided', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (openFlight) {
      await supabase
        .from('card_flights')
        .update({ went_dark_at: new Date().toISOString() })
        .eq('id', openFlight.id)
    }
  }
}
