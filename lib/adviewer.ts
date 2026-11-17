const ADVIEWER_COLUMN_MATCH = 'ready for adviewer'

/**
 * Client-side Adviewer publish trigger. Mints a preview link (find-or-create
 * campaign + junction row + card URL) by POSTing to /api/adviewer/generate when
 * a card lands in a "Ready for Adviewer" column.
 *
 * This is the single source of truth for the column-move → Adviewer trigger, so
 * every path that can move a card into that column (drag-and-drop, the card-menu
 * Move / Suggested-move, the multi-select bulk-move bar, and the Card Drawer's
 * Column dropdown) publishes the same way. Previously only drag-and-drop did,
 * so cards moved via any other path silently got no link.
 *
 * Returns the preview URL on success, or null when the destination isn't an
 * Adviewer column or generation failed (best-effort — never surfaced to the user).
 */
export async function maybeGenerateAdviewerLink(
  columns: { id: string; title: string }[],
  cardId: string,
  destColumnId: string,
): Promise<string | null> {
  const title = columns.find((c) => c.id === destColumnId)?.title ?? ''
  if (!title.toLowerCase().includes(ADVIEWER_COLUMN_MATCH)) return null

  try {
    const res = await fetch('/api/adviewer/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: cardId }),
    })
    if (!res.ok) {
      // Swallowing this is how cards reached "Ready for Adviewer" looking fine
      // while never joining a campaign. The route no longer writes a preview URL
      // on failure, so the card simply shows no Adviewer button — log the reason
      // rather than silently returning null (2026-07-24 incident).
      const err = await res.json().catch(() => ({})) as { error?: string; detail?: string }
      console.error('Adviewer generate failed:', res.status, err.error ?? '', err.detail ?? '')
      return null
    }
    const body = await res.json() as { previewUrl?: string }
    return body.previewUrl ?? null
  } catch (err) {
    console.error('Adviewer generate request failed:', err instanceof Error ? err.message : err)
    return null
  }
}
