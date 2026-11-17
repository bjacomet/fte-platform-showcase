'use client'

import { useState, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import FacebookAdPreview from '@/components/FacebookAdPreview'
import FacebookCarouselPreview from '@/components/FacebookCarouselPreview'
import type { ApprovalStatus, Card, CarouselSlide, Client, TemplateOption } from '@/types'

interface ReviewFile {
  id: string
  file_name: string
  file_url: string
  file_type: string | null
  dimensions: string | null
  approval_status: string
  created_at: string
}

interface ReviewCard {
  id: string
  title: string
  media_type: string | null
  approval_status: string
  client_portal_status: 'pending_approval' | 'running' | 'archive_review' | null
  portal_section: 'pending_approval' | 'running' | 'archive_review'
  client_comments: string | null
  fb_page_name: string | null
  fb_body_text: string | null
  fb_headline: string | null
  fb_link_description: string | null
  fb_cta: string | null
  flight_start_date: string | null
  flight_end_date: string | null
  adpiler_preview_url: string | null
  companion_banner_link: string | null
  files: ReviewFile[] | null
}

interface ReviewData {
  client_id: string
  client_name: string | null
  fb_page_logo_url: string | null
  cards: ReviewCard[] | null
}

interface ReviewSlide {
  id: string
  card_id: string
  position: number
  headline: string | null
  link_description: string | null
  landing_page_url: string | null
  image_url: string | null
  created_at: string
  updated_at: string
}

interface Props {
  data: ReviewData
  token: string
  fileUrls: Record<string, string>
  carouselSlides: Record<string, ReviewSlide[]>
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']
const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4']

const STATUS_COLORS: Record<string, string> = {
  none:               'bg-gray-100 text-gray-500 border-gray-200',
  pending:            'bg-yellow-100 text-yellow-800 border-yellow-200',
  changes_requested:  'bg-orange-100 text-orange-800 border-orange-200',
  approved:           'bg-green-100 text-green-800 border-green-200',
  rejected:           'bg-red-100 text-red-800 border-red-200',
}
const STATUS_LABELS: Record<string, string> = {
  none:               'Awaiting Review',
  pending:            'Pending Review',
  changes_requested:  'Changes Requested',
  approved:           'Approved ✓',
  rejected:           'Rejected',
}

// ── Shared: build a Card stub for FB preview components ─────────────────────
function buildPreviewCard(card: ReviewCard): Card {
  return {
    id: card.id,
    title: card.title,
    client_id: null,
    column_id: '',
    atlas_location_id: null,
    media_type: card.media_type as TemplateOption | null,
    assignee_id: null,
    referenced_card_id: null,
    description: null,
    position: 0,
    approval_token: null,
    approval_status: card.approval_status as ApprovalStatus,
    work_status: null,
    adviewer_standalone: false,
    client_comments: card.client_comments,
    creative_brief: null,
    fb_page_name: card.fb_page_name,
    fb_body_text: card.fb_body_text,
    fb_headline: card.fb_headline,
    fb_subheadline: null,
    fb_link_description: card.fb_link_description,
    fb_cta: card.fb_cta,
    source_card_id: null,
    run_number: 1,
    created_at: '',
    updated_at: '',
    archived: false,
    landing_page_url: null,
    utm_campaign: null,
    utm_channel: null,
    creative_name: null,
    flight_month: null,
    flight_start_date: card.flight_start_date,
    flight_end_date: card.flight_end_date,
    box_folder_id: null,
    ttd_ad_group_id: null,
    ttd_ad_group_ids: null,
    calendar_only: false,
    preview_image_url: null,
    adpiler_preview_url: card.adpiler_preview_url,
    tier: null,
    first_draft_deadline: null,
    build_link: null,
    display_build_link: null,
    heading: null,
    subheading: null,
    button_text: null,
    caption: null,
    boost_budget: null,
    companion_banner_link: card.companion_banner_link,
    event_description: null,
    revisions: null,
    client_portal_status: card.client_portal_status as 'pending_approval' | 'running' | 'archive_review' | null,
    inventory_unit_id: null,
    fb_campaign_id: null,
    fb_ad_id: null,
    fb_published_at: null,
    messenger_welcome: null,
    instant_experience: null,
    restart_requested_at: null,
    restart_requested_by: null,
    restart_note: null,
    is_pending: false,
    pre_pending_column_id: null,
  }
}

function buildPreviewClient(clientName: string | null, fbPageLogoUrl: string | null): Client | null {
  if (!clientName) return null
  return {
    id: '',
    name: clientName,
    abbreviation: null,
    adpiler_campaign_code: null,
    fb_page_logo_url: fbPageLogoUrl ?? null,
    utm_config: null,
    calendar_share_token: null,
    review_token: null,
    active: true,
    created_at: '',
    brand_notes: null,
    box_brand_file_id: null,
    brand_website_url: null,
    fb_ad_account_id: null,
  }
}

// ── Flight date badge ────────────────────────────────────────────────────────
function FlightBadge({ start, end }: { start: string | null; end: string | null }) {
  if (!start && !end) return null
  const fmt = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const label = start && end
    ? `${fmt(start)} – ${fmt(end)}`
    : start
    ? `Starts ${fmt(start)}`
    : `Ends ${end ? fmt(end) : ''}`
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-100 px-2 py-0.5 rounded-full font-medium">
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      {label}
    </span>
  )
}

// ── Media type pill ──────────────────────────────────────────────────────────
const MEDIA_TYPE_STYLES: Record<string, string> = {
  'Display Request':  'bg-purple-50 text-purple-700 border-purple-100',
  'Social Ad Request': 'bg-blue-50 text-blue-700 border-blue-100',
  'Carousel Ad':      'bg-blue-50 text-blue-700 border-blue-100',
  'Video Request':    'bg-rose-50 text-rose-700 border-rose-100',
  'Reel Request':     'bg-rose-50 text-rose-700 border-rose-100',
  'Audio Request':    'bg-amber-50 text-amber-700 border-amber-100',
}

// ── Media type tab filtering ─────────────────────────────────────────────────
type MediaTab = 'all' | 'display' | 'social' | 'video' | 'audio'

const DISPLAY_TYPES  = ['Display Request']
const SOCIAL_TYPES   = ['Social Ad Request', 'Carousel Ad']
const VIDEO_TYPES_MT = ['Video Request', 'Reel Request']
const AUDIO_TYPES_MT = ['Audio Request']

function cardMatchesTab(card: ReviewCard, tab: MediaTab): boolean {
  if (tab === 'all') return true
  if (tab === 'display') return DISPLAY_TYPES.includes(card.media_type ?? '')
  if (tab === 'social')  return SOCIAL_TYPES.includes(card.media_type ?? '')
  if (tab === 'video')   return VIDEO_TYPES_MT.includes(card.media_type ?? '')
  if (tab === 'audio')   return AUDIO_TYPES_MT.includes(card.media_type ?? '')
  return true
}

interface TabBarProps {
  tabs: { id: MediaTab; label: string }[]
  active: MediaTab
  counts: Record<MediaTab, number>
  onChange: (tab: MediaTab) => void
}

function TabBar({ tabs, active, counts, onChange }: TabBarProps) {
  const visible = tabs.filter((t) => counts[t.id] > 0)
  if (visible.length <= 1) return null // only one kind — no need to filter
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visible.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
            active === t.id
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400 hover:text-gray-700'
          }`}
        >
          {t.label}
          <span className={`ml-1.5 tabular-nums ${active === t.id ? 'text-gray-300' : 'text-gray-400'}`}>
            {counts[t.id]}
          </span>
        </button>
      ))}
    </div>
  )
}

function MediaPill({ type }: { type: string | null }) {
  if (!type) return null
  const style = MEDIA_TYPE_STYLES[type] ?? 'bg-gray-100 text-gray-600 border-gray-200'
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full border ${style}`}>
      {type}
    </span>
  )
}

