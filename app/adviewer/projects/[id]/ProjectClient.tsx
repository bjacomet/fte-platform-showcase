'use client'

import { useState, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import type { Card, TemplateOption, ApprovalStatus } from '@/types'
import { landingHostname } from '@/lib/url'
import ParticleBackground from '../../components/ParticleBackground'

// ── Local types ───────────────────────────────────────────────────────────────

interface ProjectFile {
  id: string
  file_name: string
  file_url: string
  file_type: string | null
  dimensions: string | null
  created_at: string
}

interface ProjectCard {
  id: string
  title: string
  media_type: string | null
  client_portal_status: string | null
  flight_start_date: string | null
  flight_end_date: string | null
  fb_page_name: string | null
  fb_body_text: string | null
  fb_headline: string | null
  fb_link_description: string | null
  fb_cta: string | null
  landing_page_url: string | null
  adpiler_preview_url: string | null
  companion_banner_link: string | null
  card_files: ProjectFile[]
}

interface ExistingFeedback {
  id: string
  card_id: string
  file_id: string | null
  slide_id: string | null
  decision: string | null
  comment: string | null
  created_at: string
}

interface Props {
  project: {
    id: string
    title: string
    description: string | null
    status: string
    updated_at: string
    client: { id: string; name: string; fb_page_logo_url: string | null } | null
  }
  projectCards: Array<{ id: string; position: number; card: ProjectCard }>
  fileUrls: Record<string, string>
  carouselSlides: Record<string, Array<{
    id: string; card_id: string; position: number
    headline: string | null; link_description: string | null
    landing_page_url: string | null; image_url: string | null
    created_at: string; updated_at: string
  }>>
  existingFeedback: ExistingFeedback[]
  adviewerClientId: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const IMAGE_TYPES   = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const VIDEO_TYPES   = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']
const AUDIO_TYPES   = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4']
const SOCIAL_TYPES  = ['Social Ad Request', 'Organic Post']
const DISPLAY_TYPES = ['Display Request', 'Web Banner', 'Eblast']

const DECISIONS = [
  { value: 'approved',          label: 'Approve',  icon: '✓', active: 'bg-green-500 text-white border-green-500',  idle: 'border-white/15 text-white/50 hover:border-green-500/50 hover:text-green-400' },
  { value: 'changes_requested', label: 'Changes',  icon: '↩', active: 'bg-amber-500 text-white border-amber-500',  idle: 'border-white/15 text-white/50 hover:border-amber-500/50 hover:text-amber-400' },
  { value: 'rejected',          label: 'Reject',   icon: '✕', active: 'bg-red-500 text-white border-red-500',      idle: 'border-white/15 text-white/50 hover:border-red-500/50 hover:text-red-400' },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPreviewCard(card: ProjectCard): Card {
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
    approval_status: 'none' as ApprovalStatus,
    work_status: null,
    adviewer_standalone: false,
    client_comments: null,
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
    landing_page_url: card.landing_page_url,
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
    client_portal_status: (card.client_portal_status as 'pending_approval' | 'running' | null),
    inventory_unit_id: null,
    messenger_welcome: null,
    instant_experience: null,
    fb_campaign_id: null,
    fb_ad_id: null,
    fb_published_at: null,
    restart_requested_at: null,
    restart_requested_by: null,
    restart_note: null,
    is_pending: false,
    pre_pending_column_id: null,
  }
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── Phone frame ───────────────────────────────────────────────────────────────

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center py-2">
      <div className="relative bg-[#111827] rounded-[44px] p-3 shadow-2xl" style={{ width: 260 }}>
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-16 h-5 bg-[#111827] rounded-b-2xl z-10" />
        <div className="absolute -right-[3px] top-20 w-[3px] h-8 bg-[#1f2937] rounded-r-sm" />
        <div className="absolute -left-[3px] top-16 w-[3px] h-6 bg-[#1f2937] rounded-l-sm" />
        <div className="absolute -left-[3px] top-24 w-[3px] h-6 bg-[#1f2937] rounded-l-sm" />
        <div className="rounded-[34px] overflow-hidden bg-white" style={{ minHeight: 460 }}>
          <div className="pt-6">{children}</div>
        </div>
      </div>
    </div>
  )
}

function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden border border-white/10">
      <div className="bg-[#0d1f30] px-4 py-2 flex items-center gap-3 border-b border-white/[0.08]">
        <div className="flex gap-1.5 flex-none">
          <div className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
          <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/70" />
          <div className="w-2.5 h-2.5 rounded-full bg-green-400/70" />
        </div>
        <div className="flex-1 bg-white/[0.07] rounded px-2 py-0.5 text-[10px] text-white/25 border border-white/[0.06] truncate">
          adviewer.followtheeyes.com
        </div>
      </div>
      {children}
    </div>
  )
}

