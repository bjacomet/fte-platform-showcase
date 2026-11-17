import type { Card, AtlasBoardCard } from '@/types'

// A full Card fetched on update always belongs to a location on this board, so
// atlas_location_id is present at runtime — narrow it to the slim board shape.
//
// `prev` is the board card being replaced, and it is NOT optional decoration:
// the drawer refetches with FULL_CARD_SELECT ('*, clients(*)'), which has no
// card_files join, so a card rebuilt from that row alone would come back with
// no attached files and the thumbnail would blank out on every save. Carry the
// files we already had across; handleUpdated refreshes them separately.
export function toAtlasBoardCard(c: Card, prev?: AtlasBoardCard): AtlasBoardCard {
  return {
    id: c.id,
    title: c.title,
    client_id: c.client_id,
    column_id: c.column_id,
    atlas_location_id: c.atlas_location_id,
    position: c.position,
    media_type: c.media_type,
    assignee_id: c.assignee_id,
    approval_status: c.approval_status,
    work_status: c.work_status,
    preview_image_url: c.preview_image_url,
    adpiler_preview_url: c.adpiler_preview_url,
    first_draft_deadline: c.first_draft_deadline,
    flight_start_date: c.flight_start_date,
    archived: c.archived,
    is_pending: c.is_pending,
    pre_pending_column_id: c.pre_pending_column_id,
    restart_requested_at: c.restart_requested_at,
    display_build_link: c.display_build_link,
    atlas_column_id: c.atlas_column_id ?? prev?.atlas_column_id ?? null,
    // Same reasoning as atlas_column_id: a Card that did not select these must not
    // blank a card's quarter, or a drawer edit would drop it out of its quarter view.
    atlas_quarter: c.atlas_quarter ?? prev?.atlas_quarter ?? null,
    atlas_year: c.atlas_year ?? prev?.atlas_year ?? null,
    card_files: prev?.card_files,
    clients: c.clients ? { id: c.clients.id, name: c.clients.name } : null,
  }
}
