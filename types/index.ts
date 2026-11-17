// ── Powersports Inventory ──────────────────────────────────────────────────

export type PsCategory = 'motorcycle' | 'atv' | 'utv' | 'watercraft' | 'snowmobile' | 'other'
export type PsCondition = 'new' | 'used'
export type PsUnitStatus = 'active' | 'sold'
export type PsPlatform = 'dealerspike' | 'dx1'

export interface PsDealer {
  id: string
  name: string
  website_url: string
  platform: PsPlatform
  active: boolean
  created_at: string
}

export interface PsInventoryUnit {
  id: string
  dealer_id: string
  stock_number: string
  vin: string | null
  year: number | null
  make: string | null
  model: string | null
  trim: string | null
  category: PsCategory | null
  condition: PsCondition | null
  price: number | null
  msrp: number | null
  mileage: number | null
  color: string | null
  description: string | null
  images: string[]
  listing_url: string | null
  days_on_lot: number
  first_seen_date: string | null
  last_seen_date: string | null
  status: PsUnitStatus
  created_at: string
  updated_at: string
  /** Joined from ps_dealers — present when fetched with dealer data */
  ps_dealers?: Pick<PsDealer, 'id' | 'name'> | null
}

// ── Clients ────────────────────────────────────────────────────────────────

export interface ClientFbAdAccount {
  id: string
  client_id: string
  account_id: string   // act_XXXXXXXXX format
  label: string | null
  active: boolean
  created_at: string
}

export interface Client {
  id: string
  name: string
  abbreviation: string | null
  adpiler_campaign_code: string | null
  fb_page_logo_url: string | null
  utm_config: Record<string, unknown> | null
  calendar_share_token: string | null
  /**
   * Per-client token used to generate the review portal URL (`/review/<token>`).
   * A single token grants access to **all** of the client's pending cards.
   * This is different from `Card.approval_token`, which is a per-card token
   * that is generated but not currently used for portal routing.
   */
  review_token: string | null
  active: boolean
  created_at: string
  /** Brand voice, target audience, tone, key messages — used by Brenda for copy evaluation */
  brand_notes: string | null
  /** Box file ID of the client's brand guide PDF — Brenda reads this directly */
  box_brand_file_id: string | null
  /** Client's website URL — Brenda extracts live brand tokens (colors, fonts) from this */
  brand_website_url: string | null
  /** Facebook Ad Account ID (format: act_123456789) — required to publish ads via Marketing API */
  fb_ad_account_id: string | null
  /** Designer who owns this client (display name, e.g. "the designer"). Drives the designer pill on board cards. */
  designer_name?: string | null
  /** That designer's login email — matched against the signed-in user for the "My clients" filter. */
  designer_email?: string | null
  /** Client priority tier; new cards for this client default to it. */
  tier?: 'T1' | 'T2' | 'T3' | null
}

export interface ClientCalendarMonth {
  client_id: string
  year: number
  month: number
  box_link_url: string | null
  updated_at: string
}

export interface Column {
  id: string
  title: string
  position: number
  cards?: Card[]
}

// ── Messenger Ad welcome message ─────────────────────────────────────────────
// The creative-level click-to-Messenger welcome message (page_welcome_message).
// Stored on cards.messenger_welcome as the `{ message: ... }` object and copied
// into Ads Manager by hand — no Facebook API involvement.
export type MessengerButton =
  | { type: 'web_url'; title: string; url: string }
  | { type: 'postback'; title: string; payload: string }

export interface MessengerQuickReply {
  content_type: 'text'
  title: string
  payload: string
}

export interface MessengerGenericElement {
  title: string
  subtitle?: string
  image_url?: string
  buttons?: MessengerButton[]
}

export interface MessengerMessage {
  text?: string
  quick_replies?: MessengerQuickReply[]
  attachment?: {
    type: 'template'
    payload:
      | { template_type: 'button'; text: string; buttons: MessengerButton[] }
      | { template_type: 'generic'; elements: MessengerGenericElement[] }
  }
}

export interface MessengerWelcome {
  message: MessengerMessage
  // Preview-only pre-scripted auto-replies, keyed by button / quick-reply title.
  // NOT part of the copyable page_welcome_message JSON (Meta's schema has no field
  // for them) — they drive the editor's interactive preview and document what each
  // button should answer when the flow is rebuilt in the Ads Manager chat builder.
  replies?: Record<string, string>
}

// ── Instant Experience (Facebook full-screen canvas ad) ─────────────────────────
// Modeled on MessengerWelcome: a structured JSON blob stored on the card
// (cards.instant_experience), built in a dedicated drawer editor, previewed in a
// phone-framed Adviewer mockup, and rebuilt by hand in Ads Manager (no Meta API).
// The OUTER trigger ad reuses the card's existing fb_* copy + preview_image_url;
// this models only the INNER experience — an ordered list of vertical blocks.