// ── Facebook feed ─────────────────────────────────────────────────────────────

function FacebookFeedMockup({ card, clientName, clientLogo, imageUrl }: {
  card: ProjectCard; clientName: string | null; clientLogo: string | null; imageUrl: string | null
}) {
  const initials = (clientName ?? 'FTE').slice(0, 2).toUpperCase()
  const hostname = landingHostname(card.landing_page_url)
  return (
    <div className="bg-white text-gray-900">
      <div className="flex items-center gap-2 px-3 py-2">
        {clientLogo
          ? <img src={clientLogo} alt="" className="w-8 h-8 rounded-full object-cover flex-none" />
          : <div className="w-8 h-8 rounded-full bg-[#0075A9] flex items-center justify-center text-white text-[10px] font-bold flex-none">{initials}</div>
        }
        <div>
          <p className="text-[11px] font-semibold">{clientName ?? 'Page'}</p>
          <p className="text-[9px] text-gray-500">Sponsored · 🌐</p>
        </div>
      </div>
      {card.fb_body_text && (
        <p className="text-[10px] text-gray-800 px-3 pb-2 leading-relaxed">
          {card.fb_body_text.length > 100 ? card.fb_body_text.slice(0, 100) + '…' : card.fb_body_text}
        </p>
      )}
      <div className="bg-gray-100" style={{ minHeight: 160 }}>
        {imageUrl
          ? <img src={imageUrl} alt="Ad creative" className="w-full block" />
          : <div className="w-full flex items-center justify-center text-[10px] text-gray-400" style={{ height: 160 }}>Creative asset</div>
        }
      </div>
      <div className="bg-[#f0f2f5] px-3 py-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          {hostname && <p className="text-[9px] text-gray-500 uppercase truncate">{hostname}</p>}
          {card.fb_headline && <p className="text-[11px] font-semibold truncate">{card.fb_headline}</p>}
        </div>
        {card.fb_cta && card.fb_cta !== 'No Button' && (
          <button className="flex-none bg-[#e4e6eb] text-[10px] font-semibold px-3 py-1 rounded">{card.fb_cta}</button>
        )}
      </div>
    </div>
  )
}

// ── Carousel ──────────────────────────────────────────────────────────────────

function CarouselMockup({ slides, clientName, clientLogo }: {
  slides: Props['carouselSlides'][string]; clientName: string | null; clientLogo: string | null
}) {
  const [idx, setIdx] = useState(0)
  const initials = (clientName ?? 'FTE').slice(0, 2).toUpperCase()
  if (!slides.length) return <div className="bg-white px-4 py-8 text-center text-[10px] text-gray-400">No slides yet</div>
  const slide = slides[idx]
  return (
    <div className="bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        {clientLogo
          ? <img src={clientLogo} alt="" className="w-8 h-8 rounded-full object-cover flex-none" />
          : <div className="w-8 h-8 rounded-full bg-[#0075A9] flex items-center justify-center text-white text-[10px] font-bold flex-none">{initials}</div>
        }
        <div>
          <p className="text-[11px] font-semibold">{clientName ?? 'Page'}</p>
          <p className="text-[9px] text-gray-500">Sponsored · 🌐</p>
        </div>
      </div>
      <div className="bg-gray-100 relative" style={{ height: 170 }}>
        {slide.image_url
          ? <img src={slide.image_url} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400">Slide {idx + 1}</div>
        }
        {idx > 0 && (
          <button onClick={() => setIdx(i => i - 1)} className="absolute left-2 top-1/2 -translate-y-1/2 w-6 h-6 bg-white/90 rounded-full flex items-center justify-center shadow text-gray-700">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
          </button>
        )}
        {idx < slides.length - 1 && (
          <button onClick={() => setIdx(i => i + 1)} className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 bg-white/90 rounded-full flex items-center justify-center shadow text-gray-700">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
          </button>
        )}
        <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-1">
          {slides.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)} className={`h-1 rounded-full transition-all ${i === idx ? 'bg-white w-3' : 'bg-white/50 w-1'}`} />
          ))}
        </div>
      </div>
      <div className="bg-[#f0f2f5] px-3 py-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0">
          {slide.headline && <p className="text-[11px] font-semibold truncate">{slide.headline}</p>}
          {slide.link_description && <p className="text-[10px] text-gray-500 truncate">{slide.link_description}</p>}
        </div>
        <button className="flex-none bg-[#e4e6eb] text-[10px] font-semibold px-2.5 py-1 rounded whitespace-nowrap">Learn More</button>
      </div>
      <p className="text-center text-[9px] text-gray-400 py-1 border-t border-gray-100">{idx + 1} / {slides.length}</p>
    </div>
  )
}

