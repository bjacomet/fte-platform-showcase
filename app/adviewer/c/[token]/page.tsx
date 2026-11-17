import { createAdminClient } from '@/lib/supabase/server'
import { clientFacingFiles } from '@/lib/adviewerFiles'
import { isStaffUser } from '@/lib/writers'
import { resolveReviewToken } from '@/lib/adviewerReviewToken'
import { notFound } from 'next/navigation'
import CampaignPreviewClient from './CampaignPreviewClient'
import type { AdviewerCampaign, CampaignCardReview, ReviewPin } from '@/types'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ token: string }>
  searchParams: Promise<{ only?: string }>
}

const CAMPAIGN_SELECT = `
  id, title, token, status, client_id, created_at, updated_at,
  client:clients(id, name, fb_page_logo_url),
  campaign_cards:adviewer_campaign_cards(
    id, campaign_id, card_id, position, status, client_notes, location_status, created_at, updated_at,
    card:cards(
      id, title, creative_name, flight_end_date, media_type, client_id, archived, atlas_location_id,
      fb_page_name, fb_body_text, fb_headline, fb_subheadline, fb_link_description, fb_cta,
      landing_page_url, adpiler_preview_url, instant_experience, preview_image_url,
      card_files(id, file_name, file_url, file_type, dimensions, created_at),
      carousel_slides(id, position, image_url, headline, subheadline, link_description, display_link, graphic_headline, graphic_subhead, landing_page_url)
    )
  ),
  campaign_files:adviewer_campaign_files(
    id, campaign_id, file_name, file_url, position, status, client_notes,
    render_mode, fb_page_name, fb_body_text, fb_headline, fb_subheadline, fb_cta, landing_page_url,
    created_at, updated_at
  )
`

