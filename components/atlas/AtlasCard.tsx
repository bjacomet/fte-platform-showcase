'use client'

import Image from 'next/image'
import { WORK_STATUS_LABELS } from '@/types'
import type { AtlasBoardCard, AtlasCardFields, WorkStatus } from '@/types'
import { isSupabaseImageHost } from '@/lib/imageHost'
import { AD_STILL_SECONDS, isVideoUrl, pickThumbFile, resolveFileUrl, videoStillSrc } from '@/lib/mediaKind'
import MediaTypeBadge from '../MediaTypeBadge'
import VideoStill from '../VideoStill'

// Shared by both Atlas board views (by location, and by stage). Moved out of
// AtlasBoard.tsx unchanged apart from the `fields` toggles, which come from the
// board's own Customize panel (atlas_board_settings.card_fields).

// Work-status colours, split into text + dot so the status renders as a quiet
// label instead of the bordered chip this board used to draw. Same hues as the
// main board's KanbanCard, so the two still read as one product.
const WORK_STATUS_TEXT: Record<WorkStatus, string> = {
  in_design: 'text-sky-300/80',
  internal_review: 'text-violet-300/80',
  pending_approval: 'text-amber-300/80',
  complete: 'text-emerald-300/80',
}

const WORK_STATUS_DOT: Record<WorkStatus, string> = {
  in_design: 'bg-sky-400',
  internal_review: 'bg-violet-400',
  pending_approval: 'bg-amber-400',
  complete: 'bg-emerald-400',
}

const APPROVAL_DOT: Record<string, string> = {
  approved: 'bg-green-400',
  pending: 'bg-yellow-400',
  rejected: 'bg-red-400',
}


// Left-edge deadline strip color — mirrors KanbanCard: green ≥3 days out,
// orange 1–2 days, red overdue/today.
function deadlineBorder(deadline: string | null): string | undefined {
  if (!deadline) return undefined
  const days = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000)
  const color = days >= 3 ? '#22c55e' : days >= 1 ? '#f97316' : '#ef4444'
  return `3px solid ${color}`
}

// What a card should show as its thumbnail, and whether that is a video.
//
// Atlas creatives are MP4s. preview_image_url is one scalar column that is not
// reliably populated for video cards, so before this the board fell through to
// nothing and the card rendered with no artwork at all. Falling back to the
// first attached file is what gives a video card something to paint; the
// #t=0.1 media fragment (see lib/mediaKind) is what makes the browser paint a
// frame rather than a black box — the same technique the Adviewer gallery uses.
function resolveThumb(card: AtlasBoardCard): { url: string; video: boolean } | null {
  // NOT card_files[0]. PostgREST gives no ordering guarantee on an embedded
  // resource, so [0] changes between reloads, and uploads are unfiltered — a
  // spec sheet, a banner ZIP or a PDF sitting alongside the MP4 could win and
  // render as a broken-image icon. pickThumbFile keeps only rows a browser can
  // paint and orders them, so the answer is both valid and stable.
  const raw = card.preview_image_url ?? pickThumbFile(card.card_files)?.file_url ?? null
  if (!raw) return null
  // MUST resolve before use. Box-synced files store a BUCKET-RELATIVE path
  // ("cards/<id>/box_sync_….mp4"), not an absolute URL. Dropped into a src
  // as-is, the browser resolves it against the app's own origin and requests
  // localhost:3000/cards/… — which 404s WITHOUT firing an error event, so the
  // video sits at readyState 0 and the card shows an empty grey box. That is
  // exactly what shipped in the first attempt at this.
  const url = resolveFileUrl(raw)
  return { url, video: isVideoUrl(url) }
}

// A card's stored title repeats what the column already says: the column reads
// "Atlas - Lakeside Cancer Center" and the card inside it reads "Atlas - Lakeside
// Cancer Center — Prostate (Social)". Of 47 characters, one word is new. These
// two helpers strip the repetition AT RENDER ONLY — cards.title is untouched,
// the drawer and every other surface still show the full name, and the title
// attribute keeps it reachable on hover.
const ATLAS_PREFIX = /^\s*Atlas\s*[-–—]\s*/i