// ── Display ───────────────────────────────────────────────────────────────────

function DisplayMockup({ file, fileUrl }: { file: ProjectFile | null; fileUrl: string | null }) {
  const isImage = IMAGE_TYPES.includes(file?.file_type ?? '')
  const isHtml  = file?.file_type === 'text/html'
  return (
    <BrowserFrame>
      <div className="bg-[#0a1929] p-4 flex flex-col items-center gap-3">
        <div className="w-full space-y-1"><div className="h-1.5 bg-white/[0.06] rounded-full w-3/4" /><div className="h-1.5 bg-white/[0.06] rounded-full w-full" /></div>
        <div className="bg-white border border-white/10 rounded overflow-hidden w-full">
          <p className="text-center text-[8px] text-gray-400 uppercase tracking-wider py-0.5 bg-gray-50 border-b border-gray-100">Advertisement</p>
          {isImage && fileUrl && <img src={fileUrl} alt="" className="w-full h-auto block" />}
          {isHtml && fileUrl && <iframe src={fileUrl} title="Ad preview" className="w-full" style={{ height: 200, border: 'none' }} sandbox="allow-scripts allow-same-origin" />}
          {!isImage && !isHtml && <div className="flex items-center justify-center h-24 text-[10px] text-gray-400">{file?.file_name ?? 'Ad creative'}</div>}
        </div>
        <div className="w-full space-y-1"><div className="h-1.5 bg-white/[0.06] rounded-full w-full" /><div className="h-1.5 bg-white/[0.06] rounded-full w-2/3" /></div>
      </div>
    </BrowserFrame>
  )
}

// ── Device selector ───────────────────────────────────────────────────────────

function DeviceMockup({ card, fileUrls, slides, clientName, clientLogo }: {
  card: ProjectCard; fileUrls: Record<string, string>
  slides: Props['carouselSlides'][string]; clientName: string | null; clientLogo: string | null
}) {
  const firstImage   = card.card_files.find(f => IMAGE_TYPES.includes(f.file_type ?? ''))
  const firstImageUrl = firstImage ? (fileUrls[firstImage.id] ?? null) : null
  const firstVideo   = card.card_files.find(f => VIDEO_TYPES.includes(f.file_type ?? ''))
  const firstVideoUrl = firstVideo ? (fileUrls[firstVideo.id] ?? null) : null
  const firstAudio   = card.card_files.find(f => AUDIO_TYPES.includes(f.file_type ?? ''))
  const firstAudioUrl = firstAudio ? (fileUrls[firstAudio.id] ?? null) : null
  const firstDisplay = card.card_files.find(f => IMAGE_TYPES.includes(f.file_type ?? '') || f.file_type === 'text/html')
  const firstDisplayUrl = firstDisplay ? (fileUrls[firstDisplay.id] ?? null) : null
  const mt = card.media_type

  if (mt === 'Carousel Ad') return (
    <PhoneFrame><CarouselMockup slides={slides} clientName={clientName} clientLogo={clientLogo} /></PhoneFrame>
  )
  if (SOCIAL_TYPES.includes(mt ?? '')) return (
    <PhoneFrame><FacebookFeedMockup card={card} clientName={clientName} clientLogo={clientLogo} imageUrl={firstImageUrl} /></PhoneFrame>
  )
  if (mt === 'Reel Request' || mt === 'Video Request') return (
    <PhoneFrame>
      <div className="bg-black" style={{ minHeight: 400 }}>
        {firstVideoUrl
          ? <video controls className="w-full" preload="metadata"><source src={firstVideoUrl} type={firstVideo?.file_type ?? undefined} /></video>
          : <div className="flex items-center justify-center h-64 text-white/30 text-[10px]">Video not available</div>
        }
      </div>
    </PhoneFrame>
  )
  if (mt === 'Audio Request') return (
    <div className="bg-white/[0.05] border border-white/10 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-amber-500/15 border border-amber-500/20 rounded-full flex items-center justify-center flex-none">
          <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" />
          </svg>
        </div>
        <div><p className="text-sm font-semibold text-white">{firstAudio?.file_name ?? 'Audio Ad'}</p><p className="text-[10px] text-white/40">Audio advertisement</p></div>
      </div>
      {firstAudioUrl && <audio controls className="w-full" preload="metadata"><source src={firstAudioUrl} type={firstAudio?.file_type ?? undefined} /></audio>}
    </div>
  )
  if (DISPLAY_TYPES.includes(mt ?? '')) return <DisplayMockup file={firstDisplay ?? null} fileUrl={firstDisplayUrl} />
  if (firstImageUrl) return <div className="rounded-xl overflow-hidden border border-white/10"><img src={firstImageUrl} alt={card.title} className="w-full h-auto block" /></div>
  return <div className="bg-white/[0.04] rounded-xl border border-dashed border-white/10 p-8 text-center text-[10px] text-white/30">No preview available</div>
}