export type IEBlockType = 'header' | 'text' | 'image' | 'image_carousel' | 'video' | 'button'

interface IEBlockBase {
  id: string
  type: IEBlockType
}

/** First thing seen — a full-bleed image or muted-autoplay video. */
export interface IEHeaderBlock extends IEBlockBase {
  type: 'header'
  media_kind: 'image' | 'video'
  media_url: string | null
  file_name?: string | null
}

/** A copy section, ≤500 chars (IE_TEXT_MAX). */
export interface IETextBlock extends IEBlockBase {
  type: 'text'
  text: string
}

/** A static image, optionally tap-to-link. */
export interface IEImageBlock extends IEBlockBase {
  type: 'image'
  media_url: string | null
  file_name?: string | null
  link_url?: string | null
}

/** A swipeable strip of 2–10 images (no per-card copy/CTA, per Meta). */
export interface IECarouselBlock extends IEBlockBase {
  type: 'image_carousel'
  images: { id: string; url: string | null; file_name?: string | null }[]
}

/** A body video, muted-autoplay in view. */
export interface IEVideoBlock extends IEBlockBase {
  type: 'video'
  media_url: string | null
  file_name?: string | null
}

/** A CTA button (label ≤30 chars, IE_BUTTON_LABEL_MAX) linking to a URL. */
export interface IEButtonBlock extends IEBlockBase {
  type: 'button'
  label: string
  url: string | null
}

export type IEBlock =
  | IEHeaderBlock
  | IETextBlock
  | IEImageBlock
  | IECarouselBlock
  | IEVideoBlock
  | IEButtonBlock

export interface InstantExperience {
  blocks: IEBlock[]
  /** Optional starter-template name the team seeded from (Meta's 5 templates). */
  template?: string
}

// Editor limits (the numbers the editor validates against; see build-spec §1).
export const IE_TEXT_MAX = 500
export const IE_BUTTON_LABEL_MAX = 30
export const IE_CAROUSEL_MIN = 2
export const IE_CAROUSEL_MAX = 10
export const IE_BLOCK_MAX = 20 // Meta's max components per Instant Experience

export const IE_BLOCK_LABELS: Record<IEBlockType, string> = {
  header: 'Header (image/video)',
  text: 'Text',
  image: 'Image (single)',
  image_carousel: 'Image carousel (swipe)',
  video: 'Video',
  button: 'Button',
}

// One-line "what is this for?" hint shown under each add-block option in the editor.
export const IE_BLOCK_HINTS: Record<IEBlockType, string> = {
  header: 'First thing seen — one image or a muted-autoplay video.',
  text: 'A short copy block (≤500 chars). Keep it tight — mobile readers skim.',
  image: 'One static image (fills the frame). Can link somewhere.',
  image_carousel: 'A swipeable set of 2–10 images. Use when you have several to show.',
  video: 'A body video (muted autoplay). Keep ≤60s at 1080p to fit the 50 MB cap.',
  button: 'A tappable CTA. Needs a label (≤30 chars) and a destination URL.',
}

export interface CarouselSlide {
  id: string
  card_id: string
  position: number
  headline: string | null
  subheadline: string | null
  link_description: string | null
  display_link: string | null
  graphic_headline: string | null
  graphic_subhead: string | null
  landing_page_url: string | null
  image_url: string | null
  adpiler_preview_url: string | null
  created_at: string
  updated_at: string
}