export function shortLocationName(name: string): string {
  // Every column on this board is an Atlas location, so the "Atlas - " prefix costs
  // ~6 characters of a truncating header and tells you nothing. Dropping it is
  // what stops the truncation landing on the part that identifies the practice.
  return name.replace(ATLAS_PREFIX, '').trim() || name
}

function shortCardTitle(title: string, locationName: string): string {
  const bare = title.replace(ATLAS_PREFIX, '').trim()
  const loc = shortLocationName(locationName)
  if (bare.toLowerCase().startsWith(loc.toLowerCase())) {
    const rest = bare.slice(loc.length).replace(/^\s*[-–—]\s*/, '').trim()
    // Guard: never return an empty card. A title that is ONLY the location name
    // (no focus suffix) keeps its full text rather than rendering as a blank.
    if (rest) return rest
  }
  return bare || title
}

/**
 * A video thumbnail that does not touch the network until it is near the
 * viewport.
 *
 * On a full board, dozens of cards x ~1.4MB, and Supabase does NOT
 * advertise Accept-Ranges on these objects, so the browser cannot pull just the
 * header — it has to fetch a large part of each file to produce one frame. With
 * all 60 mounted at once that is ~84MB in flight and essentially nothing
 * finishes; the board sat at 0 of 60 painted after 20 seconds, which is exactly
 * what "looks like broken glitches" was. Bounding it to what is on screen keeps
 * concurrency around ten.
 *
 * Once loaded it stays loaded — unmounting the src on scroll-away would refetch
 * on every pass back.
 */