// ── Shared file list (images, HTML banners, video, audio) ────────────────────
function FileDisplay({ files, fileUrls }: { files: ReviewFile[]; fileUrls: Record<string, string> }) {
  if (files.length === 0) return <p className="text-sm text-gray-400 italic">No files attached.</p>

  return (
    <div className="space-y-3">
      {files.map((file) => {
        const url = fileUrls[file.id]
        const isImage = IMAGE_TYPES.includes(file.file_type ?? '')
        const isHtml  = file.file_type === 'text/html'
        const isVideo = VIDEO_TYPES.includes(file.file_type ?? '')
        const isAudio = AUDIO_TYPES.includes(file.file_type ?? '')

        return (
          <div key={file.id} className="border border-gray-100 rounded-lg overflow-hidden">
            {isImage && url && (
              <a href={url} target="_blank" rel="noopener noreferrer">
                <img src={url} alt={file.file_name} className="w-full h-auto block" />
              </a>
            )}
            {isHtml && url && (
              <div className="bg-white relative" style={{ height: 240 }}>
                <iframe
                  src={url}
                  title={file.file_name}
                  className="w-full h-full"
                  sandbox="allow-scripts allow-same-origin"
                />
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="absolute top-2 right-2 bg-gray-900/70 text-white text-[10px] px-2 py-0.5 rounded hover:bg-gray-900 transition-colors"
                >
                  Open ↗
                </a>
              </div>
            )}
            {isVideo && url && (
              <video controls className="w-full" preload="metadata">
                <source src={url} type={file.file_type ?? undefined} />
              </video>
            )}
            {isAudio && url && (
              <div className="px-4 pt-4 pb-2 bg-gray-50">
                <audio controls className="w-full">
                  <source src={url} type={file.file_type ?? undefined} />
                </audio>
              </div>
            )}
            <div className="flex items-center gap-3 px-3 py-2 bg-gray-50">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{file.file_name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {file.file_type && <p className="text-xs text-gray-400">{file.file_type}</p>}
                  {file.dimensions && <p className="text-xs text-gray-400">{file.dimensions}</p>}
                </div>
              </div>
              {url && (
                <a
                  href={url}
                  download={file.file_name}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-none text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download
                </a>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Audio card media: player(s) + companion banner (uploaded image and/or link)
function AudioCardMedia({
  files,
  fileUrls,
  companionBannerLink,
}: {
  files: ReviewFile[]
  fileUrls: Record<string, string>
  companionBannerLink: string | null
}) {
  const audioFiles = files.filter((f) => AUDIO_TYPES.includes(f.file_type ?? ''))
  const bannerImageFiles = files.filter((f) => IMAGE_TYPES.includes(f.file_type ?? ''))
  // Any remaining files (e.g. HTML, PDF spec sheets) fall through to generic display
  const otherFiles = files.filter(
    (f) => !AUDIO_TYPES.includes(f.file_type ?? '') && !IMAGE_TYPES.includes(f.file_type ?? '')
  )

  const hasCompanionBanner = bannerImageFiles.length > 0 || !!companionBannerLink

  return (
    <div className="space-y-6">
      {/* Audio player(s) */}
      {audioFiles.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-amber-600" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" />
            </svg>
            Audio Spot{audioFiles.length > 1 ? 's' : ''}
          </p>
          <div className="space-y-3">
            {audioFiles.map((file) => {
              const url = fileUrls[file.id]
              return (
                <div key={file.id} className="border border-gray-100 rounded-lg overflow-hidden">
                  {url && (
                    <div className="px-4 pt-4 pb-2 bg-gray-50">
                      <audio controls className="w-full">
                        <source src={url} type={file.file_type ?? undefined} />
                      </audio>
                    </div>
                  )}
                  <div className="flex items-center gap-3 px-3 py-2 bg-gray-50 border-t border-gray-100">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{file.file_name}</p>
                      {file.file_type && <p className="text-xs text-gray-400 mt-0.5">{file.file_type}</p>}
                    </div>
                    {url && (
                      <a href={url} download={file.file_name} target="_blank" rel="noopener noreferrer"
                        className="flex-none text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Companion banner — uploaded image(s) and/or external link */}
      {hasCompanionBanner && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Companion Banner
          </p>
          <div className="space-y-3">
            {/* Uploaded banner images */}
            {bannerImageFiles.map((file) => {
              const url = fileUrls[file.id]
              return (
                <div key={file.id} className="border border-gray-100 rounded-lg overflow-hidden">
                  {url && (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      <img src={url} alt={file.file_name} className="w-full h-auto block" />
                    </a>
                  )}
                  <div className="flex items-center gap-3 px-3 py-2 bg-gray-50">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">{file.file_name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {file.file_type && <p className="text-xs text-gray-400">{file.file_type}</p>}
                        {file.dimensions && <p className="text-xs text-gray-400">{file.dimensions}</p>}
                      </div>
                    </div>
                    {url && (
                      <a href={url} download={file.file_name} target="_blank" rel="noopener noreferrer"
                        className="flex-none text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
            {/* External link fallback */}
            {companionBannerLink && (
              <a href={companionBannerLink} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                View companion banner ↗
              </a>
            )}
          </div>
        </div>
      )}

      {/* Any remaining non-audio non-image files */}
      {otherFiles.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Additional Files ({otherFiles.length})
          </p>
          <FileDisplay files={otherFiles} fileUrls={fileUrls} />
        </div>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PENDING APPROVAL — card with full review/approval form
// ══════════════════════════════════════════════════════════════════════════════

interface CardReviewState {
  decision: 'approved' | 'changes_requested' | 'rejected'
  comments: string
  submitting: boolean
  submitted: boolean
}

function PendingCard({
  card,
  clientName,
  fbPageLogoUrl,
  token,
  fileUrls,
  slides,
  onDecisionSubmitted,
}: {
  card: ReviewCard
  clientName: string | null
  fbPageLogoUrl: string | null
  token: string
  fileUrls: Record<string, string>
  slides: ReviewSlide[]
  onDecisionSubmitted: (cardId: string, decision: string) => void
}) {
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const alreadyReviewed =
    card.approval_status === 'approved' || card.approval_status === 'rejected'

  const [state, setState] = useState<CardReviewState>({
    decision: 'approved',
    comments: card.client_comments ?? '',
    submitting: false,
    submitted: alreadyReviewed,
  })

  const isSocialAd = card.media_type === 'Social Ad Request'
  const isCarousel = card.media_type === 'Carousel Ad'
  const isAudio    = card.media_type === 'Audio Request'
  const files = card.files ?? []

  const firstImageUrl =
    files
      .filter((f) => IMAGE_TYPES.includes(f.file_type ?? ''))
      .map((f) => fileUrls[f.id])
      .find(Boolean) ?? null

  const previewCard   = buildPreviewCard(card)
  const previewClient = buildPreviewClient(clientName, fbPageLogoUrl)

  async function handleSubmit() {
    setState((s) => ({ ...s, submitting: true }))
    const { error } = await supabase.rpc('submit_card_review', {
      p_token:    token,
      p_card_id:  card.id,
      p_status:   state.decision,
      p_comments: state.comments.trim() || null,
    })
    if (!error) {
      setState((s) => ({ ...s, submitting: false, submitted: true }))
      onDecisionSubmitted(card.id, state.decision)
    } else {
      setState((s) => ({ ...s, submitting: false }))
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-100">
        <div className="space-y-1.5">
          <h2 className="text-base font-bold text-gray-900">{card.title}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <MediaPill type={card.media_type} />
            <FlightBadge start={card.flight_start_date} end={card.flight_end_date} />
          </div>
        </div>
        {STATUS_LABELS[card.approval_status] && (
          <span className={`flex-none text-xs font-semibold px-2.5 py-1 rounded-full border ${STATUS_COLORS[card.approval_status]}`}>
            {STATUS_LABELS[card.approval_status]}
          </span>
        )}
      </div>

      <div className="px-6 py-5 space-y-6">
        {/* Facebook Ad Preview */}
        {isSocialAd && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <span className="text-blue-600 font-bold text-sm">f</span> Facebook Ad Preview
            </p>
            <FacebookAdPreview card={previewCard} client={previewClient} previewImageUrl={firstImageUrl} />
          </div>
        )}
        {isCarousel && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <span className="text-blue-600 font-bold text-sm">f</span> Facebook Carousel Preview
            </p>
            <FacebookCarouselPreview card={previewCard} client={previewClient} slides={slides as CarouselSlide[]} />
          </div>
        )}

        {/* Audio: dedicated player + companion banner rendering */}
        {isAudio && (
          <AudioCardMedia
            files={files}
            fileUrls={fileUrls}
            companionBannerLink={card.companion_banner_link}
          />
        )}

        {/* Adviewer preview link */}
        {card.adpiler_preview_url && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Interactive Preview</p>
            <a
              href={card.adpiler_preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Open Adviewer preview ↗
            </a>
          </div>
        )}

        {/* Non-audio files (display, social, video, etc.) */}
        {!isAudio && files.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Creative Files ({files.length})
            </p>
            <FileDisplay files={files} fileUrls={fileUrls} />
          </div>
        )}
        {!isAudio && files.length === 0 && !card.adpiler_preview_url && (
          <p className="text-sm text-gray-400 italic">No files attached yet.</p>
        )}

        {/* Approval form */}
        <div className="border-t border-gray-100 pt-5">
          {state.submitted ? (
            <div className="text-center py-3">
              <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold border ${STATUS_COLORS[state.decision]}`}>
                {state.decision === 'approved' && '✓ '}
                {STATUS_LABELS[state.decision]}
              </div>
              <p className="text-sm text-gray-400 mt-2">
                {state.decision === 'approved' ? 'Approval recorded.' : 'Feedback sent to the team.'}
              </p>
              {state.comments && (
                <div className="mt-3 text-left bg-gray-50 rounded-lg p-3 text-sm text-gray-600 border border-gray-100">
                  <p className="text-xs font-medium text-gray-400 mb-1">Your comments</p>
                  <p className="whitespace-pre-wrap">{state.comments}</p>
                </div>
              )}
              <button
                onClick={() => setState((s) => ({ ...s, submitted: false }))}
                className="mt-3 text-xs text-gray-400 hover:text-gray-600 underline"
              >
                Change response
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Your Decision</p>
              <div className="space-y-2 mb-4">
                {(
                  [
                    { value: 'approved',          label: 'Approve',         desc: 'Looks great — ready to go!',        color: 'border-green-400 bg-green-50' },
                    { value: 'changes_requested', label: 'Request Changes', desc: 'I have feedback before approving.', color: 'border-yellow-400 bg-yellow-50' },
                    { value: 'rejected',          label: 'Reject',          desc: 'This needs to be redone.',          color: 'border-red-400 bg-red-50' },
                  ] as const
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                      state.decision === opt.value ? opt.color : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name={`decision-${card.id}`}
                      value={opt.value}
                      checked={state.decision === opt.value}
                      onChange={() => setState((s) => ({ ...s, decision: opt.value }))}
                      className="mt-0.5 accent-blue-600"
                    />
                    <div>
                      <p className="text-sm font-semibold text-gray-800">{opt.label}</p>
                      <p className="text-xs text-gray-500">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-500 mb-1.5">
                  Comments{state.decision !== 'approved' && <span className="text-red-400"> *</span>}
                </label>
                <textarea
                  value={state.comments}
                  onChange={(e) => setState((s) => ({ ...s, comments: e.target.value }))}
                  rows={3}
                  placeholder={
                    state.decision === 'approved'
                      ? 'Optional — any notes for the team…'
                      : 'Please describe what needs to change…'
                  }
                  className="w-full px-3 py-2.5 text-sm bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>
              <button
                onClick={handleSubmit}
                disabled={state.submitting || (state.decision !== 'approved' && !state.comments.trim())}
                className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 ${
                  state.decision === 'approved'
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : state.decision === 'changes_requested'
                    ? 'bg-yellow-500 hover:bg-yellow-600 text-white'
                    : 'bg-red-600 hover:bg-red-700 text-white'
                }`}
              >
                {state.submitting
                  ? 'Submitting…'
                  : state.decision === 'approved'
                  ? 'Approve This Creative'
                  : state.decision === 'changes_requested'
                  ? 'Send Feedback'
                  : 'Reject This Creative'}
              </button>
              {state.decision !== 'approved' && !state.comments.trim() && (
                <p className="text-xs text-red-400 mt-2 text-center">Comments are required when not approving.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// CURRENTLY RUNNING — display-only view of live ads
// ══════════════════════════════════════════════════════════════════════════════

function RunningCard({
  card,
  clientName,
  fbPageLogoUrl,
  fileUrls,
  slides,
}: {
  card: ReviewCard
  clientName: string | null
  fbPageLogoUrl: string | null
  fileUrls: Record<string, string>
  slides: ReviewSlide[]
}) {
  const isSocialAd = card.media_type === 'Social Ad Request'
  const isCarousel = card.media_type === 'Carousel Ad'
  const isAudio    = card.media_type === 'Audio Request'
  const files = card.files ?? []

  const firstImageUrl =
    files
      .filter((f) => IMAGE_TYPES.includes(f.file_type ?? ''))
      .map((f) => fileUrls[f.id])
      .find(Boolean) ?? null

  const previewCard   = buildPreviewCard(card)
  const previewClient = buildPreviewClient(clientName, fbPageLogoUrl)

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-100">
        <div className="space-y-1.5">
          <h2 className="text-base font-bold text-gray-900">{card.title}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <MediaPill type={card.media_type} />
            <FlightBadge start={card.flight_start_date} end={card.flight_end_date} />
          </div>
        </div>
        <span className="flex-none inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border bg-green-50 text-green-700 border-green-200">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
          Live
        </span>
      </div>

      <div className="px-6 py-5 space-y-6">
        {/* Facebook preview */}
        {isSocialAd && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <span className="text-blue-600 font-bold text-sm">f</span> Facebook Ad
            </p>
            <FacebookAdPreview card={previewCard} client={previewClient} previewImageUrl={firstImageUrl} />
          </div>
        )}
        {isCarousel && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <span className="text-blue-600 font-bold text-sm">f</span> Facebook Carousel
            </p>
            <FacebookCarouselPreview card={previewCard} client={previewClient} slides={slides as CarouselSlide[]} />
          </div>
        )}

        {/* Audio: dedicated player + companion banner rendering */}
        {isAudio && (
          <AudioCardMedia
            files={files}
            fileUrls={fileUrls}
            companionBannerLink={card.companion_banner_link}
          />
        )}

        {/* Adviewer preview link */}
        {card.adpiler_preview_url && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Interactive Preview</p>
            <a
              href={card.adpiler_preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Open Adviewer preview ↗
            </a>
          </div>
        )}

        {/* Non-audio creative files */}
        {!isAudio && files.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Creative ({files.length} {files.length === 1 ? 'file' : 'files'})
            </p>
            <FileDisplay files={files} fileUrls={fileUrls} />
          </div>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PAST CREATIVES — display-only archive view (no approval actions)
// ══════════════════════════════════════════════════════════════════════════════

function PastCard({
  card,
  clientName,
  fbPageLogoUrl,
  fileUrls,
  slides,
}: {
  card: ReviewCard
  clientName: string | null
  fbPageLogoUrl: string | null
  fileUrls: Record<string, string>
  slides: ReviewSlide[]
}) {
  const isSocialAd = card.media_type === 'Social Ad Request'
  const isCarousel = card.media_type === 'Carousel Ad'
  const isAudio    = card.media_type === 'Audio Request'
  const files = card.files ?? []

  const firstImageUrl =
    files
      .filter((f) => IMAGE_TYPES.includes(f.file_type ?? ''))
      .map((f) => fileUrls[f.id])
      .find(Boolean) ?? null

  const previewCard   = buildPreviewCard(card)
  const previewClient = buildPreviewClient(clientName, fbPageLogoUrl)

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden opacity-80">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-100">
        <div className="space-y-1.5">
          <h2 className="text-base font-bold text-gray-900">{card.title}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <MediaPill type={card.media_type} />
            <FlightBadge start={card.flight_start_date} end={card.flight_end_date} />
          </div>
        </div>
        <span className="flex-none inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border bg-gray-100 text-gray-500 border-gray-200">
          Past
        </span>
      </div>

      <div className="px-6 py-5 space-y-6">
        {isSocialAd && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <span className="text-blue-600 font-bold text-sm">f</span> Facebook Ad
            </p>
            <FacebookAdPreview card={previewCard} client={previewClient} previewImageUrl={firstImageUrl} />
          </div>
        )}
        {isCarousel && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <span className="text-blue-600 font-bold text-sm">f</span> Facebook Carousel
            </p>
            <FacebookCarouselPreview card={previewCard} client={previewClient} slides={slides as CarouselSlide[]} />
          </div>
        )}
        {isAudio && (
          <AudioCardMedia
            files={files}
            fileUrls={fileUrls}
            companionBannerLink={card.companion_banner_link}
          />
        )}
        {card.adpiler_preview_url && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Interactive Preview</p>
            <a
              href={card.adpiler_preview_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              Open preview ↗
            </a>
          </div>
        )}
        {!isAudio && files.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Creative ({files.length} {files.length === 1 ? 'file' : 'files'})
            </p>
            <FileDisplay files={files} fileUrls={fileUrls} />
          </div>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// PAGE SHELL
// ══════════════════════════════════════════════════════════════════════════════

const PENDING_TABS: { id: MediaTab; label: string }[] = [
  { id: 'all',     label: 'All'     },
  { id: 'display', label: 'Display' },
  { id: 'social',  label: 'Social'  },
  { id: 'video',   label: 'Video'   },
  { id: 'audio',   label: 'Audio'   },
]

const RUNNING_TABS: { id: MediaTab; label: string }[] = [
  { id: 'display', label: 'Display' },
  { id: 'social',  label: 'Social'  },
  { id: 'video',   label: 'Video'   },
  { id: 'audio',   label: 'Audio'   },
]

export default function ReviewClient({ data, token, fileUrls, carouselSlides }: Props) {
  const allCards = data.cards ?? []
  // Partition by portal_section (RPC-computed) — falls back to client_portal_status for compatibility
  const pendingCards = allCards.filter((c) => (c.portal_section ?? c.client_portal_status) === 'pending_approval')
  const runningCards = allCards.filter((c) => (c.portal_section ?? c.client_portal_status) === 'running')
  const pastCards    = allCards.filter((c) => (c.portal_section ?? c.client_portal_status) === 'archive_review')

  const [cardStatuses, setCardStatuses] = useState<Record<string, string>>(
    () => Object.fromEntries(allCards.map((c) => [c.id, c.approval_status]))
  )
  const [pendingTab, setPendingTab] = useState<MediaTab>('all')
  const [runningTab, setRunningTab] = useState<MediaTab>('display')
  const [pastTab, setPastTab]       = useState<MediaTab>('display')

  const handleDecisionSubmitted = useCallback((cardId: string, decision: string) => {
    setCardStatuses((prev) => ({ ...prev, [cardId]: decision }))
  }, [])

  const awaitingCount = pendingCards.filter((c) => cardStatuses[c.id] === 'none').length

  // Tab counts — how many cards per tab in each section
  const pendingTabCounts = useMemo<Record<MediaTab, number>>(
    () => ({
      all:     pendingCards.length,
      display: pendingCards.filter((c) => cardMatchesTab(c, 'display')).length,
      social:  pendingCards.filter((c) => cardMatchesTab(c, 'social')).length,
      video:   pendingCards.filter((c) => cardMatchesTab(c, 'video')).length,
      audio:   pendingCards.filter((c) => cardMatchesTab(c, 'audio')).length,
    }),
    [pendingCards]
  )

  const runningTabCounts = useMemo<Record<MediaTab, number>>(
    () => ({
      all:     runningCards.length,
      display: runningCards.filter((c) => cardMatchesTab(c, 'display')).length,
      social:  runningCards.filter((c) => cardMatchesTab(c, 'social')).length,
      video:   runningCards.filter((c) => cardMatchesTab(c, 'video')).length,
      audio:   runningCards.filter((c) => cardMatchesTab(c, 'audio')).length,
    }),
    [runningCards]
  )

  const pastTabCounts = useMemo<Record<MediaTab, number>>(
    () => ({
      all:     pastCards.length,
      display: pastCards.filter((c) => cardMatchesTab(c, 'display')).length,
      social:  pastCards.filter((c) => cardMatchesTab(c, 'social')).length,
      video:   pastCards.filter((c) => cardMatchesTab(c, 'video')).length,
      audio:   pastCards.filter((c) => cardMatchesTab(c, 'audio')).length,
    }),
    [pastCards]
  )

  // Auto-correct active tab if it becomes empty
  const safePendingTab: MediaTab =
    pendingTabCounts[pendingTab] > 0 ? pendingTab : 'all'
  const safeRunningTab: MediaTab = (() => {
    if (runningTabCounts[runningTab] > 0) return runningTab
    const first = RUNNING_TABS.find((t) => runningTabCounts[t.id] > 0)
    return first?.id ?? 'display'
  })()
  const safePastTab: MediaTab = (() => {
    if (pastTabCounts[pastTab] > 0) return pastTab
    const first = RUNNING_TABS.find((t) => pastTabCounts[t.id] > 0)
    return first?.id ?? 'all'
  })()

  const visiblePendingCards = pendingCards.filter((c) => cardMatchesTab(c, safePendingTab))
  const visibleRunningCards = runningCards.filter((c) => cardMatchesTab(c, safeRunningTab))
  const visiblePastCards    = pastCards.filter((c) => cardMatchesTab(c, safePastTab))

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm flex-none">
            FTE
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {data.client_name ?? 'Creative Review'}
            </p>
            <p className="text-xs text-gray-400">Follow The Eyes — Client Portal</p>
          </div>
          {awaitingCount > 0 && (
            <span className="flex-none text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100 px-2.5 py-1 rounded-full">
              {awaitingCount} awaiting review
            </span>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-10">
        {allCards.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
            <div className="text-4xl mb-3">✓</div>
            <h2 className="text-base font-semibold text-gray-700 mb-1">Nothing here yet</h2>
            <p className="text-sm text-gray-400">
              The team will share creatives here when they&apos;re ready for your feedback.
            </p>
          </div>
        ) : (
          <>
            {/* ── AWAITING APPROVAL ─────────────────────────────────────── */}
            {pendingCards.length > 0 && (
              <section className="space-y-4">
                {/* Section header */}
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-bold text-gray-800 uppercase tracking-widest">
                    Awaiting Your Approval
                  </h2>
                  <div className="flex-1 h-px bg-gray-200" />
                  <span className="text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200 px-2 py-0.5 rounded-full">
                    {pendingCards.length} {pendingCards.length === 1 ? 'ad' : 'ads'}
                  </span>
                </div>
                <p className="text-sm text-gray-500">
                  Please review each creative and let us know your decision. You can approve, request changes, or reject each one individually.
                </p>
                {/* Tabs */}
                <TabBar
                  tabs={PENDING_TABS}
                  active={safePendingTab}
                  counts={pendingTabCounts}
                  onChange={setPendingTab}
                />
                {/* Cards */}
                {visiblePendingCards.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">No {safePendingTab} ads pending approval.</p>
                ) : (
                  visiblePendingCards.map((card) => (
                    <PendingCard
                      key={card.id}
                      card={card}
                      clientName={data.client_name}
                      fbPageLogoUrl={data.fb_page_logo_url}
                      token={token}
                      fileUrls={fileUrls}
                      slides={carouselSlides[card.id] ?? []}
                      onDecisionSubmitted={handleDecisionSubmitted}
                    />
                  ))
                )}
              </section>
            )}

            {/* ── CURRENTLY RUNNING ────────────────────────────────────── */}
            {runningCards.length > 0 && (
              <section className="space-y-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-bold text-gray-800 uppercase tracking-widest">
                    Currently Running
                  </h2>
                  <div className="flex-1 h-px bg-gray-200" />
                  <span className="text-xs font-medium bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">
                    {runningCards.length} live
                  </span>
                </div>
                <p className="text-sm text-gray-500">
                  These ads are active and currently running.
                </p>
                <TabBar
                  tabs={RUNNING_TABS}
                  active={safeRunningTab}
                  counts={runningTabCounts}
                  onChange={setRunningTab}
                />
                {visibleRunningCards.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">No {safeRunningTab} ads currently running.</p>
                ) : (
                  visibleRunningCards.map((card) => (
                    <RunningCard
                      key={card.id}
                      card={card}
                      clientName={data.client_name}
                      fbPageLogoUrl={data.fb_page_logo_url}
                      fileUrls={fileUrls}
                      slides={carouselSlides[card.id] ?? []}
                    />
                  ))
                )}
              </section>
            )}

            {/* ── PAST CREATIVES ───────────────────────────────────────── */}
            {pastCards.length > 0 && (
              <section className="space-y-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-bold text-gray-800 uppercase tracking-widest">
                    Past Creatives
                  </h2>
                  <div className="flex-1 h-px bg-gray-200" />
                  <span className="text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200 px-2 py-0.5 rounded-full">
                    {pastCards.length} {pastCards.length === 1 ? 'creative' : 'creatives'}
                  </span>
                </div>
                <p className="text-sm text-gray-500">
                  A reference archive of ads that have previously run.
                </p>
                <TabBar
                  tabs={RUNNING_TABS}
                  active={safePastTab}
                  counts={pastTabCounts}
                  onChange={setPastTab}
                />
                {visiblePastCards.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">No {safePastTab} past creatives.</p>
                ) : (
                  visiblePastCards.map((card) => (
                    <PastCard
                      key={card.id}
                      card={card}
                      clientName={data.client_name}
                      fbPageLogoUrl={data.fb_page_logo_url}
                      fileUrls={fileUrls}
                      slides={carouselSlides[card.id] ?? []}
                    />
                  ))
                )}
              </section>
            )}
          </>
        )}

        <p className="text-center text-xs text-gray-400 pb-6">
          Powered by Follow The Eyes Creative Platform
        </p>
      </main>
    </div>
  )
}
