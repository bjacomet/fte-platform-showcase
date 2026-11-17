/**
 * Shared select strings for card queries.
 *
 * BOARD_CARD_SELECT — slim shape for the kanban board. Matches the `BoardCard`
 * type in types/index.ts. Keep the two in sync. Large text fields (description,
 * creative_brief, fb_body_text, revisions, …) are deliberately excluded so the
 * board payload stays small with hundreds of cards. The scalar fields
 * flight_start_date + archived are kept because CookieBriefModal derives
 * deadlines/urgency from the board's card props (no extra fetch).
 *
 * FULL_CARD_SELECT — everything, including the full client record. Used when a
 * card is opened for editing (CardDrawer) and before duplicating a card.
 * IMPORTANT: never open CardDrawer with a slim BoardCard — saving would null
 * out every field that wasn't fetched.
 */
export const BOARD_CARD_SELECT =
  'id, title, client_id, column_id, position, media_type, assignee_id, ' +
  'approval_status, work_status, preview_image_url, adpiler_preview_url, first_draft_deadline, ' +
  'flight_start_date, archived, is_pending, pre_pending_column_id, ' +
  'restart_requested_at, clients(id, name)'

export const FULL_CARD_SELECT = '*, clients(*)'

// Atlas board — same slim shape as the main board plus atlas_location_id (the Atlas
// board groups by location, not column_id). Cards are still opened full via
// FULL_CARD_SELECT when the drawer opens.
//
// The card_files join is Atlas-ONLY and deliberately not added to
// BOARD_CARD_SELECT. Atlas creatives are MP4s, and preview_image_url is a single
// scalar that is not reliably populated for video cards — without the attached
// file the board cannot render a thumbnail at all, which is why every video
// card showed a blank box. Only the columns a thumbnail needs are selected. The
// main board carries hundreds of cards and must stay slim; Atlas carries ~62.
export const ATLAS_BOARD_CARD_SELECT =
  BOARD_CARD_SELECT + ', atlas_location_id, atlas_column_id, atlas_quarter, atlas_year, display_build_link, card_files(id, file_url, file_type, created_at)'

// Same select without the quarter columns. The Atlas page retries with this when
// add_atlas_card_quarter.sql has not been applied yet, so a deploy that lands before
// the migration degrades to "no Quarter filter" instead of an empty board.
export const ATLAS_BOARD_CARD_SELECT_NO_QUARTER = ATLAS_BOARD_CARD_SELECT.replace(' atlas_quarter, atlas_year,', '')
