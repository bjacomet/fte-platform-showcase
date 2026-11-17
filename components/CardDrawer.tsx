'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import dynamic from 'next/dynamic'
import type { ApprovalStatus, Card, CarouselSlide, Client, Column, InstantExperience, LocalSlide, MessengerWelcome, PsInventoryUnit, TemplateOption, WorkStatus } from '@/types'
import { APPROVAL_STATUSES, FB_BUILD_MEDIA_TYPES, TEMPLATE_OPTIONS, WORK_STATUSES, WORK_STATUS_LABELS } from '@/types'
import { createClient } from '@/lib/supabase/client'
import { FULL_CARD_SELECT } from '@/lib/cardQueries'
import { generateUtmUrl, getChannelOptions, getCampaignPresets } from '@/lib/utm'
import { handleColumnChange } from '@/lib/flights'
import { maybeGenerateAdviewerLink } from '@/lib/adviewer'
import { recordRevalidation } from '@/lib/cardCache'
import { generateThumbnail } from '@/lib/imageThumb'
import { uploadToStorageWithProgress } from '@/lib/storageUpload'
import { copyToClipboard } from '@/lib/clipboard'
import { copyForCopyTrackerDeferred, collectLandingPages, resolveCreativeName, tokenFromAdviewerUrl, adviewerDeepLink, type CopyTrackerEntry } from '@/lib/copyTracker'
import CardActivityPanel from './CardActivityPanel'
import { drawerInputClass, drawerLabelClass } from '@/lib/formStyles'
import MediaTypeBadge from './MediaTypeBadge'
import DrawerDescriptionSection from './drawer/DrawerDescriptionSection'
import DrawerDetailsSection from './drawer/DrawerDetailsSection'
import DrawerContentSection from './drawer/DrawerContentSection'
import EditableTextField from './EditableTextField'
import InventoryPicker from './InventoryPicker'
import FbPublishModal from './drawer/FbPublishModal'
import { withHttpsScheme } from '@/lib/url'

type RefCard = { id: string; title: string; preview_image_url: string | null; archived: boolean; clients?: { name: string } | null }

const FileUpload = dynamic(() => import('./FileUpload'), { ssr: false })
const FlightsTab = dynamic(() => import('./FlightsTab'), { ssr: false })
const ChangeRequestsTab = dynamic(() => import('./drawer/ChangeRequestsTab'), { ssr: false })

interface Props {
  card: Card
  columns: Column[]
  clients: Client[]
  doneColumnId: string | null
  onClose: () => void
  onUpdated: (card: Card) => void
  onDeleted: (cardId: string) => void
  onColumnChanged: (cardId: string, columnId: string) => void
  userEmail: string
  standalone?: boolean
  initialDropFiles?: File[] | null
  onInitialDropFilesConsumed?: () => void
}

type Tab = 'info' | 'files' | 'flights' | 'changes'

// Legacy header line some older carousels have above their auto-generated block.
// Consumed (removed) during recompile so it doesn't linger as orphaned text.
const SLIDES_DESC_MARKER = '--- Slide Details (auto-generated) ---'
const SLIDE_LINE_RE = /^Slide \d+:/

// A line belongs to the auto-generated block if it's a "Slide N:" line or the
// legacy marker header.
function isSlideBlockLine(line: string): boolean {
  return SLIDE_LINE_RE.test(line) || line.trim() === SLIDES_DESC_MARKER
}

// Markdown link syntax [label](url) terminates the URL at the first ")", so a landing
// URL containing a literal parenthesis (common in dealer-inventory search links) breaks
// the rendered link. Percent-encode parens before embedding so the syntax stays
// unambiguous; browsers decode %28/%29 back to ()/ on navigation.
function encodeMarkdownLinkUrl(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

// Render each slide's Text for Graphic as a Trello-style list — the content of the
// read-only "Slide Details" bin shown beneath the (editable) Creative Brief. Purely a
// reflection of the slides entered in the carousel editor; never written into
// `cards.description`. Empty string when there are no slides.
function formatSlideDetails(slides: LocalSlide[]): string {
  const sorted = slides.filter((s) => !s._deleted).sort((a, b) => a.position - b.position)
  const lines = sorted.map((s, i) => {
    const model = (s.graphic_subhead ?? '').trim()
    const offer = (s.graphic_headline ?? '').trim()
    const url = (s.landing_page_url ?? '').trim()
    let line = `Slide ${i + 1}:`
    if (model && url) line += ` [${model}](${encodeMarkdownLinkUrl(withHttpsScheme(url))})`
    else if (model) line += ` ${model}`
    else if (url) line += ` ${url}`
    if (offer) line += ` - ${offer}`
    return line
  })
  return lines.join('\n\n')
}

// Legacy carousels folded the slide list directly into `cards.description`. Now that the
// slide list lives in its own read-only bin, strip any previously-folded block out of the
// editable brief so it isn't shown (and re-saved) as stale editable text. Removes ONLY
// the contiguous run of "Slide N:" lines (plus the legacy marker and the blank separators
// between them), preserving the user's real brief text both above and below it.
function stripSlideBlock(prevDescription: string): string {
  const srcLines = prevDescription.split('\n')
  const start = srcLines.findIndex(isSlideBlockLine)
  if (start < 0) return prevDescription
  let end = start
  while (end < srcLines.length) {
    const line = srcLines[end]
    if (isSlideBlockLine(line)) { end++; continue }
    if (line.trim() === '' && end + 1 < srcLines.length && isSlideBlockLine(srcLines[end + 1])) { end++; continue }
    break
  }
  const before = srcLines.slice(0, start).join('\n').replace(/\s+$/, '')
  const after = srcLines.slice(end).join('\n').replace(/^\s+/, '')
  return [before, after].filter(Boolean).join('\n\n')
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">{title}</span>
      <div className="flex-1 h-px bg-gray-700/60" />
    </div>
  )
}

function emptySlide(cardId: string, position: number): LocalSlide {
  return {
    id: crypto.randomUUID(),
    card_id: cardId,
    position,
    headline: null,
    subheadline: null,
    link_description: null,
    display_link: null,
    graphic_headline: null,
    graphic_subhead: null,
    landing_page_url: null,
    image_url: null,
    adpiler_preview_url: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    _dirty: false,
    _deleted: false,
    _isNew: true,
  }
}

