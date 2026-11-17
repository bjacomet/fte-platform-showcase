import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import type { AdviewerCampaignFile, AdviewerStatus, ApprovalStatus, CampaignCardReview, ReviewPin, ReviewRound } from '@/types'

// Per-size pin group for a multi-file board card — pins the client dropped on one
// specific size (card_files row), sourced from client_notes.file_pins.
interface FileGroup {
  file_id: string
  file_name: string
  dimensions: string | null
  file_url: string | null
  pins: ReviewPin[]
}

// Per-slide pin group for a carousel card — pins the client dropped on one slide's
// framed card (pin.slide_id), grouped like file_groups are per size.
interface SlideGroup {
  slide_id: string
  // 0-based carousel_slides.position — used for the "Slide N" label and the
  // #slide-{position} deep link into Adviewer.
  position: number
  image_url: string | null
  pins: ReviewPin[]
}

interface CardFeedback {
  // adviewer_campaign_cards.id — used to deep-link into Adviewer (?only=link_id[::file_id]).
  link_id: string
  // Card-level ad-preview pins (social / carousel caption-level). Empty when the
  // card is multi-file (those pins live in file_groups) — and excludes
  // slide-anchored pins (those live in slide_groups) to avoid showing pins twice.
  pins: ReviewPin[]
  file_groups: FileGroup[]
  slide_groups: SlideGroup[]
  resolved_pins: string[]
  note: string | null
  reviewer: string | null
  submitted_at: string | null
  preview_image_url: string | null
  history: ReviewRound[]
}

interface CampaignFeedback {
  campaign_id: string
  campaign_title: string
  campaign_token: string
  submitted_at: string | null
  reviewer: string | null
  files: AdviewerCampaignFile[]
  card_feedback: CardFeedback | null
}

interface CampaignCardLink {
  id: string
  campaign_id: string
  client_notes: CampaignCardReview | null
  updated_at: string | null
  card: { preview_image_url: string | null } | null
}

interface CardFileRow {
  id: string
  file_name: string
  dimensions: string | null
  file_url: string | null
}