export interface Card {
  id: string
  title: string
  client_id: string | null
  /**
   * Kanban column for the main FTE board. Null for Atlas cards — they live on the
   * Atlas-only board where the column IS the location (see atlas_location_id).
   */
  column_id: string | null
  /**
   * Atlas center this card belongs to (atlas_locations.id). When set, the card is an
   * Atlas card: it renders on the Atlas board (/atlas → Board tab) grouped by location
   * and is EXCLUDED from the main board query (app/board/page.tsx).
   */
  atlas_location_id: string | null
  /** Atlas board stage column (atlas_board_columns.id). Atlas cards only; see add_atlas_board_stages.sql. */
  atlas_column_id?: string | null
  /** Quarter + year an Atlas card was imported for (add_atlas_card_quarter.sql). Null on non-Atlas cards and archived Atlas cards. */
  atlas_quarter?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | null
  atlas_year?: number | null
  media_type: TemplateOption | null
  assignee_id: string | null
  description: string | null
  position: number
  /**
   * Per-card UUID token generated on card creation.
   * Not currently used for portal routing — the review portal is keyed on
   * `Client.review_token` instead, which covers all of a client's cards at once.
   */
  approval_token: string | null
  approval_status: ApprovalStatus
  /** Internal production state (In Design → Internal Review → Pending Approval → Complete). Separate from client approval_status. null = not started. */
  work_status: WorkStatus | null
  archived: boolean
  landing_page_url: string | null
  utm_campaign: string | null
  utm_channel: string | null
  creative_name: string | null
  flight_month: number | null
  flight_start_date: string | null
  flight_end_date: string | null
  box_folder_id: string | null
  ttd_ad_group_id: string | null
  ttd_ad_group_ids: string[] | null
  client_comments: string | null
  creative_brief: string | null
  fb_page_name: string | null
  fb_body_text: string | null
  fb_headline: string | null
  fb_subheadline: string | null
  fb_link_description: string | null
  fb_cta: string | null
  calendar_only: boolean
  preview_image_url: string | null
  source_card_id: string | null
  run_number: number
  adpiler_preview_url: string | null
  /** When true, publishing to Adviewer routes this card to the client's persistent "Design Requests" bucket instead of the monthly campaign (one-off / not part of a campaign). */
  adviewer_standalone: boolean
  /** UUID of the ps_inventory_units row this card was created to advertise */
  inventory_unit_id: string | null
  /** Click-to-Messenger welcome message JSON for Messenger Ad cards. Copied into Ads Manager by hand. */
  messenger_welcome: MessengerWelcome | null
  /** Instant Experience inner-canvas blocks (Instant Experience cards). Copied into Ads Manager by hand. See add_instant_experience.sql. */
  instant_experience: InstantExperience | null
  // ── Trello template fields ────────────────────────────────────────────────
  /** Priority tier: T1, T2, or T3 */
  tier: 'T1' | 'T2' | 'T3' | null
  /** Internal deadline for first creative draft */
  first_draft_deadline: string | null
  /** Link to the full production build (e.g. Box folder, staging URL) */
  build_link: string | null
  /**
   * Box link to the display / HTML5 build cut from this creative.
   * Reference only — deliberately NOT resolved to a box_folder_id and not
   * synced, because box_folder_id is singular and drives both the file-sync
   * webhook and the TTD export. See supabase/add_display_build_link.sql.
   */
  display_build_link: string | null
  /** Primary heading / focus text for the creative */
  heading: string | null
  /** Subheading text for the creative */
  subheading: string | null
  /** Optional button / CTA text on the creative (Display) */
  button_text: string | null
  /** Caption / voiceover copy (Video / Reel / Audio) */
  caption: string | null
  /** Boost budget for organic posts */
  boost_budget: string | null
  /** Link to companion display banner (Audio) */
  companion_banner_link: string | null
  /** Event description (FB Event Cover) */
  event_description: string | null
  /** Revisions and change request notes */
  revisions: string | null
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Controls visibility in the client portal.
   * null = not shown | 'pending_approval' = Awaiting Approval section | 'running' = Currently Running section
   * 'archive_review' = Past Creatives section (shown even if card is archived)
   * 'running' is also auto-set by active flight in card_flights (went_live_at set, went_dark_at null, not voided)
   */
  client_portal_status: 'pending_approval' | 'running' | 'archive_review' | null
  /** True while the card is parked in the Pending column via the quick toggle */
  is_pending: boolean
  /** The column_id to return to when the pending toggle is turned off */
  pre_pending_column_id: string | null
  /** Facebook campaign ID written back after successful publish via Marketing API */
  fb_campaign_id: string | null
  /** Facebook ad ID written back after successful publish via Marketing API */
  fb_ad_id: string | null
  /** Timestamp when this card was last published to Facebook Ads */
  fb_published_at: string | null
  /**
   * Re-run request from the Copy Tracker (same-card restart, no clone).
   * Set by POST /api/cards/restart; cleared when the card re-enters Done.
   */
  restart_requested_at: string | null
  /** Email of the account manager who requested the re-run */
  restart_requested_by: string | null
  /** Optional note from the requester for whoever restarts the campaign */
  restart_note: string | null
  /**
   * Durable reference to another card whose creative this card reuses ("use the
   * same image as that ad"). Stored as the target card's permanent id, so it
   * never rots the way a pasted /review or /card URL does. See add_card_reference.sql.
   */
  referenced_card_id: string | null
  created_at: string
  updated_at: string
  clients?: Client | null
  carousel_slides?: CarouselSlide[]
  /** Joined target of referenced_card_id — populated by CardDrawer for rendering the reference chip. */
  referenced_card?: Pick<Card, 'id' | 'title' | 'preview_image_url' | 'archived'> | null
}

/**
 * Slim card shape loaded for the kanban board (see BOARD_CARD_SELECT in
 * lib/cardQueries.ts — keep the two in sync). Contains only what board cards
 * render and what drag/filter logic needs.
 *
 * Never pass a BoardCard to CardDrawer: it initializes its form from the card,
 * so saving from a slim card would null out every unfetched field. Fetch the
 * full Card first (Board.openCard does this).
 */
export type BoardCard = Pick<Card,
  | 'id' | 'title' | 'client_id' | 'position' | 'media_type'
  | 'assignee_id' | 'approval_status' | 'work_status' | 'preview_image_url'
  | 'adpiler_preview_url' | 'first_draft_deadline' | 'flight_start_date'
  | 'archived' | 'is_pending' | 'pre_pending_column_id' | 'restart_requested_at'