// ── Status dot ────────────────────────────────────────────────────────────────

function StatusDot({ decision }: { decision: string | null }) {
  if (decision === 'approved')          return <span className="w-2 h-2 rounded-full bg-green-400 flex-none" />
  if (decision === 'changes_requested') return <span className="w-2 h-2 rounded-full bg-amber-400 flex-none" />
  if (decision === 'rejected')          return <span className="w-2 h-2 rounded-full bg-red-400 flex-none" />
  return <span className="w-2 h-2 rounded-full bg-white/20 flex-none" />
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ProjectClient({ project, projectCards, fileUrls, carouselSlides, existingFeedback, adviewerClientId }: Props) {
  const router  = useRouter()
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const initialFeedback = useMemo(() => {
    const map: Record<string, { decision: string | null; comment: string }> = {}
    for (const f of existingFeedback) {
      if (!f.file_id && f.decision) map[f.card_id] = { decision: f.decision, comment: f.comment ?? '' }
    }
    return map
  }, [existingFeedback])

  const [feedback, setFeedback]     = useState(initialFeedback)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [submitted, setSubmitted]   = useState<Set<string>>(
    () => new Set(existingFeedback.filter(f => f.decision && !f.file_id).map(f => f.card_id))
  )
  const [activeTab, setActiveTab]   = useState<'preview' | 'comments'>('preview')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  function updateDecision(cardId: string, decision: string) {
    setFeedback(prev => ({ ...prev, [cardId]: { ...(prev[cardId] ?? { comment: '' }), decision } }))
  }
  function updateComment(cardId: string, comment: string) {
    setFeedback(prev => ({ ...prev, [cardId]: { ...(prev[cardId] ?? { decision: null }), comment } }))
  }

  async function handleSubmit(card: ProjectCard) {
    const fb = feedback[card.id]
    if (!fb?.decision) return
    setSubmitting(card.id)
    const { error } = await supabase.from('adviewer_feedback').insert({
      project_id: project.id, card_id: card.id, file_id: null, slide_id: null,
      adviewer_client_id: adviewerClientId, decision: fb.decision, comment: fb.comment.trim() || null,
    })
    if (!error) {
      await supabase.from('cards').update({ approval_status: fb.decision }).eq('id', card.id)
      await supabase.from('adviewer_events').insert({
        adviewer_client_id: adviewerClientId, project_id: project.id,
        card_id: card.id, event_type: fb.decision, metadata: {},
      })
      setSubmitted(prev => new Set([...prev, card.id]))
    }
    setSubmitting(null)
  }

  async function handleApproveAll() {
    const pending = projectCards.filter(pc => !submitted.has(pc.card.id))
    for (const { card } of pending) {
      setSubmitting(card.id)
      const { error } = await supabase.from('adviewer_feedback').insert({
        project_id: project.id, card_id: card.id, file_id: null, slide_id: null,
        adviewer_client_id: adviewerClientId, decision: 'approved', comment: null,
      })
      if (!error) {
        await supabase.from('cards').update({ approval_status: 'approved' }).eq('id', card.id)
        setFeedback(prev => ({ ...prev, [card.id]: { decision: 'approved', comment: '' } }))
        setSubmitted(prev => new Set([...prev, card.id]))
      }
      setSubmitting(null)
    }
  }

  function scrollToCard(cardId: string) {
    cardRefs.current[cardId]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const clientName  = project.client?.name ?? null
  const clientLogo  = project.client?.fb_page_logo_url ?? null
  const allCards    = projectCards.map(pc => pc.card)
  const pendingCount = allCards.filter(c => !submitted.has(c.id)).length

  return (
    <div className="relative h-screen flex flex-col overflow-hidden" style={{ background: 'radial-gradient(ellipse 120% 90% at 50% 60%, #12101a 0%, #0d0d11 55%, #0a0a0e 100%)' }}>
      <ParticleBackground />

      {/* Top bar */}
      <header className="relative z-20 flex-none border-b border-white/[0.07] flex items-center gap-3 px-5 py-3"
        style={{ background: 'rgba(13,13,17,0.90)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}>

        <button onClick={() => router.push('/adviewer/dashboard')} className="flex-none text-white/30 hover:text-white/70 transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        </button>

        <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-none" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
          <span className="text-white font-black text-[9px] tracking-tight">FTE</span>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate leading-tight">{project.title}</p>
          <p className="text-[10px] text-white/30">{clientName ?? 'FTE Adviewer'}</p>
        </div>

        {/* Preview / Comments tabs */}
        <div className="flex-none flex items-center gap-1 bg-white/[0.06] rounded-lg p-1">
          {(['preview', 'comments'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all capitalize ${activeTab === tab ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/70'}`}>
              {tab}
            </button>
          ))}
        </div>

        {pendingCount > 0 && (
          <button onClick={handleApproveAll}
            className="flex-none px-4 py-1.5 rounded-lg text-xs font-semibold text-white transition-all"
            style={{ background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)', boxShadow: '0 2px 12px rgba(34,197,94,0.3)' }}>
            ✓ Approve all ({pendingCount})
          </button>
        )}

        <button onClick={() => setSidebarOpen(o => !o)} className="flex-none text-white/30 hover:text-white/70 transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
          </svg>
        </button>
      </header>

      {/* Body */}
      <div className="relative z-10 flex flex-1 overflow-hidden">

        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="flex-none w-64 border-r border-white/[0.07] flex flex-col overflow-hidden"
            style={{ background: 'rgba(13,13,17,0.80)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>

            <div className="px-4 pt-5 pb-3 border-b border-white/[0.06]">
              <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-1">Campaign</p>
              <p className="text-sm font-semibold text-white leading-snug">{project.title}</p>
              {project.description && <p className="text-[11px] text-white/35 mt-1 line-clamp-2">{project.description}</p>}
            </div>

            <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
              {allCards.map(card => {
                const fb = feedback[card.id] ?? { decision: null }
                const isSubmitted = submitted.has(card.id)
                return (
                  <button key={card.id} onClick={() => scrollToCard(card.id)}
                    className="w-full text-left flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-white/[0.05] transition-colors group">
                    <StatusDot decision={isSubmitted ? fb.decision : null} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] text-white/70 group-hover:text-white truncate transition-colors leading-tight">{card.title}</p>
                      {card.media_type && <p className="text-[10px] text-white/25 truncate">{card.media_type}</p>}
                    </div>
                  </button>
                )
              })}
            </nav>

            <div className="p-4 border-t border-white/[0.06]">
              <p className="text-[10px] text-white/20 text-center">
                {allCards.length - pendingCount} of {allCards.length} reviewed
              </p>
              <div className="mt-2 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{
                  width: `${allCards.length ? ((allCards.length - pendingCount) / allCards.length) * 100 : 0}%`,
                  background: 'linear-gradient(90deg, #7c3aed, #06b6d4)'
                }} />
              </div>
            </div>
          </aside>
        )}

        {/* Main grid */}
        <main className="flex-1 overflow-y-auto">
          {activeTab === 'preview' ? (
            <div className="p-6 grid grid-cols-1 xl:grid-cols-2 gap-6 auto-rows-max">
              {allCards.map(card => {
                const fb          = feedback[card.id] ?? { decision: null, comment: '' }
                const isSubmitted = submitted.has(card.id)
                const slides      = carouselSlides[card.id] ?? []
                const isPending   = card.client_portal_status === 'pending_approval'
                const isRunning   = card.client_portal_status === 'running'

                return (
                  <div key={card.id} ref={el => { cardRefs.current[card.id] = el }}
                    className="rounded-2xl overflow-hidden flex flex-col"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)' }}>

                    {/* Card header */}
                    <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{card.title}</p>
                        <div className="flex items-center gap-2 mt-1">
                          {card.media_type && (
                            <span className="text-[10px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/20 px-2 py-0.5 rounded-full">{card.media_type}</span>
                          )}
                          {card.flight_start_date && (
                            <span className="text-[10px] text-white/30">{fmtDate(card.flight_start_date)}{card.flight_end_date ? ` – ${fmtDate(card.flight_end_date)}` : ''}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex-none flex items-center gap-2">
                        {isRunning && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-300 border border-green-500/20">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />Live
                          </span>
                        )}
                        {isSubmitted && (
                          <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border ${
                            fb.decision === 'approved' ? 'bg-green-500/15 text-green-300 border-green-500/25' :
                            fb.decision === 'changes_requested' ? 'bg-amber-400/15 text-amber-300 border-amber-400/25' :
                            'bg-red-500/15 text-red-300 border-red-500/25'
                          }`}>
                            {fb.decision === 'approved' ? '✓ Approved' : fb.decision === 'changes_requested' ? 'Changes' : 'Rejected'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Mockup */}
                    <div className="px-4 py-5 flex-1" style={{ background: 'rgba(0,0,0,0.25)' }}>
                      <DeviceMockup card={card} fileUrls={fileUrls} slides={slides} clientName={clientName} clientLogo={clientLogo} />
                      {card.adpiler_preview_url && (
                        <div className="mt-3 text-center">
                          <a href={card.adpiler_preview_url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] font-medium transition-colors"
                            style={{ color: '#22d3ee' }}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                            Interactive preview
                          </a>
                        </div>
                      )}
                    </div>

                    {/* Decision zone — only for pending */}
                    {isPending && (
                      <div className="px-4 py-4 border-t border-white/[0.06]">
                        {isSubmitted ? (
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] text-white/30">Response recorded</p>
                            <button onClick={() => setSubmitted(prev => { const s = new Set(prev); s.delete(card.id); return s })}
                              className="text-[11px] text-white/25 hover:text-white/50 underline">
                              Change
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex gap-2 mb-3">
                              {DECISIONS.map(opt => (
                                <button key={opt.value} onClick={() => updateDecision(card.id, opt.value)}
                                  className={`flex-1 py-1.5 rounded-lg border text-[11px] font-semibold transition-all ${fb.decision === opt.value ? opt.active : opt.idle}`}>
                                  {opt.icon} {opt.label}
                                </button>
                              ))}
                            </div>

                            {fb.decision && (
                              <>
                                <textarea value={fb.comment} onChange={e => updateComment(card.id, e.target.value)} rows={2}
                                  placeholder={fb.decision === 'approved' ? 'Optional note…' : 'Describe what needs to change…'}
                                  className="w-full px-3 py-2 text-xs rounded-xl text-white placeholder-white/20 focus:outline-none transition resize-none mb-2"
                                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }} />
                                <button onClick={() => handleSubmit(card)}
                                  disabled={submitting === card.id || (fb.decision !== 'approved' && !fb.comment.trim())}
                                  className="w-full py-2 rounded-xl text-xs font-semibold text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                                  style={{
                                    background: fb.decision === 'approved' ? 'linear-gradient(135deg,#22c55e,#16a34a)' :
                                                fb.decision === 'changes_requested' ? 'linear-gradient(135deg,#f59e0b,#d97706)' :
                                                'linear-gradient(135deg,#ef4444,#dc2626)'
                                  }}>
                                  {submitting === card.id ? 'Submitting…' : 'Submit'}
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            /* Comments tab */
            <div className="p-6 space-y-4 max-w-2xl mx-auto">
              {allCards.map(card => {
                const fb = feedback[card.id] ?? { decision: null, comment: '' }
                return (
                  <div key={card.id} className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div className="flex items-center gap-2 mb-3">
                      <StatusDot decision={submitted.has(card.id) ? fb.decision : null} />
                      <p className="text-sm font-semibold text-white">{card.title}</p>
                    </div>
                    {submitted.has(card.id) && fb.comment ? (
                      <p className="text-sm text-white/50 whitespace-pre-wrap">{fb.comment}</p>
                    ) : submitted.has(card.id) ? (
                      <p className="text-xs text-white/25 italic">No comment left</p>
                    ) : (
                      <p className="text-xs text-white/25 italic">Not yet reviewed</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