// card_files.file_url may be a bare storage path (new records) or a full URL (old
// records). Resolve to a renderable public URL, matching how preview_image_url is set.
function publicUrl(
  supabase: Awaited<ReturnType<typeof createClient>>,
  path: string | null,
): string | null {
  if (!path) return null
  if (/^https?:\/\//.test(path)) return path
  return supabase.storage.from('creative-files').getPublicUrl(path).data.publicUrl
}

export async function GET(req: NextRequest) {
  const cardId = req.nextUrl.searchParams.get('cardId')
  if (!cardId) {
    return NextResponse.json({ error: 'Missing cardId' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Step 1: get campaign links for this board card — including the client's
  // pin annotations, which live on adviewer_campaign_cards.client_notes
  // (pins dropped on the ad preview / per size), NOT on adviewer_campaign_files
  // (pins dropped on standalone uploaded files).
  const { data: links, error: linksError } = await supabase
    .from('adviewer_campaign_cards')
    .select('id, campaign_id, client_notes, updated_at, card:cards(preview_image_url)')
    .eq('card_id', cardId)

  if (linksError) {
    return NextResponse.json({ error: linksError.message }, { status: 500 })
  }
  if (!links || links.length === 0) {
    return NextResponse.json({ campaigns: [] })
  }

  const cardLinks = links as unknown as CampaignCardLink[]
  const campaignIds = cardLinks.map((l) => l.campaign_id)

  // Step 2: get campaign metadata
  const { data: campaigns, error: campaignError } = await supabase
    .from('adviewer_campaigns')
    .select('id, title, token')
    .in('id', campaignIds)

  if (campaignError) {
    return NextResponse.json({ error: campaignError.message }, { status: 500 })
  }

  // Step 3: get files with pin annotations for these campaigns
  const { data: files, error: filesError } = await supabase
    .from('adviewer_campaign_files')
    .select('*')
    .in('campaign_id', campaignIds)
    .order('position')

  if (filesError) {
    return NextResponse.json({ error: filesError.message }, { status: 500 })
  }

  // Step 4: get this board card's files, to resolve per-size names/dimensions for
  // client_notes.file_pins (keyed by card_files.id).
  const { data: cardFiles, error: cardFilesError } = await supabase
    .from('card_files')
    .select('id, file_name, dimensions, file_url')
    .eq('card_id', cardId)

  if (cardFilesError) {
    return NextResponse.json({ error: cardFilesError.message }, { status: 500 })
  }
  const cardFileMap = new Map<string, CardFileRow>(
    ((cardFiles ?? []) as unknown as CardFileRow[]).map((cf) => [cf.id, cf])
  )

  // Step 5: get the card's carousel slides (if any), to resolve slide-anchored
  // pins (pin.slide_id) into labeled per-slide groups with thumbnails.
  const { data: slideRows } = await supabase
    .from('carousel_slides')
    .select('id, position, image_url')
    .eq('card_id', cardId)
    .order('position')
  const slideMap = new Map<string, { position: number; image_url: string | null }>(
    ((slideRows ?? []) as { id: string; position: number; image_url: string | null }[])
      .map((s) => [s.id, { position: s.position, image_url: s.image_url }])
  )

  // Group files by campaign and filter to those with pins
  const result: CampaignFeedback[] = []

  for (const campaign of campaigns ?? []) {
    const campaignFiles = (files ?? [] as AdviewerCampaignFile[]).filter(
      (f: AdviewerCampaignFile) =>
        f.campaign_id === campaign.id &&
        Array.isArray(f.client_notes?.pins) &&
        (f.client_notes?.pins?.length ?? 0) > 0
    )

    // Card-level pin feedback — pins the client dropped on this card's ad
    // preview in the Adviewer, stored on the campaign_cards link row
    const link = cardLinks.find((l) => l.campaign_id === campaign.id)
    const linkNotes = link?.client_notes

    // Per-size groups from client_notes.file_pins (multi-file display cards).
    const filePins = linkNotes?.file_pins ?? {}
    const fileGroups: FileGroup[] = Object.entries(filePins)
      .filter(([, pins]) => Array.isArray(pins) && pins.length > 0)
      .map(([fileId, pins]) => {
        const cf = cardFileMap.get(fileId)
        return {
          file_id: fileId,
          file_name: cf?.file_name ?? 'Removed file',
          dimensions: cf?.dimensions ?? null,
          // card_files.file_url is a bare storage path — resolve it to a public URL
          // so the thumbnail actually renders (mirrors the preview_image_url pattern).
          file_url: publicUrl(supabase, cf?.file_url ?? null),
          pins: pins as ReviewPin[],
        }
      })

    // Slide-anchored carousel pins → one group per slide (like file_groups per size).
    const flatPins: ReviewPin[] = Array.isArray(linkNotes?.pins) ? linkNotes.pins : []
    const slideGroupMap = new Map<string, SlideGroup>()
    for (const p of flatPins) {
      if (!p.slide_id) continue
      const slide = slideMap.get(p.slide_id)
      let group = slideGroupMap.get(p.slide_id)
      if (!group) {
        group = {
          slide_id: p.slide_id,
          position: slide?.position ?? 0,
          image_url: slide ? publicUrl(supabase, slide.image_url) : null,
          pins: [],
        }
        slideGroupMap.set(p.slide_id, group)
      }
      group.pins.push(p)
    }
    const slideGroups = [...slideGroupMap.values()].sort((a, b) => a.position - b.position)

    // When the card is multi-file, its flattened `.pins` is the union of all
    // file_pins — so suppress the card-level block to avoid double-showing.
    // Slide-anchored pins are likewise shown only in slide_groups.
    const hasFileGroups = fileGroups.length > 0
    const cardPins = !hasFileGroups ? flatPins.filter((p) => !p.slide_id) : []
    const history: ReviewRound[] = linkNotes?.history ?? []

    const hasAny =
      cardPins.length > 0 ||
      hasFileGroups ||
      slideGroups.length > 0 ||
      history.length > 0 ||
      (linkNotes?.note ?? '').trim().length > 0

    const card_feedback: CardFeedback | null =
      link && hasAny
        ? {
            link_id: link.id,
            pins: cardPins,
            file_groups: fileGroups,
            slide_groups: slideGroups,
            resolved_pins: linkNotes?.resolved_pins ?? [],
            note: linkNotes?.note ?? null,
            // A card only a location reviewed has no corporate reviewer — the
            // location's name lives in location_review. Fall back to it so the
            // Changes tab says who asked, instead of showing a blank.
            reviewer: linkNotes?.reviewer || linkNotes?.location_review?.reviewer || null,
            submitted_at: linkNotes?.submitted_at ?? link?.updated_at ?? null,
            preview_image_url: link?.card?.preview_image_url ?? null,
            history,
          }
        : null

    if (campaignFiles.length === 0 && !card_feedback) continue

    const firstFile = campaignFiles[0]
    const reviewer = card_feedback?.reviewer ?? firstFile?.client_notes?.reviewer ?? null
    const submitted_at = card_feedback?.submitted_at ?? firstFile?.updated_at ?? null

    result.push({
      campaign_id: campaign.id,
      campaign_title: campaign.title,
      campaign_token: campaign.token,
      submitted_at,
      reviewer,
      files: campaignFiles,
      card_feedback,
    })
  }

  return NextResponse.json({ campaigns: result })
}

interface ResolveBody {
  linkId: string
  pinId: string
  resolved: boolean
}

// Every pin id attached to this link, deduped. `client_notes.pins` is already the
// FLATTENED card-level + per-sub-file list (kept that way for this tab), while
// `file_pins` is the per-size map — the same pin id therefore appears in both on a
// multi-file card, so collect into a Set rather than concatenating.
// side: 'corporate' = pins not tagged by:'location' (incl. untagged legacy pins);
// 'location' = the per-location link's pins. Each side's verdict counts only its own.
function allPinIds(notes: CampaignCardReview, side: 'corporate' | 'location'): Set<string> {
  const ids = new Set<string>()
  const mine = (p: { by?: string }) => (side === 'location') === (p.by === 'location')
  for (const p of notes.pins ?? []) if (mine(p)) ids.add(p.id)
  for (const pins of Object.values(notes.file_pins ?? {})) {
    for (const p of pins ?? []) if (mine(p)) ids.add(p.id)
  }
  return ids
}

// Toggle a pin's resolved state from the designer side (Changes tab). Writes back
// to adviewer_campaign_cards.client_notes.resolved_pins — the same flat array the
// Adviewer seeds its resolved state from on load, so the change reflects there too.
// resolved_pins is read fresh and merged here so this stays authoritative even if a
// client's Adviewer session holds a stale client_notes snapshot.
//
// Resolving the LAST open pin also clears the revision flags this card raised, which
// it previously did not do — the flag outlived the work and AMs had to eyeball the
// Changes tab to know whether a red card was actually still outstanding. Three
// surfaces come down together: the link's own status, the campaign rollup, and the
// board card's orange "Changes" pill (cards.approval_status). Un-resolving a pin
// walks all three back the other way, so the flags always describe current state.
export async function POST(req: NextRequest) {
  // Staff-only. Without this an Adviewer client-portal account reached the write and
  // was stopped by RLS instead — and a supabase-js update matching zero rows returns
  // NO error, so the caller got a 200 and silently lost the write.
  const denied = await requireWriter()
  if (denied) return denied

  const supabase = await createClient()

  let body: ResolveBody
  try {
    body = await req.json() as ResolveBody
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { linkId, pinId, resolved } = body
  if (!linkId || !pinId || typeof resolved !== 'boolean') {
    return NextResponse.json({ error: 'Missing linkId, pinId, or resolved' }, { status: 400 })
  }

  const { data: row, error: readErr } = await supabase
    .from('adviewer_campaign_cards')
    .select('client_notes, status, location_status, campaign_id, card_id')
    .eq('id', linkId)
    .single()

  if (readErr || !row) {
    return NextResponse.json({ error: readErr?.message ?? 'Link not found' }, { status: 404 })
  }

  const notes = ((row.client_notes ?? {}) as unknown as CampaignCardReview)
  const set = new Set(notes.resolved_pins ?? [])
  if (resolved) set.add(pinId)
  else set.delete(pinId)
  const nextResolved = Array.from(set)

  // Recompute this card's status from what's still open. Mirrors the client-side
  // expression in CampaignPreviewClient.handleSubmitAll so the designer path and the
  // client path can't reach different verdicts about the same card. One deliberate
  // divergence: that function only applies the resolved filter on single-file cards,
  // which would leave every multi-file card permanently stuck on 'needs_revision' no
  // matter how many pins the designer closed. Resolved means closed here regardless
  // of where the pin lives.
  //
  // The 'approved' verdict is read from row.status (the dedicated status column), NOT
  // client_notes.status. handleSubmitAll writes both together so they agree at submit
  // time, but the JSON copy isn't guaranteed present: adviewer_campaign_cards rows last
  // written by an older client build that replaced client_notes wholesale carry no status
  // key at all — legacy prod data, not a live code path. On those rows notes.status is
  // absent, so trusting it would compute 'pending' and silently downgrade an approved card
  // on its last resolve. row.status is authoritative — and it's what statusChanged compares
  // against on the next line, so reading it keeps the two in step.
  //
  // Corporate's status counts only corporate's pins; a location's pins drive
  // location_status, recomputed the same way (add_location_card_verdicts.sql).
  const openPinCount = [...allPinIds(notes, 'corporate')].filter((id) => !set.has(id)).length
  const nextStatus: AdviewerStatus =
    openPinCount > 0 ? 'needs_revision' : row.status === 'approved' ? 'approved' : 'pending'
  const statusChanged = nextStatus !== row.status
  const openLocationPins = [...allPinIds(notes, 'location')].filter((id) => !set.has(id)).length
  const nextLocationStatus: AdviewerStatus | null = row.location_status == null && openLocationPins === 0
    ? null
    : openLocationPins > 0 ? 'needs_revision' : row.location_status === 'approved' ? 'approved' : 'pending'

  const update: Record<string, unknown> = {
    client_notes: { ...notes, resolved_pins: nextResolved } as unknown as CampaignCardReview,
    updated_at: new Date().toISOString(),
  }
  if (statusChanged) update.status = nextStatus
  if (nextLocationStatus !== row.location_status) update.location_status = nextLocationStatus

  // .select() so a zero-row result is caught: RLS denials come back as success with
  // no rows, not as an error, which is how this route used to fail silently.
  const { data: written, error: writeErr } = await supabase
    .from('adviewer_campaign_cards')
    .update(update)
    .eq('id', linkId)
    .select('id')

  if (writeErr) {
    return NextResponse.json({ error: writeErr.message }, { status: 500 })
  }
  if (!written || written.length === 0) {
    return NextResponse.json({ error: 'Update was rejected — no rows changed' }, { status: 403 })
  }

  // Nothing downstream to reconcile unless this card actually crossed a threshold.
  if (!statusChanged) {
    return NextResponse.json({ resolved_pins: nextResolved, status: nextStatus })
  }

  // ── Board card: the orange "Changes" pill ───────────────────────────────────
  // Only ever toggle the changes_requested flag. A resolve must not promote a card to
  // 'approved' — that verdict belongs to the client (or the AM approve path).
  if (row.card_id) {
    const { data: card } = await supabase
      .from('cards')
      .select('approval_status')
      .eq('id', row.card_id)
      .maybeSingle()
    const current = card?.approval_status as ApprovalStatus | undefined
    const nextApproval: ApprovalStatus | null =
      nextStatus === 'needs_revision'
        ? current === 'changes_requested' || current === 'approved' || current === 'rejected'
          ? null
          : 'changes_requested'
        : current === 'changes_requested' ? 'pending' : null
    if (nextApproval) {
      await supabase
        .from('cards')
        .update({ approval_status: nextApproval, updated_at: new Date().toISOString() })
        .eq('id', row.card_id)
    }
  }

  // ── Campaign rollup ─────────────────────────────────────────────────────────
  // Archived campaigns are in the Lookbook and finished; leave their status alone so a
  // late resolve can't drag one back out of it.
  const { data: campaign } = await supabase
    .from('adviewer_campaigns')
    .select('archived')
    .eq('id', row.campaign_id)
    .maybeSingle()

  if (campaign && campaign.archived !== true) {
    const [{ data: siblings }, { data: campaignFiles }] = await Promise.all([
      supabase.from('adviewer_campaign_cards').select('status').eq('campaign_id', row.campaign_id),
      supabase.from('adviewer_campaign_files').select('status').eq('campaign_id', row.campaign_id),
    ])

    const unitStatuses = [
      ...(siblings ?? []).map((s) => s.status as AdviewerStatus),
      ...(campaignFiles ?? []).map((f) => f.status as AdviewerStatus),
    ]
    const anyChanges = unitStatuses.some((s) => s === 'needs_revision')
    const everyApproved = unitStatuses.length > 0 && unitStatuses.every((s) => s === 'approved')
    const campaignStatus: AdviewerStatus = anyChanges ? 'needs_revision' : everyApproved ? 'approved' : 'pending'

    await supabase
      .from('adviewer_campaigns')
      .update({ status: campaignStatus, updated_at: new Date().toISOString() })
      .eq('id', row.campaign_id)
  }

  return NextResponse.json({ resolved_pins: nextResolved, status: nextStatus })
}