> & {
  // The main board never loads Atlas cards (they're excluded by the board query),
  // so column_id is always present here — kept non-null so board logic stays clean.
  column_id: string
  clients?: Pick<Client, 'id' | 'name'> | null
}

/**
 * Slim card shape for the Atlas board (see ATLAS_BOARD_CARD_SELECT in
 * lib/cardQueries.ts). Same fields as BoardCard but grouped by atlas_location_id;
 * Atlas cards have a null column_id.
 */
export type AtlasBoardCard = Omit<BoardCard, 'column_id'> & {
  column_id: string | null
  atlas_location_id: string | null
  atlas_quarter?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | null
  atlas_year?: number | null
  /**
   * Attached files, Atlas board only (see ATLAS_BOARD_CARD_SELECT). Needed because
   * Atlas creatives are MP4s and preview_image_url alone cannot produce a
   * thumbnail for them. Slim on purpose — only what a thumbnail reads.
   */
  card_files?: Pick<CardFile, 'id' | 'file_url' | 'file_type' | 'created_at'>[]
  /** Reference link to the display build, shown as a chip on the board card. */
  display_build_link?: string | null
  /** Stage column on the Atlas board's Stages view (atlas_board_columns.id). null = first column. */
  atlas_column_id?: string | null
}

/** A stage column on the Atlas board (atlas_board_columns). Independent of the FTE board's `columns`. */
export interface AtlasBoardColumn {
  id: string
  title: string
  position: number
  /** Hex accent colour for the column's top border and title. */
  color: string
  created_at?: string
}

/** What an Atlas board card shows. Every key defaults to on — see lib/atlasStages.ts. */
export const ATLAS_CARD_FIELD_KEYS = [
  'thumbnail', 'location', 'work_status', 'approval', 'display_build', 'badges', 'deadline', 'adviewer_link',
] as const
export type AtlasCardFieldKey = typeof ATLAS_CARD_FIELD_KEYS[number]
export type AtlasCardFields = Record<AtlasCardFieldKey, boolean>

/** Single-row Atlas board settings (atlas_board_settings). */
export interface AtlasBoardSettings {
  /** The Atlas board's own background. null = fall back to the FTE board's. */
  background_url: string | null
  card_fields: Partial<AtlasCardFields>
  /**
   * Stage a card moves to when it is first sent to Adviewer, or when a revision
   * is uploaded after a change request. null = don't move. The move is done by
   * the cards_atlas_auto_stage trigger (supabase/add_atlas_board_automove.sql).
   */
  review_column_id?: string | null
  /** Stage a card moves to when the client asks for changes. null = don't move. */
  changes_column_id?: string | null
}

export const FB_CTA_OPTIONS = [
  'No Button',
  'Apply Now',
  'Book Now',
  'Contact Us',
  'Download',
  'Get Directions',
  'Get Quote',
  'Learn More',
  'Order Now',
  'Request Time',
  'See Menu',
  'Send Message',
  'Shop Now',
  'Sign Up',
  'Subscribe',
  'Watch More',
] as const

export interface CardFile {
  id: string
  card_id: string
  file_name: string
  file_url: string
  file_type: string | null
  dimensions: string | null
  approval_status: string
  created_at: string
}

export interface CardFlight {
  id: string
  card_id: string
  previous_column_id: string | null
  went_live_at: string
  went_dark_at: string | null
  triggered_by: 'column_move' | 'manual'
  voided: boolean
  void_reason: string | null
  created_at: string
  updated_at: string
}

export interface TtdCampaign {
  id: string
  client_id: string
  ttd_campaign_id: string
  name: string
  created_at: string
  ttd_ad_groups?: TtdAdGroup[]
}

export interface TtdAdGroup {
  id: string
  campaign_id: string
  ttd_ad_group_id: string
  name: string
  created_at: string
}

export interface CardActivity {
  id: string
  card_id: string
  actor: string | null
  action: string
  detail: string | null
  created_at: string
}

// ── Review Portal ──────────────────────────────────────────────────────────

export interface CardComment {
    id: string
    card_id: string
    file_id: string | null
    slide_index: number | null
    comment: string
    submitted_at: string
}

export const TEMPLATE_OPTIONS = [
  'Display Request',
  'Social Ad Request',
  'Carousel Ad',
  'Organic Post',
  'Eblast',
  'Web Banner',
  'Proposal Request',
  'FB Event Cover',
  'Reel Request',
  'Video Request',
  'Audio Request',
  'Flyer',
  'Messenger Ad',
  'Instant Experience',
] as const

export type TemplateOption = typeof TEMPLATE_OPTIONS[number]

export const APPROVAL_STATUSES = ['none', 'pending', 'approved', 'rejected', 'changes_requested'] as const
export type ApprovalStatus = typeof APPROVAL_STATUSES[number]