// VideoStill moved to components/VideoStill.tsx — the Lookbook needs the same
// lazy-mounted still, and a second copy is how the isVideo helpers drifted.
export default function AtlasCard({ card, onOpen, locationName, showMediaBadge, fields, showLocation = false }: {
  card: AtlasBoardCard
  onOpen: (id: string) => void
  locationName: string
  showMediaBadge: boolean
  fields: AtlasCardFields
  /** Stages view: the column is a stage, not a location, so the card has to say where it is from. */
  showLocation?: boolean
}) {
  const thumb = fields.thumbnail ? resolveThumb(card) : null
  // In the Stages view the location line carries what shortCardTitle strips. If
  // that line is switched off, keep the location in the title instead so the
  // card still says which practice it belongs to.
  const titleText = showLocation && !fields.location
    ? card.title.replace(ATLAS_PREFIX, '').trim() || card.title
    : shortCardTitle(card.title, locationName)
  return (
    <button
      onClick={() => onOpen(card.id)}
      style={{ borderLeft: fields.deadline ? deadlineBorder(card.first_draft_deadline) : undefined }}
      className="group relative w-full text-left border rounded-lg overflow-hidden transition-[color,background-color,border-color,box-shadow] bg-[#00152a] border-[#0075a9]/45 shadow-lg shadow-black/45 hover:border-[#0075a9]/70 hover:bg-[#002a4a]"
    >
      {/* Cover — a still frame for video, an image otherwise, and an explicit
          marker when nothing is attached. The empty state is not decoration:
          "no file" is exactly what the bulk Send-to-Adviewer skips, and until
          now it looked identical to a card whose artwork simply had not loaded. */}
      {!fields.thumbnail ? null : thumb ? (
        // Square, and object-CONTAIN not cover. These creatives are 1080x1080;
        // a landscape box with object-cover showed the middle third of a square
        // ad, slicing every headline in half — which read as a broken render
        // rather than a crop. Contain on a flat backdrop shows the whole ad, and
        // letterboxes gracefully if a non-square creative ever lands here.
        <div className="relative w-full aspect-square bg-[#00101f] flex-none">
          {thumb.video ? (
            // No controls: the whole card is the click target that opens the
            // drawer, and control chrome swallows the click on the exact pixels
            // people aim at. preload="metadata" fetches only enough to paint.
            <VideoStill className="absolute inset-0" src={videoStillSrc(thumb.url, undefined, AD_STILL_SECONDS)} />
          ) : (
            <Image
              src={thumb.url}
              alt=""
              fill
              sizes="280px"
              className="object-contain"
              unoptimized={!isSupabaseImageHost(thumb.url)}
            />
          )}
        </div>
      ) : (
        <div className="w-full flex-none flex items-center justify-center border-b border-dashed border-[#0075a9]/30 bg-[#001a33]" style={{ height: '44px' }}>
          <span className="text-[9px] font-bold uppercase tracking-widest text-[#38b6ff]/40">No file yet</span>
        </div>
      )}

      <div className="p-3">
        {/* The client name is deliberately not rendered here. Every card on the
            Atlas board belongs to Atlas Health Network, so the line was
            identical on every card — a full row of chrome carrying no
            information. The main FTE board is multi-client and keeps its
            client line; this omission is specific to this board. */}
        {showLocation && fields.location && (
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#38b6ff]/70 truncate mb-0.5" title={locationName}>
            {shortLocationName(locationName)}
          </p>
        )}
        <p
          className="text-sm text-[#e2e8f0] font-semibold leading-snug line-clamp-2 tracking-wide"
          title={card.title}
        >
          {titleText}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {/* Shown only when this column actually holds more than one media
              type. On an all-Social column the badge was on every card and so
              distinguished none of them. */}
          {showMediaBadge && card.media_type && <MediaTypeBadge type={card.media_type} />}

          {/* Work status genuinely changes over a card's life, so it stays —
              but as a dot plus label rather than a bordered pill. The colour
              still carries the state at a glance; it just no longer competes
              with the card title for attention on a board where most cards
              share the same status. */}
          {fields.work_status && card.work_status && (
            <span className={`inline-flex items-center gap-1 text-[9px] font-bold tracking-widest uppercase ${WORK_STATUS_TEXT[card.work_status]}`}>
              <span className={`w-1.5 h-1.5 rounded-full flex-none ${WORK_STATUS_DOT[card.work_status]}`} />
              {WORK_STATUS_LABELS[card.work_status]}
            </span>
          )}

          {fields.badges && card.restart_requested_at && (
            <span
              title="Adjustment to an existing campaign — restart, don't rebuild"
              className="text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase"
              style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)' }}
            >
              ↻ Re-run
            </span>
          )}

          {fields.badges && card.is_pending && (
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase"
              style={{ color: '#f97316', background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.3)' }}
            >
              Pending
            </span>
          )}

          {/* Whether the display set has been cut yet. Same reasoning as the
              "No file yet" marker: with 60 creatives in flight, "which ones
              still need display builds" is a question you should be able to
              answer by looking, not by opening every card. */}
          {fields.display_build && card.display_build_link && (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-widest uppercase text-teal-300/70" title="Display build linked">
              <span className="w-1.5 h-1.5 rounded-full flex-none bg-teal-400" />
              Display
            </span>
          )}
          {/* Was a bare coloured dot whose meaning lived only in a title
              attribute — invisible unless you hovered and already knew to. */}
          {fields.approval && card.approval_status && card.approval_status !== 'none' && (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-widest uppercase text-white/45">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${APPROVAL_DOT[card.approval_status] ?? ''}`} />
              {card.approval_status.replace('_', ' ')}
            </span>
          )}
        </div>

        {fields.adviewer_link && card.adpiler_preview_url && (
          <div className="mt-2" onClick={(e) => e.stopPropagation()}>
            <a
              href={card.adpiler_preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full leading-none border border-violet-400/30 bg-violet-400/10 text-violet-200/70 transition-colors hover:bg-violet-400/20 hover:text-violet-100 hover:border-violet-400/50"
            >
              <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-white/25 text-[8px] leading-none">→</span> View in Adviewer
            </a>
          </div>
        )}
      </div>
    </button>
  )
}