export default function CardDrawer({
  card, columns, clients, doneColumnId, onClose, onUpdated, onDeleted, onColumnChanged, userEmail,
  standalone = false, initialDropFiles = null, onInitialDropFilesConsumed,
}: Props) {
  const supabase = useMemo(() => createClient(), [])

  // ── Core ──────────────────────────────────────────────────────────────────
  const [title, setTitle]             = useState(card.title)
  const [clientId, setClientId]       = useState(card.client_id ?? '')
  const [columnId, setColumnId]       = useState(card.column_id ?? '')
  const [mediaType, setMediaType]     = useState<string>(card.media_type ?? '')
  const [approvalStatus, setApprovalStatus] = useState<ApprovalStatus>(card.approval_status)
  const [workStatus, setWorkStatus]   = useState<WorkStatus | ''>(card.work_status ?? '')
  const [tier, setTier]               = useState<'T1' | 'T2' | 'T3' | ''>(card.tier ?? '')
  const [approving, setApproving] = useState(false)
  const [approveConfirm, setApproveConfirm] = useState<{ title: string; unapprovedFiles?: number }[] | null>(null)
  const [approveMsg, setApproveMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)

  // ── Description section ───────────────────────────────────────────────────
  const [creativeName, setCreativeName] = useState(card.creative_name ?? '')
  const [buildLink, setBuildLink]       = useState(card.build_link ?? '')
  const [displayBuildLink, setDisplayBuildLink] = useState(card.display_build_link ?? '')
  const [downloadingDisplayBuild, setDownloadingDisplayBuild] = useState(false)
  const [downloadDisplayBuildError, setDownloadDisplayBuildError] = useState<string | null>(null)
  const [downloadingBuild, setDownloadingBuild] = useState(false)
  const [downloadBuildError, setDownloadBuildError] = useState<string | null>(null)
  const [publishingToFb, setPublishingToFb] = useState(false)
  const [publishFbError, setPublishFbError] = useState<string | null>(null)
  const [fbAdId, setFbAdId] = useState(card.fb_ad_id ?? null)
  const [fbCampaignId, setFbCampaignId] = useState(card.fb_campaign_id ?? null)
  const [fbPublishedAt, setFbPublishedAt] = useState(card.fb_published_at ?? null)
  const [showFbModal, setShowFbModal] = useState(false)
  const [dailyBudgetCents, setDailyBudgetCents] = useState(100)
  // Carousels used to fold the slide list into the brief; strip it on load so the
  // editable Creative Brief holds only the user's real text (the slide list now shows
  // in its own read-only bin). Non-carousel briefs are used verbatim.
  const [description, setDescription]   = useState(
    card.media_type === 'Carousel Ad' ? stripSlideBlock(card.description ?? '') : (card.description ?? '')
  )

  // ── Details section ───────────────────────────────────────────────────────
  const [firstDraftDeadline, setFirstDraftDeadline] = useState(card.first_draft_deadline ?? '')
  const [flightStartDate, setFlightStartDate]       = useState(card.flight_start_date ?? '')
  const [flightEndDate, setFlightEndDate]           = useState(card.flight_end_date ?? '')
  const [landingPageUrl, setLandingPageUrl]         = useState(card.landing_page_url ?? '')
  const [utmCampaign, setUtmCampaign]               = useState(card.utm_campaign ?? '')
  const [utmChannel, setUtmChannel]                 = useState(card.utm_channel ?? '')
  const [showUtm, setShowUtm]         = useState(!!(card.utm_campaign || card.utm_channel))
  const [utmCopied, setUtmCopied]     = useState(false)

  // ── Content — type-specific new fields ───────────────────────────────────
  const [heading, setHeading]                       = useState(card.heading ?? '')
  const [subheading, setSubheading]                 = useState(card.subheading ?? '')
  const [buttonText, setButtonText]                 = useState(card.button_text ?? '')
  const [caption, setCaption]                       = useState(card.caption ?? '')
  const [boostBudget, setBoostBudget]               = useState(card.boost_budget ?? '')
  const [companionBannerLink, setCompanionBannerLink] = useState(card.companion_banner_link ?? '')
  const [eventDescription, setEventDescription]     = useState(card.event_description ?? '')

  // ── FB / Ad Meta ──────────────────────────────────────────────────────────
  const [fbPageName, setFbPageName]           = useState(card.fb_page_name ?? card.clients?.name ?? '')
  const [fbBodyText, setFbBodyText]           = useState(card.fb_body_text ?? '')
  const [fbHeadline, setFbHeadline]           = useState(card.fb_headline ?? '')
  const [fbSubheadline, setFbSubheadline]     = useState(card.fb_subheadline ?? '')
  const [fbLinkDescription, setFbLinkDescription] = useState(card.fb_link_description ?? '')
  const [fbCta, setFbCta]                     = useState(card.fb_cta ?? 'Learn More')

  // ── Messenger Ad welcome message ──────────────────────────────────────────
  const [messengerWelcome, setMessengerWelcome] = useState<MessengerWelcome | null>(card.messenger_welcome ?? null)

  // ── Instant Experience inner blocks ───────────────────────────────────────
  const [instantExperience, setInstantExperience] = useState<InstantExperience | null>(card.instant_experience ?? null)

  // ── Carousel slides ───────────────────────────────────────────────────────
  const [slides, setSlides]           = useState<LocalSlide[]>([])
  const [slidesLoaded, setSlidesLoaded] = useState(false)
  const [uploadingSlide, setUploadingSlide] = useState<string | null>(null)
  const [dragOverSlide, setDragOverSlide] = useState<string | null>(null)
  const [rePulling, setRePulling] = useState(false)

  // ── Revisions ─────────────────────────────────────────────────────────────
  const [revisions, setRevisions]     = useState(card.revisions ?? '')

  // ── Inventory unit link ────────────────────────────────────────────────────
  const [inventoryUnitId, setInventoryUnitId] = useState<string | null>(card.inventory_unit_id ?? null)
  const [linkedUnit, setLinkedUnit]           = useState<PsInventoryUnit | null>(null)
  const [loadingLinkedUnit, setLoadingLinkedUnit] = useState(false)
  const [showInventoryPickerDrawer, setShowInventoryPickerDrawer] = useState(false)

  // ── Referenced card (durable creative reference) ───────────────────────────
  const [referencedCardId, setReferencedCardId] = useState<string | null>(card.referenced_card_id ?? null)
  const [referencedCard, setReferencedCard]     = useState<RefCard | null>(card.referenced_card ?? null)
  const [refPickerOpen, setRefPickerOpen]       = useState(false)
  const [refQuery, setRefQuery]                 = useState('')
  const [refResults, setRefResults]             = useState<RefCard[]>([])
  const [refSearching, setRefSearching]         = useState(false)

  // ── TTD Campaign / Ad Group ───────────────────────────────────────────────
  const isTtdType = ['Display Request', 'Video Request', 'Audio Request', 'CTV'].includes(mediaType)
  const [ttdAdGroupIds, setTtdAdGroupIds] = useState<string[]>(card.ttd_ad_group_ids ?? [])
  const [ttdCampaigns, setTtdCampaigns] = useState<{ id: string; name: string; ttd_campaign_id: string; ttd_ad_groups: { id: string; name: string; ttd_ad_group_id: string }[] }[]>([])
  const [ttdCampaignId, setTtdCampaignId] = useState<string>('')
  const [ttdCampaignsLoaded, setTtdCampaignsLoaded] = useState(false)

  useEffect(() => {
    if (!isTtdType || !clientId || ttdCampaignsLoaded) return
    supabase
      .from('ttd_campaigns')
      .select('id, name, ttd_campaign_id, ttd_ad_groups(id, name, ttd_ad_group_id)')
      .eq('client_id', clientId)
      .order('name')
      .then(({ data }) => {
        const rows = (data ?? []) as typeof ttdCampaigns
        setTtdCampaigns(rows)
        setTtdCampaignsLoaded(true)
        // Restore selected campaign from any saved ad group ids
        const savedIds = card.ttd_ad_group_ids ?? []
        if (savedIds.length > 0) {
          for (const campaign of rows) {
            if (campaign.ttd_ad_groups.some(ag => savedIds.includes(ag.id))) {
              setTtdCampaignId(campaign.id)
              break
            }
          }
        }
      })
  }, [isTtdType, clientId, ttdCampaignsLoaded, card.ttd_ad_group_ids, supabase])

  // Reset TTD selection when client changes — done during render (not in an
  // effect) per React's "adjusting state when a prop changes" pattern; avoids
  // the react-hooks/set-state-in-effect cascade and a stale intermediate render
  const [prevTtdClientId, setPrevTtdClientId] = useState(clientId)
  if (prevTtdClientId !== clientId) {
    setPrevTtdClientId(clientId)
    setTtdCampaignsLoaded(false)
    setTtdCampaigns([])
    setTtdCampaignId('')
    setTtdAdGroupIds([])
  }

  const ttdAdGroupsForCampaign = useMemo(
    () => ttdCampaigns.find(c => c.id === ttdCampaignId)?.ttd_ad_groups ?? [],
    [ttdCampaigns, ttdCampaignId]
  )

  function handleTtdAdGroupToggle(id: string) {
    setTtdAdGroupIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  function handleTtdSelectAll() {
    const allIds = ttdAdGroupsForCampaign.map(ag => ag.id)
    const allSelected = allIds.every(id => ttdAdGroupIds.includes(id))
    setTtdAdGroupIds(allSelected ? ttdAdGroupIds.filter(id => !allIds.includes(id)) : [...new Set([...ttdAdGroupIds, ...allIds])])
  }

  // ── Adviewer ──────────────────────────────────────────────────────────────
  const [adviewerUrl, setAdviewerUrl]           = useState<string | null>(
    card.adpiler_preview_url?.includes('/adviewer/c/') ? card.adpiler_preview_url : null
  )
  const [adviewerLinkCopied, setAdviewerLinkCopied] = useState(false)
  const [copyTrackerCopied, setCopyTrackerCopied]   = useState(false)
  const [sendingToAdviewer, setSendingToAdviewer]   = useState(false)
  const [adviewerStandalone, setAdviewerStandalone] = useState(card.adviewer_standalone ?? false)

  async function handleSendToAdviewer() {
    if (sendingToAdviewer || !card.id) return
    setSendingToAdviewer(true)
    try {
      const res = await fetch('/api/adviewer/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: card.id }),
      })
      const json = await res.json() as { previewUrl?: string }
      if (json.previewUrl) setAdviewerUrl(json.previewUrl)
    } finally {
      setSendingToAdviewer(false)
    }
  }

  async function handleCopyAdviewerLink() {
    if (!adviewerUrl) return
    const ok = await copyToClipboard(adviewerUrl)
    if (!ok) return
    setAdviewerLinkCopied(true)
    setTimeout(() => setAdviewerLinkCopied(false), 2000)
  }

  function handleCopyForCopyTracker() {
    // Label comes from the creative file name (dimensions stripped), and the Adviewer link
    // deep-links to THIS card's creative (?only=campaignCardId) so a shared campaign opens
    // the right creative. Both need fetches; the clipboard write is issued synchronously
    // below (deferred blobs) so the fetch's await doesn't drop the click's user activation.
    const token = tokenFromAdviewerUrl(adviewerUrl)
    const accIdPromise: Promise<string | null> = token
      ? Promise.resolve(
          supabase
            .from('adviewer_campaign_cards')
            .select('id, adviewer_campaigns!inner(token)')
            .eq('card_id', card.id)
            .eq('adviewer_campaigns.token', token),
        ).then(({ data }) => (data?.[0] as { id: string } | undefined)?.id ?? null)
      : Promise.resolve(null)
    const entryPromise: Promise<CopyTrackerEntry> = Promise.all([
      Promise.resolve(supabase.from('card_files').select('file_name').eq('card_id', card.id).order('created_at', { ascending: true })),
      accIdPromise,
    ]).then(([filesRes, accId]) => ({
      creativeName: resolveCreativeName(
        filesRes.data as { file_name: string | null }[] | null,
        creativeName,
        title,
      ),
      adviewerUrl: adviewerDeepLink(adviewerUrl, accId),
      cardUrl: `${window.location.origin}/card/${card.id}`,
      landingPages: collectLandingPages(
        landingPageUrl,
        mediaType === 'Carousel Ad' ? slides.filter((s) => !s._deleted) : null,
      ),
      endDate: flightEndDate || null,
    }))
    copyForCopyTrackerDeferred(entryPromise).then((ok) => {
      if (!ok) return
      setCopyTrackerCopied(true)
      setTimeout(() => setCopyTrackerCopied(false), 2000)
    })
  }

  // ── Client portal ─────────────────────────────────────────────────────────
  const [clientPortalStatus, setClientPortalStatus] = useState<'pending_approval' | 'running' | 'archive_review' | null>(card.client_portal_status ?? null)
  const [clientReviewToken, setClientReviewToken]   = useState<string | null>(card.clients?.review_token ?? null)
  const [portalLinkCopied, setPortalLinkCopied]     = useState(false)
  const [cardLinkCopied, setCardLinkCopied]         = useState(false)

  // ── UI state ──────────────────────────────────────────────────────────────
  const [tab, setTab]                 = useState<Tab>('info')
  const [saving, setSaving]           = useState(false)
  // Why a visible error and not just a console line: a failed save used to stop
  // the spinner and return, leaving the drawer looking exactly like a success.
  // The user closed it believing the card was written. Silent data loss.
  const [saveError, setSaveError]     = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [showDiscardWarning, setShowDiscardWarning] = useState(false)
  const [isManuallyLive, setIsManuallyLive] = useState(false)
  const [liveToggleLoading, setLiveToggleLoading] = useState(false)
  const [savedOnce, setSavedOnce] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [heroLoaded, setHeroLoaded] = useState(false)
  const [activityReady, setActivityReady] = useState(false)
  const tabScrollRef = useRef<HTMLDivElement>(null)
  const [flightsEverOpened, setFlightsEverOpened] = useState(false)

  // Drawer-level drag-and-drop → routes dropped files to Files tab
  const [drawerDragOver, setDrawerDragOver]   = useState(false)
  const [pendingDropFiles, setPendingDropFiles] = useState<File[] | null>(null)

  // Close lightbox on ESC
  useEffect(() => {
    if (!lightboxOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxOpen])

  // Suppress backdrop-blur on board columns while drawer is open
  useEffect(() => {
    document.body.classList.add('drawer-open')
    return () => document.body.classList.remove('drawer-open')
  }, [])

  // Defer activity panel mount so its Supabase subscription doesn't hitch the opening animation
  useEffect(() => {
    const t = setTimeout(() => setActivityReady(true), 150)
    return () => clearTimeout(t)
  }, [])

  // Reset scroll position when switching tabs so each tab always starts at the top
  useEffect(() => {
    tabScrollRef.current?.scrollTo({ top: 0 })
  }, [tab])

  // ── Fetch linked inventory unit ───────────────────────────────────────────
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (inventoryUnitId) {
      setLoadingLinkedUnit(true)
      supabase
        .from('ps_inventory_units')
        .select('*, ps_dealers(id, name)')
        .eq('id', inventoryUnitId)
        .single()
        .then(({ data }) => {
          setLinkedUnit((data as PsInventoryUnit) ?? null)
          setLoadingLinkedUnit(false)
        })
    } else {
      setLinkedUnit(null)
    }
  }, [inventoryUnitId])
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Fetch referenced card for display ─────────────────────────────────────
  // setState fires only inside the async .then — clearing on removal is handled
  // by the Remove button, so the effect never sets state synchronously.
  useEffect(() => {
    if (!referencedCardId || referencedCard?.id === referencedCardId) return
    supabase
      .from('cards')
      .select('id, title, preview_image_url, archived, clients(name)')
      .eq('id', referencedCardId)
      .single()
      .then(({ data }) => { if (data) setReferencedCard(data as unknown as RefCard) })
  }, [referencedCardId, referencedCard?.id, supabase])

  // ── Reference picker search (debounced) ───────────────────────────────────
  // Runs from the input's change handler rather than an effect: setState in an
  // event handler is fine, whereas setState inside an effect trips the compiler
  // "cascading renders" rule.
  const refDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function handleRefQueryChange(value: string) {
    setRefQuery(value)
    if (refDebounceRef.current) clearTimeout(refDebounceRef.current)
    const q = value.trim()
    if (q.length < 2) { setRefResults([]); setRefSearching(false); return }
    setRefSearching(true)
    refDebounceRef.current = setTimeout(() => {
      supabase
        .from('cards')
        .select('id, title, preview_image_url, archived, clients(name)')
        .ilike('title', `%${q}%`)
        .eq('archived', false)
        .neq('id', card.id)
        .order('updated_at', { ascending: false })
        .limit(8)
        .then(({ data }) => {
          setRefResults((data as unknown as RefCard[]) ?? [])
          setRefSearching(false)
        })
    }, 250)
  }

  // ── Computed flags ────────────────────────────────────────────────────────
  const isSocialAd = mediaType === 'Social Ad Request'
  const isCarousel = mediaType === 'Carousel Ad'
  const isOrganic  = mediaType === 'Organic Post'
  const isVideo    = mediaType === 'Video Request' || mediaType === 'Reel Request'
  const isAudio    = mediaType === 'Audio Request'
  const isFbEvent  = mediaType === 'FB Event Cover'
  const isDisplay  = mediaType === 'Display Request'
  const isMessenger = mediaType === 'Messenger Ad'
  const isInstantExperience = mediaType === 'Instant Experience'
  // These card types have their own block-level drop zones (carousel slides, IE
  // block media, messenger — no drawer-level file drop), so the drawer-wide
  // drag/upload overlay must stay out of their way.
  const usesBlockEditor = isCarousel || isInstantExperience || isMessenger
  const hasFbMeta  = isSocialAd || isCarousel
  const hasContent = isDisplay || hasFbMeta || isOrganic || isVideo || isAudio || isFbEvent || isMessenger || isInstantExperience

  const activeClient = useMemo(
    () => clients.find((c) => c.id === clientId) ?? null,
    [clients, clientId]
  )

  // Read-only reflection of the carousel slides, shown beneath the editable Creative
  // Brief. Derived live from slide state — never persisted or merged into `description`.
  const slideDetails = useMemo(
    () => (isCarousel ? formatSlideDetails(slides) : ''),
    [isCarousel, slides]
  )

  // Only admin@example.com sees the publish button, and only in the two
  // final-review columns where ads are ready to go.
  const showPublishButton = useMemo(() => {
    if (userEmail !== 'admin@example.com') return false
    const publishableIds = columns
      .filter(c => c.title === 'Ready for Traffic' || c.title === 'Ready for Digital')
      .map(c => c.id)
    return publishableIds.includes(columnId) && !fbAdId
  }, [userEmail, columns, columnId, fbAdId])

  // ── UTM ───────────────────────────────────────────────────────────────────
  const channelOptions  = useMemo(() => getChannelOptions(activeClient), [activeClient])
  const campaignPresets = useMemo(() => getCampaignPresets(activeClient), [activeClient])
  const generatedUtmUrl = useMemo(
    () => generateUtmUrl({ baseUrl: landingPageUrl, campaign: utmCampaign, channel: utmChannel, client: activeClient }),
    [landingPageUrl, utmCampaign, utmChannel, activeClient]
  )

  // Baseline the brief against the same stripped value used to seed the editor, so a
  // legacy carousel (whose stored description still has the folded slide block) doesn't
  // read as dirty the moment it opens.
  const descriptionBaseline = isCarousel ? stripSlideBlock(card.description ?? '') : (card.description ?? '')

  // ── Dirty check ───────────────────────────────────────────────────────────
  const dirty = useMemo(() => (
    title !== card.title ||
    description !== descriptionBaseline ||
    clientId !== (card.client_id ?? '') ||
    columnId !== (card.column_id ?? '') ||
    mediaType !== (card.media_type ?? '') ||
    approvalStatus !== card.approval_status ||
    workStatus !== (card.work_status ?? '') ||
    tier !== (card.tier ?? '') ||
    creativeName !== (card.creative_name ?? '') ||
    buildLink !== (card.build_link ?? '') ||
    displayBuildLink !== (card.display_build_link ?? '') ||
    firstDraftDeadline !== (card.first_draft_deadline ?? '') ||
    flightStartDate !== (card.flight_start_date ?? '') ||
    flightEndDate !== (card.flight_end_date ?? '') ||
    landingPageUrl !== (card.landing_page_url ?? '') ||
    utmCampaign !== (card.utm_campaign ?? '') ||
    utmChannel !== (card.utm_channel ?? '') ||
    heading !== (card.heading ?? '') ||
    subheading !== (card.subheading ?? '') ||
    buttonText !== (card.button_text ?? '') ||
    caption !== (card.caption ?? '') ||
    boostBudget !== (card.boost_budget ?? '') ||
    companionBannerLink !== (card.companion_banner_link ?? '') ||
    eventDescription !== (card.event_description ?? '') ||
    revisions !== (card.revisions ?? '') ||
    fbPageName !== (card.fb_page_name ?? card.clients?.name ?? '') ||
    fbBodyText !== (card.fb_body_text ?? '') ||
    fbHeadline !== (card.fb_headline ?? '') ||
    fbSubheadline !== (card.fb_subheadline ?? '') ||
    fbLinkDescription !== (card.fb_link_description ?? '') ||
    fbCta !== (card.fb_cta ?? 'Learn More') ||
    clientPortalStatus !== (card.client_portal_status ?? null) ||
    adviewerStandalone !== (card.adviewer_standalone ?? false) ||
    inventoryUnitId !== (card.inventory_unit_id ?? null) ||
    referencedCardId !== (card.referenced_card_id ?? null) ||
    JSON.stringify(ttdAdGroupIds.slice().sort()) !== JSON.stringify((card.ttd_ad_group_ids ?? []).slice().sort()) ||
    JSON.stringify(messengerWelcome) !== JSON.stringify(card.messenger_welcome ?? null) ||
    JSON.stringify(instantExperience) !== JSON.stringify(card.instant_experience ?? null) ||
    slides.some((s) => s._dirty || s._deleted || s._isNew)
  ), [
    title, description, descriptionBaseline, clientId, columnId, mediaType, approvalStatus, workStatus, tier,
    creativeName, buildLink, displayBuildLink, firstDraftDeadline, flightStartDate, flightEndDate,
    landingPageUrl, utmCampaign, utmChannel,
    heading, subheading, buttonText, caption, boostBudget, companionBannerLink, eventDescription,
    revisions, fbPageName, fbBodyText, fbHeadline, fbSubheadline, fbLinkDescription, fbCta,
    clientPortalStatus, adviewerStandalone, inventoryUnitId, referencedCardId, ttdAdGroupIds,
    messengerWelcome, instantExperience, slides, card,
  ])

  // ── Escape key ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (standalone) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (dirty) setShowDiscardWarning(true)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, onClose, standalone])

  // ── Load carousel slides ──────────────────────────────────────────────────
  // Baseline of each slide's saved image_url — lets Save detect a slide-graphic
  // replacement and snapshot the Adviewer round anchored to that slide first.
  const originalSlideImagesRef = useRef<Record<string, string | null>>({})
  useEffect(() => {
    if (!isCarousel || slidesLoaded) return
    supabase
      .from('carousel_slides')
      .select('*')
      .eq('card_id', card.id)
      .order('position', { ascending: true })
      .then(({ data }: { data: CarouselSlide[] | null }) => {
        const loaded = (data ?? []).map((s) => ({
          ...s, _dirty: false, _deleted: false, _isNew: false,
        }))
        originalSlideImagesRef.current = Object.fromEntries(loaded.map((s) => [s.id, s.image_url ?? null]))
        setSlides(loaded.length > 0 ? loaded : [emptySlide(card.id, 0)])
        setSlidesLoaded(true)
      })
  }, [isCarousel, slidesLoaded, card.id, supabase])

  // ── Check manual live status ──────────────────────────────────────────────
  useEffect(() => {
    if (card.column_id === doneColumnId) return
    supabase
      .from('card_flights')
      .select('id')
      .eq('card_id', card.id)
      .eq('triggered_by', 'manual')
      .is('went_dark_at', null)
      .eq('voided', false)
      .limit(1)
      .then(({ data }: { data: { id: string }[] | null }) => setIsManuallyLive((data?.length ?? 0) > 0))
  }, [card.id, card.column_id, doneColumnId, supabase])

  // ── Save ──────────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true)
    setSaveError(null)

    // The Creative Brief is saved verbatim — the carousel slide list is no longer folded
    // into it (it lives in its own read-only bin, derived from the slides). handleSave
    // persists exactly what the user typed, so nothing they wrote can be overwritten.

    // Changing the column here (not just the board's drag-and-drop / quick
    // actions) can also move a card into or out of Pending — keep is_pending
    // and pre_pending_column_id in sync with column_id in that case too.
    const pendingColumnId = columns.find((c) => c.title === 'Pending')?.id ?? null
    const pendingUpdate: Partial<Card> =
      pendingColumnId && columnId === pendingColumnId && card.column_id !== pendingColumnId
        ? { is_pending: true, pre_pending_column_id: card.column_id }
        : pendingColumnId && card.column_id === pendingColumnId && columnId !== pendingColumnId
          ? { is_pending: false, pre_pending_column_id: null }
          : {}

    const updates = {
      title: title.trim(),
      description: description.trim() || null,
      client_id: clientId || null,
      // Atlas cards have no board column; persist null rather than an empty string.
      column_id: columnId || null,
      media_type: (mediaType as TemplateOption) || null,
      // Only when the user changed it here. The client can change approval while
      // the drawer is open (Adviewer notify / pin resolve); always writing the
      // drawer's copy wiped that verdict, and on Atlas it also fired the
      // cards_atlas_auto_stage trigger as if a revision had been uploaded.
      ...(approvalStatus !== card.approval_status ? { approval_status: approvalStatus } : {}),
      work_status: (workStatus as WorkStatus) || null,
      tier: (tier as 'T1' | 'T2' | 'T3') || null,
      creative_name: creativeName.trim() || null,
      build_link: buildLink.trim() || null,
      display_build_link: displayBuildLink.trim() || null,
      first_draft_deadline: firstDraftDeadline || null,
      flight_start_date: flightStartDate || null,
      flight_end_date: flightEndDate || null,
      landing_page_url: landingPageUrl.trim() || null,
      utm_campaign: utmCampaign.trim() || null,
      utm_channel: utmChannel || null,
      heading: heading.trim() || null,
      subheading: subheading.trim() || null,
      button_text: buttonText.trim() || null,
      caption: caption.trim() || null,
      boost_budget: boostBudget.trim() || null,
      companion_banner_link: companionBannerLink.trim() || null,
      event_description: eventDescription.trim() || null,
      revisions: revisions.trim() || null,
      fb_page_name: fbPageName.trim() || null,
      fb_body_text: fbBodyText.trim() || null,
      fb_headline: fbHeadline.trim() || null,
      fb_subheadline: fbSubheadline.trim() || null,
      fb_link_description: fbLinkDescription.trim() || null,
      fb_cta: fbCta || 'Learn More',
      client_portal_status: clientPortalStatus,
      adviewer_standalone: adviewerStandalone,
      inventory_unit_id: inventoryUnitId || null,
      messenger_welcome: messengerWelcome,
      instant_experience: instantExperience,
      referenced_card_id: referencedCardId,
      ttd_ad_group_id: ttdAdGroupIds[0] ?? null,
      ttd_ad_group_ids: ttdAdGroupIds.length > 0 ? ttdAdGroupIds : null,
      updated_at: new Date().toISOString(),
      ...pendingUpdate,
    }

    const { error } = await supabase.from('cards').update(updates).eq('id', card.id)
    if (error) {
      console.error('Card save failed:', error.message)
      setSaveError(`Save failed — nothing was written. ${error.message}`)
      setSaving(false)
      return
    }

    if (card.column_id && columnId && columnId !== card.column_id) {
      if (doneColumnId) {
        await handleColumnChange(supabase, card.id, card.column_id, columnId, doneColumnId)
      }
      const srcCol = columns.find((c) => c.id === card.column_id)
      const dstCol = columns.find((c) => c.id === columnId)
      if (srcCol && dstCol) {
        await supabase.from('card_activity').insert({
          card_id: card.id,
          actor: userEmail,
          action: 'moved',
          detail: `moved this card from "${srcCol.title}" to "${dstCol.title}"`,
        })
      }
      onColumnChanged(card.id, columnId)
    }

    if (isCarousel) {
      // Replace lifecycle: a slide whose saved graphic is being swapped for a new
      // one supersedes that slide's Adviewer review round. Freeze those pins into
      // client_notes.history (with an old-graphic thumbnail) BEFORE the new
      // image_url lands, then the old file is safe to delete. Best-effort.
      const STORAGE_PUBLIC_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/creative-files/`
      const replacedSlides = slides.filter((s) => {
        if (s._deleted || s._isNew || !s._dirty) return false
        const oldImg = originalSlideImagesRef.current[s.id] ?? null
        return !!oldImg && oldImg !== (s.image_url ?? null)
      })
      for (const s of replacedSlides) {
        const oldImg = originalSlideImagesRef.current[s.id]!
        const oldUrl = oldImg.startsWith('http') ? oldImg : STORAGE_PUBLIC_BASE + oldImg
        let thumbUrl: string | null = null
        const blob = await generateThumbnail(oldUrl)
        if (blob) {
          const thumbPath = `history/${card.id}/slide-${s.id}-${Date.now()}.jpg`
          const { error: thumbErr } = await supabase.storage
            .from('creative-files')
            .upload(thumbPath, blob, { contentType: 'image/jpeg', upsert: true })
          if (!thumbErr) {
            const { data: pub } = supabase.storage.from('creative-files').getPublicUrl(thumbPath)
            thumbUrl = pub?.publicUrl ?? null
          }
        }
        try {
          await fetch('/api/adviewer/snapshot-card-round', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardId: card.id, slideId: s.id, label: `Slide ${s.position + 1}`, thumbUrl }),
          })
        } catch { /* snapshot is best-effort — never block the save */ }
      }

      const toDelete = slides.filter((s) => s._deleted && !s._isNew).map((s) => s.id)
      const toUpsert = slides
        .filter((s) => !s._deleted && (s._dirty || s._isNew))
        .map(({ _dirty, _deleted, _isNew, ...s }) => ({ ...s, updated_at: new Date().toISOString() }))
      if (toDelete.length > 0) await supabase.from('carousel_slides').delete().in('id', toDelete)
      if (toUpsert.length > 0) {
        const { error: upsertError } = await supabase.from('carousel_slides').upsert(toUpsert)
        if (upsertError) {
          console.error('Slide upsert failed:', upsertError.message)
          // The card row above already saved; only the slides did not. Say so,
          // so the user does not re-edit fields that are in fact persisted.
          setSaveError(`Card saved, but the carousel slides did not. ${upsertError.message}`)
          setSaving(false)
          return
        }
      }
      const { data: fresh } = await supabase
        .from('carousel_slides').select('*').eq('card_id', card.id).order('position', { ascending: true })
      const freshSlides = ((fresh as CarouselSlide[]) ?? []).map((s) => ({ ...s, _dirty: false, _deleted: false, _isNew: false }))
      originalSlideImagesRef.current = Object.fromEntries(freshSlides.map((s) => [s.id, s.image_url ?? null]))
      setSlides(freshSlides)

      // Sync first slide's Adviewer URL to card-level field so board shows "View in Adviewer".
      // Strip any #slide-N anchor: the card-level link is the whole-campaign link, hash-free.
      const firstAdpilerUrl = freshSlides.find((s) => s.adpiler_preview_url)?.adpiler_preview_url ?? null
      const cardLevelUrl = firstAdpilerUrl ? firstAdpilerUrl.split('#')[0] : null

      // Use the first slide's image as the board cover (preview_image_url) so carousel cards
      // show a thumbnail like single-file cards do. For a carousel the cover always tracks the
      // slides — so when every slide's graphic is removed the cover clears too (null), instead
      // of a stale first-slide image lingering on the board card and drawer preview with no way
      // to delete it.
      const coverImage = freshSlides.find((s) => s.image_url)?.image_url ?? null
      const cardUpdate: { adpiler_preview_url: string | null; preview_image_url: string | null } = {
        adpiler_preview_url: cardLevelUrl,
        preview_image_url: coverImage,
      }
      await supabase.from('cards').update(cardUpdate).eq('id', card.id)
    }

    // When the Build link changes, wire the card to its Box Build folder. Runs after the
    // slide upsert above so the pull isn't clobbered by the in-memory (image-less) slides.
    // Best-effort — a Box hiccup must never fail the save.
    if (buildLink.trim() && buildLink.trim() !== (card.build_link ?? '').trim()) {
      try {
        if (isCarousel) {
          // Import the folder's graphics onto slides by _NN (and set box_folder_id + cover).
          await fetch('/api/box/pull-slides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardId: card.id }),
          })
          // Refetch so the imported images show and a later save won't overwrite them.
          const { data: pulled } = await supabase
            .from('carousel_slides').select('*').eq('card_id', card.id).order('position', { ascending: true })
          if (pulled) {
            const pulledSlides = (pulled as CarouselSlide[]).map((s) => ({ ...s, _dirty: false, _deleted: false, _isNew: false }))
            originalSlideImagesRef.current = Object.fromEntries(pulledSlides.map((s) => [s.id, s.image_url ?? null]))
            setSlides(pulledSlides)
          }
        } else {
          // Non-carousel: just store box_folder_id so the file-sync webhook can match this card.
          await fetch('/api/box/resolve-folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sharedLink: buildLink.trim(), cardId: card.id }),
          })
        }
      } catch { /* ignore — auto-sync/import just won't run until Box is reachable */ }
    }

    // Adviewer trigger — changing the Column dropdown to "Ready for Adviewer" here
    // publishes the card, same as dragging or bulk-moving it in. Runs after the
    // carousel block (which can rewrite adpiler_preview_url) so the link sticks,
    // and before the refetch below so `updated` reflects it. Best-effort.
    if (card.column_id && columnId && columnId !== card.column_id) {
      await maybeGenerateAdviewerLink(columns, card.id, columnId)
    }

    await supabase.from('card_activity').insert({
      card_id: card.id, actor: userEmail, action: 'updated', detail: 'Card updated',
    })

    const { data: updated } = await supabase
      .from('cards')
      .select(FULL_CARD_SELECT)
      .eq('id', card.id)
      .single()

    setSavedOnce(true)
    setSaving(false)
    if (updated) onUpdated(updated as Card)
    if (!standalone) onClose()
    // Fire-and-forget: invalidate board ISR cache and card page ISR cache
    recordRevalidation()
    void fetch('/api/revalidate-board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId: card.id }),
    })
  }

  // Same route as the social build, with variant=display so the ZIP is just the
  // files. cardId is still sent — it is what the route auth-checks on — but the
  // variant stops it laying the set out as an FB build and appending a
  // facebook_upload.xlsx, which is the wrong sheet for HTML5 banners.
  async function handleDownloadDisplayBuild() {
    const link = displayBuildLink.trim()
    if (!link) return
    setDownloadingDisplayBuild(true)
    setDownloadDisplayBuildError(null)
    try {
      const res = await fetch(`/api/box/download-build?sharedLink=${encodeURIComponent(link)}&cardId=${encodeURIComponent(card.id)}&variant=display`)
      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error ?? `Download failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = blob.type === 'application/zip' ? 'display-build.zip' : 'display-build'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setDownloadDisplayBuildError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloadingDisplayBuild(false)
    }
  }

  async function handleDownloadBuild() {
    if (!buildLink) return
    setDownloadingBuild(true)
    setDownloadBuildError(null)
    try {
      const res = await fetch(`/api/box/download-build?sharedLink=${encodeURIComponent(buildLink)}&cardId=${encodeURIComponent(card.id)}`)
      if (!res.ok) {
        const json = await res.json() as { error?: string }
        throw new Error(json.error ?? `Download failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = blob.type === 'application/zip' ? 'build.zip' : 'build'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setDownloadBuildError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloadingBuild(false)
    }
  }

  function handlePublishToFb() {
    setPublishFbError(null)
    setShowFbModal(true)
  }

  async function handleConfirmFbPublish(opts: {
    adAccountId: string
    existingCampaignId?: string
    existingAdSetId?: string
    dailyBudgetCents: number
  }) {
    setPublishingToFb(true)
    setPublishFbError(null)
    try {
      const res = await fetch('/api/facebook/publish-ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: card.id,
          adAccountId: opts.adAccountId,
          existingCampaignId: opts.existingCampaignId,
          existingAdSetId: opts.existingAdSetId,
          dailyBudgetCents: opts.dailyBudgetCents,
        }),
      })
      const json = await res.json() as {
        campaignId?: string; adId?: string; fb_published_at?: string; error?: string
      }
      if (!res.ok) throw new Error(json.error ?? `Publish failed (${res.status})`)
      setFbAdId(json.adId ?? null)
      setFbCampaignId(json.campaignId ?? null)
      setFbPublishedAt(json.fb_published_at ?? null)
      setShowFbModal(false)
    } catch (err) {
      setPublishFbError(err instanceof Error ? err.message : 'Publish failed')
    } finally {
      setPublishingToFb(false)
    }
  }

  async function handleCopyPortalLink() {
    if (!clientId) return
    let token = clientReviewToken
    if (!token) {
      const { data: existing } = await supabase
        .from('clients').select('review_token').eq('id', clientId).single()
      token = existing?.review_token ?? null
    }
    if (!token) {
      const newToken = crypto.randomUUID()
      await supabase.from('clients').update({ review_token: newToken }).eq('id', clientId)
      token = newToken
    }
    setClientReviewToken(token)
    const ok = await copyToClipboard(`${window.location.origin}/review/${token}`)
    if (!ok) return
    setPortalLinkCopied(true)
    setTimeout(() => setPortalLinkCopied(false), 2000)
  }

  // Copies a permanent link to THIS card. Uses /card/<id> — the id never changes,
  // so the link survives token rotations and file swaps (unlike a /review link).
  async function handleCopyCardLink() {
    const ok = await copyToClipboard(`${window.location.origin}/card/${card.id}`)
    if (!ok) return
    setCardLinkCopied(true)
    setTimeout(() => setCardLinkCopied(false), 2000)
  }

  async function handleDelete() {
    await supabase.from('cards').delete().eq('id', card.id)
    onDeleted(card.id)
  }

  async function handleArchive() {
    await supabase.from('cards').update({ archived: true, updated_at: new Date().toISOString() }).eq('id', card.id)
    await supabase.from('card_activity').insert({ card_id: card.id, actor: userEmail, action: 'archived', detail: 'Card archived' })
    onDeleted(card.id)
  }

  async function handleLiveToggle() {
    setLiveToggleLoading(true)
    if (isManuallyLive) {
      const { data: flights } = await supabase
        .from('card_flights').select('id').eq('card_id', card.id).is('went_dark_at', null).eq('voided', false)
      if (flights && flights.length > 0) {
        await supabase.from('card_flights')
          .update({ went_dark_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .in('id', (flights as { id: string }[]).map((f) => f.id))
      }
      setIsManuallyLive(false)
    } else {
      await supabase.from('card_flights').insert({
        card_id: card.id, previous_column_id: columnId,
        went_live_at: new Date().toISOString(), triggered_by: 'manual',
      })
      setIsManuallyLive(true)
    }
    setLiveToggleLoading(false)
  }

  // ── Carousel handlers ─────────────────────────────────────────────────────
  const handleAddSlide = useCallback(() => {
    setSlides((prev) => [...prev, emptySlide(card.id, prev.filter((s) => !s._deleted).length)])
  }, [card.id])

  const handleRemoveSlide = useCallback((id: string) => {
    setSlides((prev) => prev.map((s) => s.id === id ? { ...s, _deleted: true } : s))
  }, [])

  const handleSlideChange = useCallback((id: string, field: keyof CarouselSlide, value: string) => {
    setSlides((prev) => prev.map((s) => s.id === id ? { ...s, [field]: value || null, _dirty: true } : s))
  }, [])

  // Direct-to-storage upload via XHR (uploadToStorageWithProgress). We deliberately
  // avoid supabase.storage.upload() here: its promise was leaving editor busy states
  // stuck (the IE "Uploading…" hang), whereas XHR resolves deterministically on
  // load/error/abort and exposes an upload-progress event. The signed-URL step is kept.
  const uploadSlideFile = useCallback(async (
    file: File,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<string | null> => {
    const rand = Math.random().toString(36).slice(2, 8)
    const path = `cards/${card.id}/slides/${Date.now()}_${rand}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { data: { session } } = await supabase.auth.getSession()
    const accessToken = session?.access_token ?? ''
    if (!accessToken) return null
    const { error } = await uploadToStorageWithProgress(path, file, accessToken, onProgress)
    if (error) return null
    const { data: signed } = await supabase.storage.from('creative-files').createSignedUrl(path, 3600 * 24 * 365)
    return signed?.signedUrl ?? null
  }, [card.id, supabase])

  // Generic direct-to-storage card-media uploader (Instant Experience blocks). Same
  // mechanism as uploadSlideFile — the browser writes straight to the creative-files
  // bucket, so it bypasses the 4.5MB Vercel serverless body cap and works for video
  // without a campaign existing yet. 50MB cap is enforced in InstantExperienceEditor.
  const uploadCardMedia = useCallback(async (
    file: File,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<string | null> => {
    const rand = Math.random().toString(36).slice(2, 8)
    const path = `cards/${card.id}/ie/${Date.now()}_${rand}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { data: { session } } = await supabase.auth.getSession()
    const accessToken = session?.access_token ?? ''
    if (!accessToken) return null
    const { error } = await uploadToStorageWithProgress(path, file, accessToken, onProgress)
    if (error) return null
    const { data: signed } = await supabase.storage.from('creative-files').createSignedUrl(path, 3600 * 24 * 365)
    return signed?.signedUrl ?? null
  }, [card.id, supabase])

  const handleSlideImageUpload = useCallback(async (slideId: string, file: File) => {
    setUploadingSlide(slideId)
    const url = await uploadSlideFile(file)
    if (url) setSlides((prev) => prev.map((s) => s.id === slideId ? { ...s, image_url: url, _dirty: true } : s))
    setUploadingSlide(null)
  }, [uploadSlideFile])

  // Core slot-filler: given (file → slot index) assignments, ensure slides exist up to the
  // highest slot, upload each file, and set image_url on the matching slide. Shared by every
  // batch path so "distribute N files across slides" behaves identically everywhere.
  const applySlideImageAssignments = useCallback(async (assignments: { slot: number; file: File }[]) => {
    if (!assignments.length) return
    const visible = slides.filter((s) => !s._deleted).sort((a, b) => a.position - b.position)
    const maxSlot = Math.max(...assignments.map((a) => a.slot))
    const total = Math.max(visible.length, maxSlot + 1)
    const slotSlides: LocalSlide[] = []
    for (let k = 0; k < total; k++) slotSlides[k] = k < visible.length ? visible[k] : emptySlide(card.id, k)

    setSlides([...slotSlides, ...slides.filter((s) => s._deleted)])
    const results = await Promise.all(
      assignments.map(async (a) => ({ id: slotSlides[a.slot].id, url: await uploadSlideFile(a.file) }))
    )
    const urlById = new Map(results.filter((r) => r.url).map((r) => [r.id, r.url as string]))
    setSlides((prev) => prev.map((s) => urlById.has(s.id) ? { ...s, image_url: urlById.get(s.id)!, _dirty: true } : s))
  }, [card.id, slides, uploadSlideFile])

  // Batch drop: distribute images across slides by the trailing "_NN" in each filename
  // (e.g. "…_03.png" → slide 3, position 2). Missing slides are created; files without a
  // number fill the next open slots after the highest. Overwrites existing images.
  const handleBatchSlideImages = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return

    const numbered: { file: File; slot: number }[] = []
    const unnumbered: File[] = []
    for (const f of images) {
      const m = f.name.match(/_(\d+)\.[^.]+$/)
      if (m) numbered.push({ file: f, slot: parseInt(m[1], 10) - 1 })
      else unnumbered.push(f)
    }
    numbered.sort((a, b) => a.slot - b.slot)
    unnumbered.sort((a, b) => a.name.localeCompare(b.name))

    const visible = slides.filter((s) => !s._deleted).sort((a, b) => a.position - b.position)
    const maxNumberedSlot = numbered.length ? Math.max(...numbered.map((n) => n.slot)) : -1
    let nextFree = Math.max(visible.length, maxNumberedSlot + 1)
    const assignments: { slot: number; file: File }[] = numbered.map((n) => ({ slot: n.slot, file: n.file }))
    for (const f of unnumbered) assignments.push({ slot: nextFree++, file: f })

    await applySlideImageAssignments(assignments)
  }, [slides, applySlideImageAssignments])

  // Group drop / multi-select onto ONE slide: a single image replaces that slide (as before);
  // multiple images distribute — honoring "_NN" when present (absolute slots), otherwise filling
  // sequentially from the dropped slide forward. This is gap #1: the per-slide drop used to take
  // only files[0], silently discarding the rest of a batch.
  const handleSlideImagesDrop = useCallback(async (slideId: string, files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    if (images.length === 1) { await handleSlideImageUpload(slideId, images[0]); return }

    const visible = slides.filter((s) => !s._deleted).sort((a, b) => a.position - b.position)
    const foundIdx = visible.findIndex((s) => s.id === slideId)
    const startIdx = foundIdx < 0 ? 0 : foundIdx

    const numbered: { file: File; slot: number }[] = []
    const unnumbered: File[] = []
    for (const f of images) {
      const m = f.name.match(/_(\d+)\.[^.]+$/)
      if (m) numbered.push({ file: f, slot: parseInt(m[1], 10) - 1 })
      else unnumbered.push(f)
    }
    unnumbered.sort((a, b) => a.name.localeCompare(b.name))

    const assignments: { slot: number; file: File }[] = [...numbered]
    const used = new Set(numbered.map((n) => n.slot))
    let cursor = startIdx
    for (const f of unnumbered) {
      while (used.has(cursor)) cursor++
      used.add(cursor)
      assignments.push({ slot: cursor, file: f })
      cursor++
    }

    await applySlideImageAssignments(assignments)
  }, [slides, handleSlideImageUpload, applySlideImageAssignments])

  // Manual re-import of the Build folder's graphics onto slides by _NN — the on-demand path
  // for a revised file (overwritten in Box under the same build link, which the on-save pull
  // and prod webhook don't cover from here). Uses the in-memory build link so an unsaved edit
  // still works. Overwrites all matched slides from Box.
  const handleRePullSlides = useCallback(async () => {
    if (!buildLink.trim()) return
    setRePulling(true)
    try {
      await fetch('/api/box/pull-slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id, sharedLink: buildLink.trim() }),
      })
      const { data: pulled } = await supabase
        .from('carousel_slides').select('*').eq('card_id', card.id).order('position', { ascending: true })
      if (pulled) {
        setSlides((pulled as CarouselSlide[]).map((s) => ({ ...s, _dirty: false, _deleted: false, _isNew: false })))
      }
      const { data: updated } = await supabase.from('cards').select(FULL_CARD_SELECT).eq('id', card.id).single()
      if (updated) onUpdated(updated as Card)
    } catch { /* ignore — surfaced as no change */ }
    setRePulling(false)
  }, [buildLink, card.id, supabase, onUpdated])

  // ── Drawer-level drag-and-drop ────────────────────────────────────────────
  function onDrawerDrop(e: React.DragEvent) {
    e.preventDefault()
    setDrawerDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    setTab('files')
    setPendingDropFiles(files)
  }

  // Files dropped on the board card: route into the drawer once. Carousels distribute
  // across slides by filename (wait for slides to load first); other cards go to Files.
  const processedDropRef = useRef<File[] | null>(null)
  useEffect(() => {
    if (!initialDropFiles || !initialDropFiles.length) return
    if (processedDropRef.current === initialDropFiles) return
    if (isCarousel && !slidesLoaded) return
    processedDropRef.current = initialDropFiles
    const files = initialDropFiles
    const hasImages = files.some((f) => f.type.startsWith('image/'))
    // Defer state updates out of the effect body (repo lint forbids setState in an effect).
    const raf = requestAnimationFrame(() => {
      if (isCarousel && hasImages) {
        handleBatchSlideImages(files)
      } else {
        setTab('files')
        setPendingDropFiles(files)
      }
      onInitialDropFilesConsumed?.()
    })
    return () => cancelAnimationFrame(raf)
  }, [initialDropFiles, isCarousel, slidesLoaded, handleBatchSlideImages, onInitialDropFilesConsumed])

  const handleToggleUtm = useCallback(() => setShowUtm((v) => !v), [])
  const handleCopyUtm = useCallback(() => {
    navigator.clipboard.writeText(generatedUtmUrl)
    setUtmCopied(true)
    setTimeout(() => setUtmCopied(false), 2000)
  }, [generatedUtmUrl])

  const handleAmApprove = useCallback(async (confirm = false) => {
    setApproving(true)
    try {
      const res = await fetch('/api/adviewer/card-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id, confirm }),
      })
      const data = await res.json()
      if (!res.ok) {
        setApproveMsg({ text: data?.error ?? 'Approve failed', kind: 'err' })
        setTimeout(() => setApproveMsg(null), 6000)
        return
      }
      if (data.needsConfirm) { setApproveConfirm(data.campaignsToArchive ?? []); return }
      setApproveConfirm(null)
      const archived = (data.archivedCampaignIds ?? []).length
      if (archived > 0) {
        setApproveMsg({ text: `Approved — sent ${archived} campaign${archived > 1 ? 's' : ''} to the Lookbook`, kind: 'ok' })
        setTimeout(() => setApproveMsg(null), 6000)
      }
      setApprovalStatus('approved')
      onUpdated({ ...card, approval_status: 'approved' })
    } finally {
      setApproving(false)
    }
  }, [card, onUpdated])

  // ── Shorthand style refs ──────────────────────────────────────────────────
  const lbl = drawerLabelClass
  const inp = drawerInputClass
  const ta  = `${inp} resize-none`

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
    <div
      className={standalone
        ? `flex flex-row h-screen overflow-hidden bg-[#0f1117]${drawerDragOver ? ' ring-2 ring-inset ring-blue-500' : ''}`
        : "fixed inset-0 z-50 flex items-center justify-center p-4"
      }
      onDragOver={(e) => { e.preventDefault(); if (!usesBlockEditor && e.dataTransfer.types.includes('Files')) setDrawerDragOver(true) }}
      onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrawerDragOver(false) }}
      onDrop={usesBlockEditor ? undefined : onDrawerDrop}
    >
      {/* Backdrop — modal mode only */}
      {!standalone && (
        <div
          className="absolute inset-0 bg-black/60"
          onClick={() => dirty ? setShowDiscardWarning(true) : onClose()}
        />
      )}

      {/* Drawer panel */}
      <div className={standalone
        ? `relative flex-1 flex flex-row overflow-hidden${drawerDragOver ? ' ring-2 ring-inset ring-blue-500' : ''}`
        : `relative flex flex-row w-full max-w-5xl bg-gray-900 border border-gray-700/60 shadow-2xl rounded-xl max-h-[90vh] overflow-hidden${drawerDragOver ? ' ring-2 ring-inset ring-blue-500' : ''}`
      }>

        {/* Drop overlay */}
        {drawerDragOver && (
          <div className="absolute inset-0 z-20 bg-blue-950/60 flex items-center justify-center rounded-xl pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-blue-300">
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <span className="text-sm font-semibold">Drop to upload to Files</span>
            </div>
          </div>
        )}

        {/* ── Left: Card details ──────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {/* ── Preview hero ─────────────────────────────────────────── */}
        {card.preview_image_url && (
          <div
            className="w-full shrink-0 bg-black relative cursor-zoom-in overflow-hidden"
            style={{ height: '220px' }}
            onClick={() => setLightboxOpen(true)}
            title="Click to expand"
          >
            {!heroLoaded && (
              <div className="absolute inset-0 bg-gray-800 animate-pulse" />
            )}
            <img
              src={card.preview_image_url}
              alt=""
              loading="eager"
              decoding="async"
              onLoad={() => setHeroLoaded(true)}
              className={`w-full h-full object-contain transition-opacity duration-200 ${heroLoaded ? 'opacity-100' : 'opacity-0'}`}
            />
          </div>
        )}

        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-gray-700/60 shrink-0">
          <div className="flex-1 min-w-0">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-transparent text-white font-semibold text-base leading-snug focus:outline-none placeholder-gray-500"
              placeholder="Card title…"
            />
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <MediaTypeBadge type={card.media_type} />
              {tier && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-700 text-gray-300 border border-gray-600/60">
                  {tier}
                </span>
              )}
              <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                approvalStatus === 'approved'           ? 'bg-green-900/50 text-green-300 border-green-700/50' :
                approvalStatus === 'changes_requested'  ? 'bg-orange-900/50 text-orange-300 border-orange-700/50' :
                approvalStatus === 'pending'            ? 'bg-yellow-900/50 text-yellow-300 border-yellow-700/50' :
                                                          'bg-gray-800 text-gray-500 border-gray-700'
              }`}>
                {approvalStatus === 'none' ? 'no review' : approvalStatus.replace('_', ' ')}
              </span>
            </div>
          </div>
          {clientId && (
            <button
              onClick={handleCopyPortalLink}
              title="Copy review link"
              className="text-gray-400 hover:text-white p-1 rounded transition-colors shrink-0 mt-0.5"
            >
              {portalLinkCopied ? (
                <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              )}
            </button>
          )}
          <button
            onClick={handleCopyCardLink}
            title="Copy link to this card"
            className="text-gray-400 hover:text-white p-1 rounded transition-colors shrink-0 mt-0.5"
          >
            {cardLinkCopied ? (
              <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
          {!standalone && (
            <a
              href={`/card/${card.id}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in new tab"
              className="text-gray-400 hover:text-white p-1 rounded transition-colors shrink-0 mt-0.5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
          {standalone ? (
            <a
              href="/board"
              title="Back to Board"
              className="text-gray-400 hover:text-white p-1 rounded transition-colors shrink-0 mt-0.5"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </a>
          ) : (
            <button
              onClick={() => dirty ? setShowDiscardWarning(true) : onClose()}
              className="text-gray-400 hover:text-white p-1 rounded transition-colors shrink-0 mt-0.5"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* ── Tab bar ──────────────────────────────────────────────── */}
        <div className="flex border-b border-gray-700/60 shrink-0">
          {(['info', 'files', 'flights', 'changes'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); if (t === 'flights') setFlightsEverOpened(true) }}
              className={`px-5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              {t === 'info' ? 'Info' : t === 'files' ? 'Files' : t === 'flights' ? 'Flights' : 'Changes'}
            </button>
          ))}
        </div>

        {/* ── Tab content ──────────────────────────────────────────── */}
        <div ref={tabScrollRef} className="flex-1 overflow-y-auto overscroll-y-contain">

          {/* ═══════════════════ INFO TAB ═══════════════════════════ */}
          {tab === 'info' && (
            <div className="p-4 space-y-6">

              {/* Card meta row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>Client</label>
                  <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={inp}>
                    <option value="">No client</option>
                    {clients.filter((c) => c.active).map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                {/* Atlas cards live on the Atlas board (grouped by location), not a
                    board column — hide the column picker so saving can't move them
                    onto the main board. */}
                {!card.atlas_location_id && (
                  <div>
                    <label className={lbl}>Column</label>
                    <select value={columnId} onChange={(e) => setColumnId(e.target.value)} className={inp}>
                      {columns.map((c) => (
                        <option key={c.id} value={c.id}>{c.title}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={lbl}>Media Type</label>
                  <select value={mediaType} onChange={(e) => setMediaType(e.target.value)} className={inp}>
                    <option value="">Select…</option>
                    {TEMPLATE_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Tier</label>
                  <select value={tier} onChange={(e) => setTier(e.target.value as 'T1' | 'T2' | 'T3' | '')} className={inp}>
                    <option value="">–</option>
                    <option value="T1">T1</option>
                    <option value="T2">T2</option>
                    <option value="T3">T3</option>
                  </select>
                </div>
                <div>
                  <label className={lbl}>Status</label>
                  <select value={workStatus} onChange={(e) => setWorkStatus(e.target.value as WorkStatus | '')} className={inp}>
                    <option value="">Not started</option>
                    {WORK_STATUSES.map((s) => (
                      <option key={s} value={s}>{WORK_STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Approval</label>
                  <select value={approvalStatus} onChange={(e) => setApprovalStatus(e.target.value as ApprovalStatus)} className={inp}>
                    {APPROVAL_STATUSES.map((s) => (
                      <option key={s} value={s}>{s === 'none' ? 'none' : s.replace('_', ' ')}</option>
                    ))}
                  </select>
                  {approvalStatus === 'pending' && clientId && (
                    <div className="mt-2 flex items-center gap-2 px-2.5 py-2 rounded bg-yellow-900/30 border border-yellow-700/40">
                      <span className="text-xs text-yellow-300 flex-1 truncate">
                        {clientReviewToken
                          ? `${typeof window !== 'undefined' ? window.location.origin : ''}/review/${clientReviewToken}`
                          : 'Portal link — click to generate'}
                      </span>
                      <button
                        type="button"
                        onClick={handleCopyPortalLink}
                        className="flex-none text-xs font-medium text-yellow-300 hover:text-white transition-colors whitespace-nowrap"
                      >
                        {portalLinkCopied ? '✓ Copied' : 'Copy link'}
                      </button>
                    </div>
                  )}
                  {card.adpiler_preview_url && approvalStatus !== 'approved' && (
                    <button
                      type="button"
                      onClick={() => void handleAmApprove(false)}
                      disabled={approving}
                      title="Client signed off (e.g. by email) — approve this creative & resolve its pins"
                      className="mt-2 w-full text-xs font-semibold px-3 py-2 rounded bg-emerald-600/90 hover:bg-emerald-500 text-white transition-colors disabled:opacity-40"
                    >
                      {approving ? 'Approving…' : 'Approve (client sign-off)'}
                    </button>
                  )}
                </div>
              </div>

              <DrawerDescriptionSection
                creativeName={creativeName}
                onCreativeNameChange={setCreativeName}
                isSocialBuild={(FB_BUILD_MEDIA_TYPES as readonly string[]).includes(mediaType)}
                buildLink={buildLink}
                onBuildLinkChange={setBuildLink}
                displayBuildLink={displayBuildLink}
                onDisplayBuildLinkChange={setDisplayBuildLink}
                downloadingDisplayBuild={downloadingDisplayBuild}
                downloadDisplayBuildError={downloadDisplayBuildError}
                onDownloadDisplayBuild={handleDownloadDisplayBuild}
                downloadingBuild={downloadingBuild}
                downloadBuildError={downloadBuildError}
                onDownloadBuild={handleDownloadBuild}
                showPublishButton={showPublishButton}
                publishingToFb={publishingToFb}
                publishFbError={publishFbError}
                fbAdId={fbAdId}
                fbCampaignId={fbCampaignId}
                fbPublishedAt={fbPublishedAt}
                onPublishToFb={handlePublishToFb}
                canCopyForCopyTracker={true}
                copyTrackerCopied={copyTrackerCopied}
                onCopyForCopyTracker={handleCopyForCopyTracker}
                description={description}
                onDescriptionChange={setDescription}
                slideDetails={slideDetails}
              />

              {/* ── Reference ───────────────────────────────────────── */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Reference</span>
                  <div className="flex-1 h-px bg-gray-700/60" />
                </div>

                {referencedCard ? (
                  <div className="rounded-lg border border-blue-800/50 bg-blue-950/20 p-3">
                    <div className="flex items-start gap-3">
                      {referencedCard.preview_image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={referencedCard.preview_image_url} alt="" className="w-14 h-14 rounded object-cover border border-gray-700 shrink-0" />
                      ) : (
                        <div className="w-14 h-14 rounded bg-gray-800 border border-gray-700 shrink-0 flex items-center justify-center text-[10px] text-gray-600">No image</div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-white truncate">{referencedCard.title}</p>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                          {referencedCard.clients?.name ?? 'No client'}
                          {referencedCard.archived && (
                            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-amber-900/60 text-amber-300">Archived</span>
                          )}
                        </p>
                        <a
                          href={`/card/${referencedCard.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-400 hover:text-blue-300 hover:underline inline-block mt-1"
                        >
                          Open referenced card ↗
                        </a>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setReferencedCardId(null); setReferencedCard(null); setRefPickerOpen(false) }}
                        className="text-xs text-red-400 hover:text-red-300 px-2 py-0.5 rounded hover:bg-red-900/30 transition-colors shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setRefPickerOpen((v) => !v)}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
                    >
                      {refPickerOpen ? '▾ Hide picker' : '▸ Reference another card'}
                    </button>
                    {refPickerOpen && (
                      <div className="mt-3 space-y-2">
                        <input
                          value={refQuery}
                          onChange={(e) => handleRefQueryChange(e.target.value)}
                          placeholder="Search cards by title…"
                          className={inp}
                        />
                        {refSearching && <p className="text-xs text-gray-500">Searching…</p>}
                        {!refSearching && refQuery.trim().length >= 2 && refResults.length === 0 && (
                          <p className="text-xs text-gray-500">No matches.</p>
                        )}
                        {refResults.length > 0 && (
                          <ul className="rounded-lg border border-gray-700/60 divide-y divide-gray-700/60 overflow-hidden">
                            {refResults.map((r) => (
                              <li key={r.id}>
                                <button
                                  type="button"
                                  onClick={() => { setReferencedCardId(r.id); setReferencedCard(r); setRefPickerOpen(false); setRefQuery('') }}
                                  className="w-full flex items-center gap-3 p-2 text-left hover:bg-gray-800/60 transition-colors"
                                >
                                  {r.preview_image_url ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={r.preview_image_url} alt="" className="w-10 h-10 rounded object-cover border border-gray-700 shrink-0" />
                                  ) : (
                                    <div className="w-10 h-10 rounded bg-gray-800 border border-gray-700 shrink-0" />
                                  )}
                                  <span className="min-w-0">
                                    <span className="block text-sm text-white truncate">{r.title}</span>
                                    <span className="block text-xs text-gray-400 truncate">{r.clients?.name ?? 'No client'}</span>
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* ── Inventory Unit ──────────────────────────────────── */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Inventory Unit</span>
                  <div className="flex-1 h-px bg-gray-700/60" />
                </div>

                {loadingLinkedUnit && (
                  <p className="text-xs text-gray-500">Loading…</p>
                )}

                {!loadingLinkedUnit && linkedUnit && (
                  <div className="rounded-lg border border-blue-800/50 bg-blue-950/20 p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-white">
                          {[linkedUnit.year, linkedUnit.make, linkedUnit.model, linkedUnit.trim].filter(Boolean).join(' ')}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {linkedUnit.ps_dealers?.name ?? ''}
                          {linkedUnit.stock_number ? ` · #${linkedUnit.stock_number}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setInventoryUnitId(null); setLinkedUnit(null); setShowInventoryPickerDrawer(false) }}
                        className="text-xs text-red-400 hover:text-red-300 px-2 py-0.5 rounded hover:bg-red-900/30 transition-colors shrink-0"
                      >
                        Unlink
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-gray-400">
                      {linkedUnit.condition && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                          linkedUnit.condition === 'new' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-amber-900/60 text-amber-300'
                        }`}>{linkedUnit.condition}</span>
                      )}
                      {linkedUnit.category && (
                        <span className="bg-blue-900/60 text-blue-300 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase">
                          {linkedUnit.category}
                        </span>
                      )}
                      {linkedUnit.price != null && (
                        <span>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(linkedUnit.price)}</span>
                      )}
                      {linkedUnit.days_on_lot > 0 && <span>{linkedUnit.days_on_lot}d on lot</span>}
                    </div>
                    {linkedUnit.listing_url && (
                      <a
                        href={linkedUnit.listing_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-400 hover:text-blue-300 hover:underline block truncate"
                      >
                        View listing ↗
                      </a>
                    )}
                  </div>
                )}

                {!loadingLinkedUnit && !linkedUnit && (
                  <button
                    type="button"
                    onClick={() => setShowInventoryPickerDrawer((v) => !v)}
                    className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
                  >
                    {showInventoryPickerDrawer ? '▾ Hide picker' : '▸ Link an inventory unit'}
                  </button>
                )}

                {showInventoryPickerDrawer && !linkedUnit && (
                  <div className="mt-3">
                    <InventoryPicker
                      selectedUnitId={inventoryUnitId}
                      onSelect={(unit) => {
                        setInventoryUnitId(unit?.id ?? null)
                        setLinkedUnit(unit)
                        if (unit) setShowInventoryPickerDrawer(false)
                      }}
                    />
                  </div>
                )}
              </div>

              <DrawerDetailsSection
                card={card}
                firstDraftDeadline={firstDraftDeadline}
                onFirstDraftDeadlineChange={setFirstDraftDeadline}
                flightStartDate={flightStartDate}
                onFlightStartDateChange={setFlightStartDate}
                flightEndDate={flightEndDate}
                onFlightEndDateChange={setFlightEndDate}
                landingPageUrl={landingPageUrl}
                onLandingPageUrlChange={setLandingPageUrl}
                utmCampaign={utmCampaign}
                onUtmCampaignChange={setUtmCampaign}
                utmChannel={utmChannel}
                onUtmChannelChange={setUtmChannel}
                showUtm={showUtm}
                onToggleUtm={handleToggleUtm}
                utmCopied={utmCopied}
                onCopyUtm={handleCopyUtm}
                generatedUtmUrl={generatedUtmUrl}
                channelOptions={channelOptions}
                campaignPresets={campaignPresets}
              />

              {/* ── TTD EXPORT ───────────────────────────────────── */}
              {isTtdType && (
                <div>
                  <SectionHeader title="TTD Export" />
                  <div className="space-y-3">
                    <div>
                      <label className={drawerLabelClass}>Campaign</label>
                      <select
                        value={ttdCampaignId}
                        onChange={(e) => {
                          setTtdCampaignId(e.target.value)
                          setTtdAdGroupIds([])
                        }}
                        className={drawerInputClass}
                      >
                        <option value="">Select campaign…</option>
                        {ttdCampaigns.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      {!ttdCampaignsLoaded && isTtdType && clientId && (
                        <p className="text-[10px] text-gray-500 mt-1">Loading…</p>
                      )}
                      {ttdCampaignsLoaded && ttdCampaigns.length === 0 && (
                        <p className="text-[10px] text-gray-500 mt-1">No TTD campaigns for this client. Add them via the Clients panel.</p>
                      )}
                    </div>
                    {ttdCampaignId && ttdAdGroupsForCampaign.length > 0 && (
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className={drawerLabelClass}>Ad Groups</label>
                          <button
                            type="button"
                            onClick={handleTtdSelectAll}
                            className="text-[10px] text-blue-400 hover:text-blue-300 font-medium transition-colors"
                          >
                            {ttdAdGroupsForCampaign.every(ag => ttdAdGroupIds.includes(ag.id)) ? 'Deselect All' : 'Select All'}
                          </button>
                        </div>
                        <div className="space-y-1.5 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2">
                          {ttdAdGroupsForCampaign.map((ag) => (
                            <label key={ag.id} className="flex items-center gap-2.5 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={ttdAdGroupIds.includes(ag.id)}
                                onChange={() => handleTtdAdGroupToggle(ag.id)}
                                className="w-3.5 h-3.5 rounded accent-blue-500 cursor-pointer"
                              />
                              <span className="text-[12px] text-gray-300 group-hover:text-white transition-colors">{ag.name}</span>
                            </label>
                          ))}
                        </div>
                        {ttdAdGroupIds.length > 0 && (
                          <p className="text-[10px] text-gray-500 mt-1">{ttdAdGroupIds.length} ad group{ttdAdGroupIds.length !== 1 ? 's' : ''} selected — all IDs combined in one cell per row in the upload sheet</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {hasContent && (
                <DrawerContentSection
                  isDisplay={isDisplay}
                  hasFbMeta={hasFbMeta}
                  isOrganic={isOrganic}
                  isVideo={isVideo}
                  isAudio={isAudio}
                  isFbEvent={isFbEvent}
                  isCarousel={isCarousel}
                  isMessenger={isMessenger}
                  isInstantExperience={isInstantExperience}
                  messengerWelcome={messengerWelcome}
                  onMessengerWelcomeChange={setMessengerWelcome}
                  instantExperience={instantExperience}
                  onInstantExperienceChange={setInstantExperience}
                  onUploadCardMedia={uploadCardMedia}
                  fbPageLogoUrl={card.clients?.fb_page_logo_url ?? null}
                  heading={heading}
                  onHeadingChange={setHeading}
                  subheading={subheading}
                  onSubheadingChange={setSubheading}
                  buttonText={buttonText}
                  onButtonTextChange={setButtonText}
                  caption={caption}
                  onCaptionChange={setCaption}
                  boostBudget={boostBudget}
                  onBoostBudgetChange={setBoostBudget}
                  companionBannerLink={companionBannerLink}
                  onCompanionBannerLinkChange={setCompanionBannerLink}
                  eventDescription={eventDescription}
                  onEventDescriptionChange={setEventDescription}
                  fbPageName={fbPageName}
                  onFbPageNameChange={setFbPageName}
                  fbBodyText={fbBodyText}
                  onFbBodyTextChange={setFbBodyText}
                  fbHeadline={fbHeadline}
                  onFbHeadlineChange={setFbHeadline}
                  fbSubheadline={fbSubheadline}
                  onFbSubheadlineChange={setFbSubheadline}
                  fbLinkDescription={fbLinkDescription}
                  onFbLinkDescriptionChange={setFbLinkDescription}
                  fbCta={fbCta}
                  onFbCtaChange={setFbCta}
                  slides={slides}
                  slidesLoaded={slidesLoaded}
                  uploadingSlide={uploadingSlide}
                  dragOverSlide={dragOverSlide}
                  onDragOverSlide={setDragOverSlide}
                  onAddSlide={handleAddSlide}
                  onRemoveSlide={handleRemoveSlide}
                  onSlideChange={handleSlideChange}
                  onSlideImagesDrop={handleSlideImagesDrop}
                  hasBuildLink={buildLink.trim() !== ''}
                  rePulling={rePulling}
                  onRePullSlides={handleRePullSlides}
                />
              )}

              {/* ── REVISIONS ────────────────────────────────────── */}
              <div>
                <SectionHeader title="Revisions & Change Requests" />
                <EditableTextField
                  value={revisions}
                  onChange={setRevisions}
                  rows={4}
                  className={ta}
                  placeholder="Log revision requests or change notes here…"
                />
              </div>

              {/* ── ADVIEWER ─────────────────────────────────────── */}
              <div>
                <SectionHeader title="Adviewer" />
                <label className="flex items-start gap-2 mb-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={adviewerStandalone}
                    onChange={(e) => setAdviewerStandalone(e.target.checked)}
                    className="mt-0.5 accent-[#7c3aed]"
                  />
                  <span className="text-xs text-gray-400 group-hover:text-gray-300 transition-colors leading-snug">
                    Review as a standalone request — not part of a campaign. Publishing routes this card to the client&apos;s <span className="text-gray-300 font-medium">Design Requests</span> bucket instead of the monthly campaign.
                  </span>
                </label>
                {adviewerUrl ? (
                  <div className="space-y-2">
                    <a
                      href={adviewerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full py-2 rounded text-sm font-semibold transition-colors"
                      style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)', color: 'white' }}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                      Open in Adviewer
                    </a>
                    <button
                      type="button"
                      onClick={handleCopyAdviewerLink}
                      className="w-full py-1.5 rounded text-xs font-medium bg-gray-800 border border-gray-700 text-gray-400 hover:text-blue-300 hover:border-blue-700/60 transition-colors"
                    >
                      {adviewerLinkCopied ? '✓ Link copied!' : 'Copy Adviewer link'}
                    </button>
                  </div>
                ) : card.atlas_location_id ? (
                  // Atlas cards have no column — the Atlas board's columns are locations, so
                  // the usual trigger (dropping a card into "Ready for Adviewer", which is
                  // what the board drag, the Column dropdown and the reconcile cron all
                  // match on) can never fire for them. Publish straight from here instead;
                  // generateAdviewerForCard never reads column_id, so it works unchanged.
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={handleSendToAdviewer}
                      disabled={sendingToAdviewer}
                      className="flex items-center justify-center gap-2 w-full py-2 rounded text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
                      style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)', color: 'white' }}
                    >
                      {sendingToAdviewer ? 'Sending…' : 'Send to Adviewer'}
                    </button>
                    <p className="text-xs text-gray-500">
                      Atlas cards are filed by location rather than by column, so they publish from here. Upload the MP4 under <span className="text-gray-300 font-medium">Files</span> first — the review link shows whatever is attached when you send it.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">Move this card to <span className="text-gray-300 font-medium">Ready for Adviewer</span> to publish it to the client review link.</p>
                )}
              </div>

              {/* ── CLIENT PORTAL ────────────────────────────────── */}
              <div>
                <SectionHeader title="Client Portal" />
                <p className="text-xs text-gray-500 mb-2">Control whether this card appears in the client-facing portal.</p>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  {(
                    [
                      { value: null,               label: 'Off',              active: 'bg-gray-700 border-gray-500 text-gray-200' },
                      { value: 'pending_approval', label: 'Pending Approval', active: 'bg-yellow-900/50 border-yellow-600/70 text-yellow-300' },
                      { value: 'running',          label: 'Currently Running (Override)', active: 'bg-green-900/50 border-green-600/70 text-green-300' },
                      { value: 'archive_review',   label: 'Past Creatives',   active: 'bg-purple-900/50 border-purple-600/70 text-purple-300' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={String(opt.value)}
                      type="button"
                      onClick={() => setClientPortalStatus(opt.value)}
                      className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                        clientPortalStatus === opt.value
                          ? opt.active
                          : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-600 mb-3">
                  Note: cards move to Currently Running automatically when a flight is active. Use the override only when no flight is set.
                </p>
                {clientId && (
                  <button
                    type="button"
                    onClick={handleCopyPortalLink}
                    className="w-full py-1.5 rounded text-xs font-medium bg-gray-800 border border-gray-700 text-gray-400 hover:text-blue-300 hover:border-blue-700/60 transition-colors"
                  >
                    {portalLinkCopied ? '✓ Portal link copied!' : 'Copy portal link'}
                  </button>
                )}
              </div>

              {/* ── ACTIONS ──────────────────────────────────────── */}
              <div className="space-y-2 pb-4">
                <SectionHeader title="Actions" />

                {doneColumnId && columnId !== doneColumnId && (
                  <button
                    onClick={handleLiveToggle}
                    disabled={liveToggleLoading}
                    className={`w-full py-2 rounded text-sm font-medium transition-colors ${
                      isManuallyLive
                        ? 'bg-green-900/40 border border-green-700/60 text-green-300 hover:bg-green-900/60'
                        : 'bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700'
                    }`}
                  >
                    {liveToggleLoading ? 'Updating…' : isManuallyLive ? '✓ Flight Active — click to close' : 'Open Flight (Mark as Running)'}
                  </button>
                )}

                {confirmArchive ? (
                  <div className="flex gap-2">
                    <button onClick={handleArchive} className="flex-1 py-2 rounded text-sm bg-yellow-900/40 border border-yellow-700/60 text-yellow-300 hover:bg-yellow-900/60 font-medium transition-colors">Archive card</button>
                    <button onClick={() => setConfirmArchive(false)} className="px-4 py-2 rounded text-sm text-gray-400 hover:text-gray-200 bg-gray-800 border border-gray-700 transition-colors">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmArchive(true)} className="w-full py-2 rounded text-sm text-gray-400 hover:text-yellow-300 bg-gray-800 border border-gray-700 hover:border-yellow-700/60 transition-colors">
                    Archive
                  </button>
                )}

                {confirmDelete ? (
                  <div className="flex gap-2">
                    <button onClick={handleDelete} className="flex-1 py-2 rounded text-sm bg-red-900/40 border border-red-700/60 text-red-300 hover:bg-red-900/60 font-medium transition-colors">Delete permanently</button>
                    <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 rounded text-sm text-gray-400 hover:text-gray-200 bg-gray-800 border border-gray-700 transition-colors">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmDelete(true)} className="w-full py-2 rounded text-sm text-gray-500 hover:text-red-400 bg-gray-800 border border-gray-700 hover:border-red-700/60 transition-colors">
                    Delete
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ═══════════════════ FILES TAB ══════════════════════════ */}
          {tab === 'files' && (
            <div className="p-4">
              <FileUpload
                cardId={card.id}
                pendingFiles={pendingDropFiles}
                onPendingFilesConsumed={() => setPendingDropFiles(null)}
                currentPreviewImageUrl={card.preview_image_url}
                onPreviewImageChanged={(url) => onUpdated({ ...card, preview_image_url: url || null })}
                mediaType={mediaType}
              />
            </div>
          )}

          {/* ═══════════════════ FLIGHTS TAB ════════════════════════ */}
          {flightsEverOpened && (
            <div style={{ display: tab === 'flights' ? 'block' : 'none' }}>
              <FlightsTab
                cardId={card.id}
                doneColumnId={doneColumnId}
                onColumnChanged={onColumnChanged}
              />
            </div>
          )}

          {/* ═══════════════════ CHANGES TAB ════════════════════════ */}
          {tab === 'changes' && (
            <ChangeRequestsTab key={card.id} cardId={card.id} boxFolderId={card.box_folder_id} />
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4 px-4 py-3 border-t border-gray-700/60 shrink-0">
          <span className={`text-xs min-w-0 ${saveError ? 'text-red-400' : 'text-gray-500'}`}>
            {saveError ?? (dirty ? 'Unsaved changes' : savedOnce ? 'All changes saved' : '')}
          </span>
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="px-5 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {/* ── Discard warning ───────────────────────────────────────── */}
        {showDiscardWarning && (
          <div className="absolute inset-0 bg-gray-900/95 flex items-center justify-center z-10">
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4">
              <p className="text-white font-medium">Discard unsaved changes?</p>
              <p className="text-sm text-gray-400">Your changes haven&apos;t been saved yet.</p>
              <div className="flex gap-3">
                <button onClick={onClose} className="flex-1 py-2 rounded bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors">Discard &amp; Close</button>
                <button onClick={() => setShowDiscardWarning(false)} className="flex-1 py-2 rounded bg-gray-700 hover:bg-gray-600 text-white text-sm transition-colors">Keep Editing</button>
              </div>
            </div>
          </div>
        )}
        </div>
        {/* ── Right: Comments & Activity ─────────────────────── */}
        <div className="w-80 flex-none border-l border-gray-700/60 flex flex-col overflow-hidden">
          {activityReady
            ? <CardActivityPanel cardId={card.id} userEmail={userEmail} />
            : <div className="flex-1" />
          }
        </div>
      </div>
    </div>
    {showFbModal && (
      <FbPublishModal
        clientId={clientId}
        cardTitle={card.title}
        dailyBudgetCents={dailyBudgetCents}
        onDailyBudgetChange={setDailyBudgetCents}
        publishing={publishingToFb}
        publishError={publishFbError}
        onConfirm={handleConfirmFbPublish}
        onClose={() => { setShowFbModal(false); setPublishFbError(null) }}
      />
    )}
    {lightboxOpen && card.preview_image_url && (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90"
        onClick={() => setLightboxOpen(false)}
      >
        <button
          className="absolute top-4 right-4 text-white/60 hover:text-white transition-colors"
          onClick={() => setLightboxOpen(false)}
          aria-label="Close"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <img
          src={card.preview_image_url}
          alt=""
          className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    )}
    {approveMsg && (
      <div
        onClick={() => setApproveMsg(null)}
        className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[80] max-w-sm px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg cursor-pointer ${approveMsg.kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`}
      >
        {approveMsg.text}
      </div>
    )}
    {approveConfirm && (
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70" onClick={() => setApproveConfirm(null)}>
        <div className="w-full max-w-sm rounded-2xl border border-emerald-600/30 bg-[#12101a] p-6 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
          <div>
            <h2 className="text-base font-semibold text-white">Last creative — send campaign to Lookbook?</h2>
            <p className="text-sm text-white/50 mt-1">
              Approving this is the final creative in {approveConfirm.map((c) => `“${c.title}”`).join(', ')}. It will be marked approved and moved to the Lookbook.
            </p>
            {approveConfirm.some((c) => (c.unapprovedFiles ?? 0) > 0) && (
              <p className="text-xs text-amber-300/90 mt-2">This campaign still has unapproved uploaded file(s), which aren’t counted toward completion — it will go to the Lookbook anyway.</p>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setApproveConfirm(null)} className="flex-1 text-sm font-medium text-white/60 hover:text-white bg-white/[0.06] py-2.5 rounded-xl">Cancel</button>
            <button onClick={() => void handleAmApprove(true)} disabled={approving} className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40">
              {approving ? 'Approving…' : 'Approve & send to Lookbook'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