// Internal production state of a card, distinct from the client-facing
// approval_status. null = not started (no pill shown). Ordered as the pipeline.
export const WORK_STATUSES = ['in_design', 'internal_review', 'pending_approval', 'complete'] as const
export type WorkStatus = typeof WORK_STATUSES[number]
export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  in_design: 'In Design',
  internal_review: 'Internal Review',
  pending_approval: 'Pending Approval',
  complete: 'Complete',
}

// Media types that appear on the Content Calendar (feed-style posts).
// Display, web banner, video/audio requests, etc. stay off the calendar.
export const POST_STYLE_MEDIA_TYPES = [
  'Social Ad Request',
  'Carousel Ad',
  'Organic Post',
  'Reel Request',
  'Eblast',
] as const

export type PostStyleMediaType = typeof POST_STYLE_MEDIA_TYPES[number]

// Media types eligible for the Facebook Download Build export
// (square/tall folder grouping + facebook_upload.xlsx). Shared by
// app/api/box/download-build and the board's bulk Download Build button.
export const FB_BUILD_MEDIA_TYPES = [
  'Social Ad Request',
  'Carousel Ad',
  'Organic Post',
  'Reel Request',
  'FB Event Cover',
] as const

export type FbBuildMediaType = typeof FB_BUILD_MEDIA_TYPES[number]

// Media types eligible for the TTD Download Build export (ttd_upload.xlsx).
// Shared by app/api/box/download-build and the board's bulk Download Build
// button. Keys of that route's TTD_TYPES_SHEET tab mapping — keep in sync.
export const TTD_BUILD_MEDIA_TYPES = [
  'Display Request',
  'Video Request',
  'Audio Request',
] as const

export type TtdBuildMediaType = typeof TTD_BUILD_MEDIA_TYPES[number]

// ── Carousel slide local state ─────────────────────────────────────────────
// Extends the DB type with transient flags used only inside CardDrawer / DrawerCreativeTab.
// Never persisted directly — stripped before upsert.
export interface LocalSlide extends CarouselSlide {
  _dirty: boolean
  _deleted: boolean
  _isNew: boolean
}

// ── Copy Tracker ───────────────────────────────────────────────────────────

export interface ArchiveFile {
  id: string
  file_name: string
  file_url: string
  file_type: string | null
  dimensions: string | null
}

/** One recorded live interval from card_flights. end === null means live right now. */
export interface FlightSpan {
  start: string
  end: string | null
}

export interface LineageRun {
  card_id: string
  run_number: number
  title: string
  adpiler_preview_url: string | null
  flight_start_date: string | null
  flight_end_date: string | null
  flights: FlightSpan[]
  is_live: boolean
  archived: boolean
}

export interface ArchiveEntry {
  id: string
  title: string
  client_id: string | null
  client_name: string | null
  client_abbreviation: string | null
  client_logo_url: string | null
  media_type: string | null
  approval_status: string
  description: string | null
  landing_page_url: string | null
  utm_campaign: string | null
  utm_channel: string | null
  preview_image_url: string | null
  flight_start_date: string | null
  flight_end_date: string | null
  creative_name: string | null
  source_card_id: string | null
  run_number: number
  adpiler_preview_url: string | null
  client_portal_status: 'pending_approval' | 'running' | 'archive_review' | null
  archived: boolean
  is_live: boolean
  effective_flight_start: string | null
  effective_flight_end: string | null
  flight_dates_auto: boolean
  restart_requested_at: string | null
  fb_headline: string | null
  fb_body_text: string | null
  fb_cta: string | null
  flights: FlightSpan[]
  created_at: string
  updated_at: string
  files: ArchiveFile[]
  lineage: LineageRun[]
}

// ── Video Proofing ─────────────────────────────────────────────────────────
export type VideoAuthorKind = 'internal' | 'client'
export type VideoProjectStatus = 'in_review' | 'approved' | 'archived'

export interface VideoProject {
  id: string
  title: string
  client_id: string | null
  card_id: string | null
  created_by: string | null
  share_token: string
  status: VideoProjectStatus
  archived: boolean
  created_at: string
  updated_at: string
  clients?: Client | null
}

export interface VideoVersion {
  id: string
  project_id: string
  version_number: number
  box_file_id: string | null
  video_url: string | null
  thumbnail_url: string | null
  duration_sec: number | null
  notes: string | null
  uploaded_by: string | null
  created_at: string
}

export interface VideoComment {
  id: string
  version_id: string
  author_kind: VideoAuthorKind
  author_user_id: string | null
  author_name: string | null
  timestamp_sec: number | null
  body: string
  acknowledged: boolean
  acknowledged_at: string | null
  acknowledged_by: string | null
  created_at: string
}

export interface VideoApproval {
  id: string
  version_id: string
  approver_kind: VideoAuthorKind
  approver_user_id: string | null
  approver_name: string | null
  note: string | null
  created_at: string
}