export default async function CampaignPreviewPage({ params, searchParams }: Props) {
  const { token } = await params
  const { only } = await searchParams
  const supabase = createAdminClient()

  // The review page itself is public (token-based). The admin affordances — the
  // copy/graphic Edit pencil and the Approve → Lookbook bar — are FTE-staff-only,
  // gated on a logged-in non-client session. Route handlers re-check server-side.
  const canEdit = await isStaffUser()

  // One URL shape serves two kinds of link. A campaign token shows the whole
  // campaign (corporate's view). A SCOPE token shows one location's slice of the
  // same campaign — same page, same review mechanics, fewer creatives. The
  // campaign lookup runs first because it is the common case; only a miss costs
  // the second query. maybeSingle, not single, so a scope token is a miss rather
  // than an error.
  const { data: byCampaign } = await supabase
    .from('adviewer_campaigns')
    .select(CAMPAIGN_SELECT)
    .eq('token', token)
    .maybeSingle()

  let data = byCampaign
  let scopeLocationId: string | null = null
  let scopeLocationName: string | null = null
  // A location link's header badge shows THAT location's answer (its scope row),
  // not the campaign's. The campaign status is a rollup across corporate and every
  // location, so a location that hasn't looked yet was shown "Changes needed"
  // because some other location (or corporate) asked for changes.
  let scopeStatus: string | null = null

  if (!data) {
    // resolveReviewToken is the same resolver the write routes use, and it
    // refuses a scope whose atlas_location_id is NULL. That matters: the FK is
    // `on delete set null`, so deleting or merging an Atlas location leaves a live
    // token behind, and treating it as "no location filter" would fail OPEN —
    // that link would render the entire campaign plus every uploaded file.
    const resolved = await resolveReviewToken(supabase, token)
    if (!resolved?.scope) notFound()

    scopeLocationId = resolved.scope.atlasLocationId
    scopeLocationName = resolved.scope.locationName

    const { data: scopeRow } = await supabase
      .from('adviewer_campaign_scopes')
      .select('status')
      .eq('id', resolved.scope.id)
      .maybeSingle()
    scopeStatus = (scopeRow?.status as string | undefined) ?? 'pending'

    const { data: scoped } = await supabase
      .from('adviewer_campaigns')
      .select(CAMPAIGN_SELECT)
      .eq('id', resolved.campaignId)
      .maybeSingle()
    if (!scoped) notFound()
    data = scoped
  }

  // Archived board cards must not stay in front of a client. Archiving is how a
  // card is pulled from the work (consolidated, cancelled, superseded) — before
  // this, archiving removed it from the board but left it rendering in every
  // review already shared, so a client kept reviewing creative that no longer
  // exists and the header kept counting it.
  //
  // Filtered here in JS, not in the query: a PostgREST filter on an embedded
  // resource (`cards.archived=eq.false`) does NOT drop the parent — it returns
  // the adviewer_campaign_cards row with `card: null`, which renders as an empty
  // slot and still counts. The join rows are deliberately left in the table:
  // they are the record that the card was in this campaign.
  //
  // Only `archived === true` hides. A null/absent flag means "not marked
  // archived" and stays visible — the safe direction for an older row.
  //
  // The scope filter rides the same pass. Every Atlas card carries exactly one
  // atlas_location_id, so filtering to one location is a clean partition of the
  // campaign — no creative can appear in two location links.
  const visibleCards = (data.campaign_cards ?? []).filter((cc) => {
    const card = cc.card as { archived?: boolean | null; atlas_location_id?: string | null } | null
    if (!card || card.archived === true) return false
    if (scopeLocationId && card.atlas_location_id !== scopeLocationId) return false
    return true
  })

  // Only finished creatives reach the client — source photos and logos attached
  // to the same card stay on the board. Rule and its reasoning: lib/adviewerFiles.ts.
  // Applied here, at the page's one data entry point, so the mockup, sidebar,
  // review units, submit rollup and per-file pins all see the same list.
  const filteredCards = visibleCards.map((cc) => {
    const card = cc.card as { media_type?: string | null; preview_image_url?: string | null; card_files?: { file_name: string; file_url: string; file_type: string | null; created_at?: string }[] } | null
    if (!card?.card_files || card.card_files.length === 0) return cc
    // Upload order, so every consumer (incl. the Copy Tracker label) gets a deterministic list.
    const ordered = [...card.card_files].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
    return { ...cc, card: { ...card, card_files: clientFacingFiles(ordered, card.media_type, card.preview_image_url) } }
  })

  // Corporate and a location answer separately (supabase/add_location_card_verdicts.sql).
  // A location link sees ITS answer in the status / note / per-size fields the
  // page already reads, so the review UI is unchanged; corporate's answer and
  // pins never reach it. Designers still see every pin in one list.
  //
  // Staff on the corporate link also get the location's verdict and name, so a
  // card can show "Lakeside: changes" beside corporate's own answer.
  type ReviewRow = (typeof filteredCards)[number] & {
    status: string
    location_status?: string | null
    client_notes: CampaignCardReview | null
  }
  let locationNames = new Map<string, string>()
  if (!scopeLocationId && canEdit) {
    const ids = [...new Set(filteredCards
      .map((cc) => (cc.card as { atlas_location_id?: string | null } | null)?.atlas_location_id)
      .filter((x): x is string => !!x))]
    if (ids.length) {
      const { data: locs } = await supabase.from('atlas_locations').select('id, name').in('id', ids)
      locationNames = new Map(((locs ?? []) as { id: string; name: string }[]).map((l) => [l.id, l.name]))
    }
  }
  const reviewCards = (filteredCards as ReviewRow[]).map((cc) => {
    const notes = cc.client_notes as CampaignCardReview | null
    if (scopeLocationId) {
      const lr = notes?.location_review
      return {
        ...cc,
        status: cc.location_status ?? 'pending',
        // Only the location's own pins (by:'location'): corporate's change
        // requests aren't the location's to see, answer or remove.
        client_notes: notes
          ? {
              ...notes,
              status: lr?.status ?? 'pending',
              note: lr?.note ?? '',
              reviewer: lr?.reviewer ?? '',
              file_reviews: lr?.file_reviews ?? {},
              caption: undefined,
              pins: ((notes.pins ?? []) as ReviewPin[]).filter((p) => p.by === 'location'),
              file_pins: Object.fromEntries(
                Object.entries((notes.file_pins ?? {}) as Record<string, ReviewPin[]>)
                  .map(([k, v]) => [k, (v ?? []).filter((p) => p.by === 'location')]),
              ),
            }
          : null,
      }
    }
    // Corporate's link shows corporate's review only — never a location's pins or
    // answer (2026-10-08, design lead: "keep corporate separate as well as each
    // location also separate"). Before this, a location's pins reached corporate's
    // page unfiltered and rendered as corporate's own: the card read "Needs
    // changes · 1 pin", Approve was disabled until someone cleared a pin corporate
    // never left, and the location's note was visible with a remove button. If
    // corporate needs to see a location's comments, staff send them that
    // location's link. Nothing is lost by hiding them here: the review route's
    // mergeCorporatePins keeps every stored location pin on a corporate save, and
    // designers read all pins from /api/adviewer/card-feedback, not this page.
    // Staff get the same filtered view, plus the "Lakeside: changes" sidebar line.
    const corporateNotes: CampaignCardReview | null = notes
      ? {
          ...notes,
          location_review: undefined,
          pins: ((notes.pins ?? []) as ReviewPin[]).filter((p) => p.by !== 'location'),
          file_pins: Object.fromEntries(
            Object.entries((notes.file_pins ?? {}) as Record<string, ReviewPin[]>)
              .map(([k, v]) => [k, (v ?? []).filter((p) => p.by !== 'location')] as const)
              .filter(([, v]) => v.length > 0),
          ),
        }
      : null
    if (!canEdit) return { ...cc, location_status: null, client_notes: corporateNotes }
    const locId = (cc.card as { atlas_location_id?: string | null } | null)?.atlas_location_id ?? null
    return { ...cc, client_notes: corporateNotes, location_name: locId ? locationNames.get(locId) ?? null : null }
  })

  // Sort campaign cards and files by position. `position` is only ever used for
  // ordering, so dropping rows keeps the remaining order correct with no reindex;
  // every downstream count (the N/M reviewed header, the submit gate, the
  // campaign rollup) derives from this same filtered list.
  //
  // Uploaded campaign files carry no location, so a scoped link shows none of
  // them. They belong to the campaign as a whole, which is corporate's view.
  //
  // `token` is blanked on a scoped link and this is load-bearing, not tidiness.
  // The campaign token is what /api/adviewer/review treats as authority over the
  // whole campaign. Spread into the client props it ships in the RSC payload, so
  // one location could read it out of the page source and open
  // /adviewer/c/<campaignToken> — the full 22-location review — and overwrite
  // every other location's statuses and notes. The client posts `reviewToken`
  // (the token actually in the URL) instead, and the route decides what that
  // token may touch.
  const sorted = {
    ...data,
    token: scopeLocationId ? '' : data.token,
    status: scopeLocationId ? (scopeStatus ?? 'pending') : data.status,
    campaign_cards: [...reviewCards].sort((a, b) => a.position - b.position),
    campaign_files: scopeLocationId
      ? []
      : [...(data.campaign_files ?? [])].sort((a, b) => a.position - b.position),
  }

  return (
    <CampaignPreviewClient
      campaign={sorted as unknown as AdviewerCampaign}
      only={only}
      canEdit={canEdit}
      scopeLocationName={scopeLocationName}
      reviewToken={token}
    />
  )
}