// ── Atlas Creative Workspace ─────────────────────────────────────────────────────

export interface AtlasLocation {
  id: string
  name: string
  /**
   * The practice name a client reads as the Facebook advertiser on the Adviewer
   * mockup — copied to `cards.fb_page_name` on import. Shared across a brand (all
   * every MetroCare row reads "MetroCare", every ScanCo row reads "ScanCo"), so many locations
   * map to fewer advertisers. Nullable only because rows predating
   * `supabase/add_atlas_advertiser_name.sql` had no value; the Add Location form
   * requires it, and a null falls back to the client record — i.e. renders
   * "Atlas Health Network", the bug this field exists to fix.
   */
  advertiser_name: string | null
  /**
   * True when ONE creative serves every practice under this brand (ScanCo only
   * today). The importer then creates one card per (advertiser_name, focus)
   * instead of one per (location, focus). Deliberately separate from
   * `advertiser_name` sharing: MetroCare shares a name but not creative.
   */
  shares_creative: boolean
  key_notes: string | null
  landscape: string | null
  age_demo: string | null
  ethnicity_demo: string | null
  active: boolean
  created_at: string
  updated_at: string
  atlas_branding_assets?: AtlasBrandingAsset[]
  atlas_creative_refresh?: AtlasCreativeRefresh[]
}

export interface AtlasCreativeRefresh {
  id: string
  location_id: string
  focus_type: string
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4'
  year: number
  social_copy: string | null
  social_headline: string | null
  social_subhead: string | null
  graphic_headline: string | null
  graphic_subhead: string | null
  adpiler_link: string | null
  // ── Sheet-imported URL / Box columns (add_atlas_board.sql) ──────────────────
  facebook_url: string | null            // sheet col H  — FB ad URL w/ UTMs
  display_url: string | null             // sheet col I  — Display ad URL w/ UTMs
  social_build_box_link: string | null   // sheet col AW — MP4 build folder
  display_build_box_link: string | null  // sheet col AU — HTML5 build folder
  status: 'draft' | 'approved'
  created_at: string
  updated_at: string
  atlas_locations?: AtlasLocation
}

export interface AtlasBrandingAsset {
  id: string
  location_id: string
  label: string
  box_url: string | null
  created_at: string
  updated_at: string
}

export const ATLAS_QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const
export type AtlasQuarter = typeof ATLAS_QUARTERS[number]

export interface AtlasGenerateRequest {
  rows: {
    location_id: string
    location_name: string
    key_notes: string | null
    landscape: string | null
    age_demo: string | null
    ethnicity_demo: string | null
    focus_type: string
    quarter: AtlasQuarter
    year: number
  }[]
}

export interface AtlasGenerateResult {
  location_id: string
  focus_type: string
  quarter: AtlasQuarter
  year: number
  social_copy: string
  social_headline: string
  social_subhead: string
  graphic_headline: string
  graphic_subhead: string
}

// ── FTE Adviewer ───────────────────────────────────────────────────────────────

export interface AdviewerToken {
  id: string
  token: string
  card_id: string | null
  client_id: string | null
  title: string | null
  status: 'pending' | 'approved' | 'needs_revision'
  client_notes: string | null
  created_at: string
  updated_at: string
  // joined
  card?: {
    id: string
    title: string
    media_type: string | null
    client_id: string | null
    fb_page_name: string | null
    fb_body_text: string | null
    fb_headline: string | null
    fb_link_description: string | null
    fb_cta: string | null
    landing_page_url: string | null
    adpiler_preview_url: string | null
    card_files?: Array<{
      id: string
      file_name: string
      file_url: string
      file_type: string | null
      dimensions: string | null
    }>
    carousel_slides?: Array<{
      id: string
      position: number
      image_url: string | null
      headline: string | null
      link_description: string | null
      landing_page_url: string | null
    }>
  } | null
  client?: { id: string; name: string; fb_page_logo_url: string | null } | null
}



// ── Adviewer Campaigns ─────────────────────────────────────────────────────────

export type AdviewerStatus = 'pending' | 'approved' | 'needs_revision'

export interface ReviewPin {
  id: string
  x: number
  y: number
  note: string
  // Carousel only: anchors the pin to one slide. When set, x/y are percentages of
  // that slide's framed card (so the pin travels with the carousel track), not of
  // the whole mockup plane. Absent = legacy card-level pin (caption/header/whole-ad).
  slide_id?: string
  // Instant Experience only: anchors the pin to one inner block (x/y are % of that
  // block's rendered area). Mirrors slide_id for the IE phone mockup. Absent = legacy
  // whole-plane pin. IE stays ONE review unit (like a carousel), pins just carry which block.
  block_id?: string
  // Set on pins dropped from a per-location review link. A location sees and
  // edits only these; pins without it are corporate's (or older) and a location
  // link can neither see nor remove them. Designers see both in one list.
  by?: 'location'
}

/**
 * A snapshotted past review round. When a designer replaces or deletes a file to
 * address feedback, that file's pins are frozen into `CampaignCardReview.history`
 * (the full file bytes are deleted to save storage; a tiny thumbnail is retained
 * when the source is an image). This preserves the change-request trail for later
 * reference even though the original creative is gone.
 */
export interface ReviewRound {
  round: number
  /**
   * What these pins were anchored to: a now-deleted card_files.id, a
   * carousel_slides.id (slide-graphic replacement), or 'card' (ad-preview /
   * single-social graphic pins). The label to display is `file_name`.
   */
  file_id: string
  file_name: string
  dimensions: string | null
  /** Small retained preview (~20-50KB); null for HTML5 / non-image creatives. */
  thumb_url: string | null
  pins: ReviewPin[]
  note?: string
  resolved: boolean
  resolved_at?: string
  submitted_at?: string
}

/** Structured per-section review stored as JSON in adviewer_campaign_cards.client_notes */
export interface CampaignCardReview {
  reviewer: string
  submitted_at?: string
  // New format
  status?: AdviewerStatus
  note?: string
  pins?: ReviewPin[]
  // Per-sub-file pins for multi-file board cards, keyed by card_files.id.
  // Board-card sub-files have no adviewer_campaign_files row, so their pins are
  // stored here on the card link rather than on a (nonexistent) file row.
  file_pins?: Record<string, ReviewPin[]>
  // Per-sub-file review status for multi-file cards, keyed by card_files.id.
  // 'changes' is implied by a size having pins; 'approved' is an explicit client action.
  file_reviews?: Record<string, 'approved' | 'changes'>
  resolved_pins?: string[]
  // Snapshotted past review rounds (superseded when a file is replaced/deleted).
  // See ReviewRound. The full file is deleted; a thumbnail + the pins are kept.
  history?: ReviewRound[]
  // The location's own answer, from its per-location review link. Kept apart
  // from the corporate fields above so one never overwrites the other; the
  // verdict itself is mirrored in adviewer_campaign_cards.location_status.
  // Pins are NOT here — both reviewers' pins share `pins` / `file_pins`.
  location_review?: LocationCardReview
  // Legacy section format (kept for backwards compatibility)
  caption?:   { status: AdviewerStatus; note: string }
  graphic?:   { status: AdviewerStatus; note: string }
  headline?:  { status: AdviewerStatus; note: string }
  subheader?: { status: AdviewerStatus; note: string }
  button?:    { status: AdviewerStatus; note: string }
}

export interface LocationCardReview {
  status: AdviewerStatus
  reviewer?: string
  note?: string
  submitted_at?: string
  file_reviews?: Record<string, 'approved' | 'changes'>
}

export interface CampaignCardData {
  id: string
  campaign_id: string
  card_id: string
  position: number
  status: AdviewerStatus
  client_notes: CampaignCardReview | null
  /** Verdict from the card's location link; null = none. `status` is corporate's. */
  location_status?: AdviewerStatus | null
  /** Staff-only, corporate view: which location gave location_status. */
  location_name?: string | null
  created_at: string
  updated_at: string
  // joined
  card?: {
    id: string
    title: string
    creative_name: string | null
    flight_end_date: string | null
    media_type: string | null
    preview_image_url: string | null
    client_id: string | null
    /**
     * Soft-delete flag on the board card. Archived cards are filtered out of every
     * client-facing Adviewer surface and out of the "all approved" rollups; staff
     * surfaces still show them, greyed. Optional because the narrower dashboard
     * select does not always fetch it — treat an absent value as not archived.
     */
    archived?: boolean | null
    /**
     * Atlas only — which location this creative belongs to. Optional because the
     * narrower selects do not fetch it; present wherever a surface has to split
     * a campaign by location (per-location review links, the notify fan-out).
     */
    atlas_location_id?: string | null
    fb_page_name: string | null
    fb_body_text: string | null
    fb_headline: string | null
    fb_subheadline: string | null
    fb_link_description: string | null
    fb_cta: string | null
    landing_page_url: string | null
    adpiler_preview_url: string | null
    /** Instant Experience inner blocks — joined for the IE phone mockup in the Adviewer preview. */
    instant_experience?: InstantExperience | null
    card_files?: Array<{
      id: string
      file_name: string
      file_url: string
      file_type: string | null
      dimensions: string | null
    }>
    carousel_slides?: Array<{
      id: string
      position: number
      image_url: string | null
      headline: string | null
      subheadline: string | null
      link_description: string | null
      display_link: string | null
      graphic_headline: string | null
      graphic_subhead: string | null
      landing_page_url: string | null
    }>
  } | null
}

export interface AdviewerCampaignFile {
  id: string
  campaign_id: string
  file_name: string
  file_url: string
  position: number
  status: AdviewerStatus
  client_notes: { reviewer?: string; note?: string; status?: AdviewerStatus; pins?: ReviewPin[] } | null
  /**
   * How this uploaded creative renders in the campaign preview.
   * 'display' (default) = raw file in the display frame — the original behavior.
   * 'social' = rendered inside the Facebook feed mockup using the fb_* copy below
   * (for one-off social specs / prospect mockups with no board card).
   */
  render_mode: 'display' | 'social'
  fb_page_name: string | null
  fb_body_text: string | null
  fb_headline: string | null
  fb_subheadline: string | null
  fb_cta: string | null
  landing_page_url: string | null
  created_at: string
  updated_at: string
}

/**
 * A slice of one campaign addressed by its own token, so a single location can
 * review only its own creatives and carry its own status. See
 * supabase/add_adviewer_campaign_scopes.sql for why this is a filter over one
 * campaign rather than a child campaign per location.
 */
export interface AdviewerCampaignScope {
  id: string
  campaign_id: string
  atlas_location_id: string | null
  /** Minted once and reused for every revision round — never regenerate it. */
  token: string
  status: AdviewerStatus
  /** Set when staff hand the link over. Null = generated but not yet sent. */
  sent_at: string | null
  /** Set when staff close the scope for the location, e.g. changes came by email. */
  closed_by: string | null
  closed_note: string | null
  created_at: string
  updated_at: string
  // joined
  atlas_location?: { id: string; name: string } | null
}

export interface AdviewerCampaign {
  id: string
  title: string
  client_id: string | null
  token: string
  status: AdviewerStatus
  /** 'monthly' = per-month client campaign; 'design_requests' = persistent bucket for one-off standalone items. */
  kind: 'monthly' | 'design_requests'
  archived: boolean
  lookbook_folder_id: string | null
  created_at: string
  updated_at: string
  // joined
  client?: { id: string; name: string; fb_page_logo_url: string | null } | null
  campaign_cards?: CampaignCardData[]
  campaign_files?: AdviewerCampaignFile[]
  /**
   * Per-location review links, id + status only. Joined on the dashboard so the
   * Locations filter can tell which campaigns are mid-rollout to their locations
   * — including archived ones, which are otherwise hidden. The full rows come
   * from /api/adviewer/campaign/[id]/scopes when the panel opens.
   */
  scopes?: Array<{ id: string; status: AdviewerStatus }>
}

export interface AdviewerLookbookFolder {
  id: string
  client_id: string
  parent_id: string | null
  name: string
  kind: 'client' | 'year' | 'month' | 'custom'
  position: number
  created_at: string
  updated_at: string
}

export interface AdviewerEmailPref {
  user_id: string
  email: string
  notify_on_review: boolean
  created_at: string
  updated_at: string
}

export interface AdviewerCreativeDeckItem {
  id: string
  deck_id: string
  source_type: 'file' | 'card'
  source_id: string
  position: number
  // joined
  file?: AdviewerCampaignFile | null
  card?: CampaignCardData | null
}

export interface AdviewerCreativeDeck {
  id: string
  title: string
  token: string
  client_id: string | null
  created_at: string
  // joined
  client?: { id: string; name: string; fb_page_logo_url: string | null } | null
  items?: AdviewerCreativeDeckItem[]
}

export interface AdviewerProjectCard {
  id: string
  position: number
  card: {
    id: string
    title: string
    media_type: string | null
    client_portal_status: string | null
    flight_start_date: string | null
    flight_end_date: string | null
  } | null
}

export interface AdviewerProject {
  id: string
  title: string
  description: string | null
  status: string
  created_at: string
  updated_at: string
  client: { id: string; name: string; fb_page_logo_url: string | null } | null
  cards: AdviewerProjectCard[] | null
}

export type SocialPostStatus = 'draft' | 'approved' | 'submitting' | 'scheduled' | 'published' | 'failed'
export type SocialPlatform = 'facebook' | 'instagram'

export interface SocialPost {
  id: string
  client_id: string | null
  page_id: string
  platform: SocialPlatform
  caption: string | null
  media_urls: string[]
  scheduled_for: string
  status: SocialPostStatus
  fb_post_id: string | null
  ig_container_id: string | null
  error_message: string | null
  error_code: string | null
  approved_by: string | null
  approved_at: string | null
  submitted_at: string | null
  published_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface SocialPage {
  id: string
  client_id: string | null
  fb_page_id: string
  page_name: string
  ig_account_id: string | null
  status: 'active' | 'disconnected' | 'error'
  connected_by: string | null
  connected_at: string
  created_at: string
  updated_at: string
}

export interface SlackConnection {
  id: string
  user_id: string
  slack_user_id: string
  slack_team_id: string
  slack_team_name: string | null
  slack_user_name: string | null
  watched_columns: string[]
  watch_all_clients: boolean
  watched_clients: string[]
  created_at: string
  updated_at: string
}
