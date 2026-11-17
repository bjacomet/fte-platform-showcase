'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { AdviewerToken } from '@/types'
import { resolveFileUrl } from '@/lib/mediaKind'
import { withHttpsScheme } from '@/lib/url'

interface Props {
  tokenData: AdviewerToken
}

type CardFile = {
  id: string
  file_name: string
  file_url: string
  file_type: string | null
  dimensions: string | null
}

type Slide = {
  id: string
  position: number
  image_url: string | null
  headline: string | null
  link_description: string | null
  landing_page_url: string | null
}


const SOCIAL_TYPES = ['Social Ad Request', 'Reel Request', 'Video Request']
const CAROUSEL_TYPES = ['Carousel Ad']

function isSocial(mt: string | null | undefined) { return SOCIAL_TYPES.includes(mt ?? '') }
function isCarousel(mt: string | null | undefined) { return CAROUSEL_TYPES.includes(mt ?? '') }

// ── Ad type icon ──────────────────────────────────────────────────────────────
function AdTypeIcon({ mediaType, className = 'w-4 h-4' }: { mediaType: string | null | undefined; className?: string }) {
  if (isSocial(mediaType) || isCarousel(mediaType)) {
    // Facebook icon
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
      </svg>
    )
  }
  // Display/banner — image icon
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  )
}

// ── Body text with "See more" truncation ─────────────────────────────────────
function BodyText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const LIMIT = 120
  const long = text.length > LIMIT
  return (
    <p className="px-4 pb-3 text-[13px] text-gray-800 leading-relaxed">
      {long && !expanded ? <>{text.slice(0, LIMIT)}… <button onClick={() => setExpanded(true)} className="text-gray-500 font-semibold hover:underline">See more</button></> : text}
    </p>
  )
}

// ── Facebook post mockup ──────────────────────────────────────────────────────
function FacebookMockup({
  fileUrl,
  pageName,
  clientName,
  bodyText,
  headline,
  description,
  cta,
  logoUrl,
  landingPageUrl,
  mediaType,
}: {
  fileUrl: string
  pageName: string | null
  clientName: string | null
  bodyText: string | null
  headline: string | null
  description: string | null
  cta: string | null
  logoUrl: string | null
  landingPageUrl: string | null
  mediaType: string | null | undefined
}) {
  const isVideo = fileUrl.match(/\.(mp4|webm|mov)$/i)
  const displayName = pageName || clientName || 'Page Name'
  const initials = displayName.slice(0, 2).toUpperCase()

  return (
    <div className="w-full max-w-[500px] mx-auto rounded-xl overflow-hidden shadow-2xl bg-white" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
      {/* Post header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-10 h-10 rounded-full overflow-hidden flex-none bg-gray-200 flex items-center justify-center">
          {logoUrl ? (
            <img src={logoUrl} alt={displayName} className="w-full h-full object-cover" />
          ) : (
            <span className="text-xs font-bold text-gray-600">{initials}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-gray-900 leading-tight">{displayName}</p>
          <div className="flex items-center gap-1">
            <p className="text-[11px] text-gray-500">Ad</p>
            <span className="text-gray-400 text-[11px]">·</span>
            <svg className="w-3 h-3 text-gray-400" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 14.5a6.5 6.5 0 110-13 6.5 6.5 0 010 13z"/>
              <path d="M8 4a4 4 0 100 8A4 4 0 008 4z"/>
            </svg>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-gray-400 flex-none" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
          </svg>
          <svg className="w-4 h-4 text-gray-400 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      </div>

      {/* Body text */}
      {bodyText && <BodyText text={bodyText} />}

      {/* Creative */}
      <div className="bg-gray-100">
        {isVideo ? (
          <video src={fileUrl} controls className="w-full max-h-80 object-cover" />
        ) : (
          <img src={fileUrl} alt="Ad creative" className="w-full object-cover" style={{ maxHeight: 500 }} />
        )}
      </div>

      {/* CTA bar */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-[#f0f2f5] border-t border-gray-200">
        <div className="min-w-0 flex-1">
          {headline && <p className="text-[13px] font-semibold text-gray-900 leading-tight">{headline}</p>}
          {description && <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-1">{description}</p>}
        </div>
        {cta && (
          <a
            href={withHttpsScheme(landingPageUrl) || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-3 flex-none text-[13px] font-semibold bg-[#e4e6eb] text-gray-800 rounded px-3.5 py-1.5 hover:bg-[#d8dadf] transition-colors whitespace-nowrap"
          >
            {cta}
          </a>
        )}
      </div>

      {/* Reactions row */}
      <div className="flex items-center px-4 py-2 border-t border-gray-200 bg-white">
        {[
          { icon: '👍', label: 'Like' },
          { icon: '💬', label: 'Comment' },
          { icon: '↗', label: 'Share' },
        ].map(({ icon, label }) => (
          <button key={label} className="flex items-center gap-1.5 flex-1 justify-center py-1.5 rounded-md text-[13px] font-medium text-gray-600 hover:bg-gray-100 transition-colors">
            <span>{icon}</span> {label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Browser / Display mockup ──────────────────────────────────────────────────
function DisplayMockup({ fileUrl, title }: { fileUrl: string; title: string }) {
  const isVideo = fileUrl.match(/\.(mp4|webm|mov)$/i)
  return (
    <div className="w-full max-w-3xl mx-auto rounded-xl overflow-hidden shadow-2xl">
      <div className="flex items-center gap-2 px-4 py-3 bg-[#2d2d2d]">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-rose-500" />
          <div className="w-3 h-3 rounded-full bg-amber-500" />
          <div className="w-3 h-3 rounded-full bg-emerald-500" />
        </div>
        <div className="flex-1 mx-2 bg-[#3d3d3d] rounded-md px-3 py-1 flex items-center gap-2">
          <svg className="w-3 h-3 text-gray-400 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A13.916 13.916 0 008 11a4 4 0 118 0c0 1.017-.07 2.019-.203 3m-2.118 6.844A21.88 21.88 0 0015.171 17m3.839 1.132c.645-2.266.99-4.659.99-7.132A8 8 0 008 4.07M3 15.364c.64-1.319 1-2.8 1-4.364 0-1.457.39-2.823 1.07-4" />
          </svg>
          <span className="text-xs text-gray-400 truncate">followtheeyes.com · Ad Preview</span>
        </div>
      </div>
      <div className="bg-white flex items-center justify-center p-8 min-h-[300px]">
        {isVideo ? (
          <video src={fileUrl} controls className="max-w-full max-h-[500px] rounded shadow" />
        ) : (
          <img src={fileUrl} alt={title} className="max-w-full max-h-[600px] object-contain rounded shadow" />
        )}
      </div>
    </div>
  )
}

// ── Carousel mockup ───────────────────────────────────────────────────────────
function CarouselMockup({
  slides,
  pageName,
  clientName,
  bodyText,
  logoUrl,
}: {
  slides: Slide[]
  pageName: string | null
  clientName: string | null
  bodyText: string | null
  logoUrl: string | null
}) {
  const [idx, setIdx] = useState(0)
  const sorted = [...slides].sort((a, b) => a.position - b.position)
  if (!sorted.length) return <p className="text-white/30 text-sm text-center py-12">No slides uploaded yet</p>
  const slide = sorted[idx]
  const displayName = pageName || clientName || 'Page Name'

  return (
    <div className="w-full max-w-[500px] mx-auto rounded-xl overflow-hidden shadow-2xl bg-white" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-10 h-10 rounded-full overflow-hidden flex-none bg-gray-200 flex items-center justify-center">
          {logoUrl ? <img src={logoUrl} alt="" className="w-full h-full object-cover" /> : <span className="text-xs font-bold text-gray-600">{displayName.slice(0,2).toUpperCase()}</span>}
        </div>
        <div>
          <p className="text-[13px] font-semibold text-gray-900">{displayName}</p>
          <p className="text-[11px] text-gray-500">Ad ·</p>
        </div>
      </div>
      {bodyText && <BodyText text={bodyText} />}
      <div className="relative bg-gray-50">
        {slide.image_url && <img src={resolveFileUrl(slide.image_url)} alt={slide.headline ?? ''} className="w-full h-64 object-cover" />}
        {sorted.length > 1 && (
          <>
            <button onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow flex items-center justify-center disabled:opacity-30">
              <svg className="w-4 h-4 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button onClick={() => setIdx(i => Math.min(sorted.length - 1, i + 1))} disabled={idx === sorted.length - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow flex items-center justify-center disabled:opacity-30">
              <svg className="w-4 h-4 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </>
        )}
      </div>
      {slide.headline && (
        <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-200">
          <p className="text-[13px] font-semibold text-gray-900">{slide.headline}</p>
        </div>
      )}
      {sorted.length > 1 && (
        <div className="flex justify-center gap-1.5 py-2 bg-gray-50">
          {sorted.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)} className={`rounded-full transition-all ${i === idx ? 'w-4 h-1.5 bg-[#1877F2]' : 'w-1.5 h-1.5 bg-gray-300'}`} />
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 px-4 py-2.5 border-t border-gray-100">
        {['👍 Like', '💬 Comment', '↗ Share'].map(a => (
          <button key={a} className="flex-1 text-center py-1 rounded-md text-[13px] font-medium text-gray-600 hover:bg-gray-100 transition-colors">{a}</button>
        ))}
      </div>
    </div>
  )
}

// ── Review section types ───────────────────────────────────────────────────────
type SectionKey = 'caption' | 'graphic' | 'headline' | 'subheader' | 'button'
type SectionStatus = 'pending' | 'approved' | 'changes'
interface SectionState { status: SectionStatus; note: string }
type ReviewState = Record<SectionKey, SectionState>

const SECTIONS: { key: SectionKey; label: string; hint: string }[] = [
  { key: 'caption', label: 'Caption', hint: 'The body copy above the image' },
  { key: 'graphic', label: 'Graphic', hint: 'The creative image or video' },
  { key: 'headline', label: 'Headline', hint: 'The main headline and call-to-action button' },
  { key: 'subheader', label: 'Sub Header', hint: 'The link description text below the headline' },
  { key: 'button', label: 'Button URL', hint: 'Paste the destination URL for the call-to-action button' },
]

function parseStoredNotes(raw: string | null): { review: ReviewState; reviewer: string } | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw)
    if (p?.caption && p?.graphic && p?.headline) {
      return { review: p as ReviewState, reviewer: p.reviewer ?? '' }
    }
  } catch {}
  return null
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function PreviewClient({ tokenData }: Props) {
  const supabase = createClient()
  const card = tokenData.card
  const client = tokenData.client
  const mediaType = card?.media_type ?? null
  const displayTitle = tokenData.title ?? card?.title ?? 'Ad Preview'
  const files: CardFile[] = (card?.card_files ?? []) as CardFile[]
  const slides: Slide[] = (card?.carousel_slides ?? []) as Slide[]
  const [selectedFileId, setSelectedFileId] = useState<string | null>(files[0]?.id ?? null)
  const selectedFile = files.find(f => f.id === selectedFileId) ?? files[0] ?? null

  const isPending = tokenData.status === 'pending'
  const stored = parseStoredNotes(tokenData.client_notes ?? null)

  const defaultReview: ReviewState = {
    caption: { status: 'pending', note: '' },
    graphic: { status: 'pending', note: '' },
    headline: { status: 'pending', note: '' },
    subheader: { status: 'pending', note: '' },
    button: { status: 'pending', note: '' },
  }

  const [review, setReview] = useState<ReviewState>(stored?.review ?? defaultReview)
  const [reviewerName, setReviewerName] = useState(stored?.reviewer ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  function setSection(key: SectionKey, patch: Partial<SectionState>) {
    setReview(r => ({ ...r, [key]: { ...r[key], ...patch } }))
  }

  const allReviewed = Object.values(review).every(s => s.status !== 'pending')
  const allApproved = Object.values(review).every(s => s.status === 'approved')
  const anyChanges = Object.values(review).some(s => s.status === 'changes')
  const canSubmit = allReviewed && reviewerName.trim().length > 0
  const isReadOnly = submitted || !isPending

  async function handleSubmit() {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    await supabase.from('adviewer_tokens').update({
      status: allApproved ? 'approved' : 'needs_revision',
      client_notes: JSON.stringify({ reviewer: reviewerName.trim(), ...review }),
      updated_at: new Date().toISOString(),
    }).eq('id', tokenData.id)
    setSubmitted(true)
    setSubmitting(false)
  }

  const adMockup = isCarousel(mediaType) && slides.length > 0 ? (
    <CarouselMockup slides={slides} pageName={card?.fb_page_name ?? null} clientName={client?.name ?? null} bodyText={card?.fb_body_text ?? null} logoUrl={client?.fb_page_logo_url ?? null} />
  ) : isSocial(mediaType) && selectedFile ? (
    <FacebookMockup
      fileUrl={resolveFileUrl(selectedFile.file_url)}
      pageName={card?.fb_page_name ?? null}
      clientName={client?.name ?? null}
      bodyText={card?.fb_body_text ?? null}
      headline={card?.fb_headline ?? null}
      description={card?.fb_link_description ?? null}
      cta={card?.fb_cta ?? null}
      logoUrl={client?.fb_page_logo_url ?? null}
      landingPageUrl={card?.landing_page_url ?? null}
      mediaType={mediaType}
    />
  ) : selectedFile ? (
    <DisplayMockup fileUrl={resolveFileUrl(selectedFile.file_url)} title={displayTitle} />
  ) : (
    <p className="text-white/25 text-sm text-center py-16">No files uploaded yet</p>
  )

  return (
    <div className="h-screen flex flex-col bg-[#1a1b1e] overflow-hidden">
      {/* Top nav */}
      <header className="flex-none flex items-center justify-between px-5 py-3 bg-[#111214] border-b border-white/[0.08]">
        <div className="flex items-center gap-3">
          <Link href="/adviewer/dashboard" className="flex items-center gap-2 text-white/50 hover:text-white transition-colors group">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            <span className="text-xs font-medium hidden sm:inline">Dashboard</span>
          </Link>
          <div className="w-px h-5 bg-white/[0.1]" />
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-none" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
            <span className="text-white font-black text-[9px]">FTE</span>
          </div>
          <div>
            <p className="text-sm font-semibold text-white leading-tight">{displayTitle}</p>
            {client?.name && <p className="text-[10px] text-white/30">{client.name}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(tokenData.status === 'approved' || (submitted && allApproved)) && (
            <span className="text-xs font-semibold px-3 py-1 rounded-full bg-emerald-400/15 text-emerald-300 border border-emerald-400/25">✓ Approved</span>
          )}
          {(tokenData.status === 'needs_revision' || (submitted && anyChanges)) && (
            <span className="text-xs font-semibold px-3 py-1 rounded-full bg-amber-400/15 text-amber-300 border border-amber-400/25">Revision requested</span>
          )}
        </div>
      </header>

      {/* Two-column body */}
      <div className="flex flex-1 min-h-0">

        {/* Left — ad preview */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 overflow-auto flex items-start justify-center p-8">
            {adMockup}
          </div>

          {/* File strip — only when multiple files */}
          {files.length > 1 && (
            <div className="flex-none border-t border-white/[0.08] bg-[#111214] px-4 py-2 flex items-center gap-2 overflow-x-auto">
              {files.map((file, i) => {
                const isActive = file.id === selectedFile?.id
                const ext = file.file_name.split('.').pop()?.toLowerCase() ?? ''
                const isVideo = ['mp4', 'mov', 'webm'].includes(ext)
                const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
                return (
                  <button
                    key={file.id}
                    onClick={() => setSelectedFileId(file.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all flex-none max-w-[200px] border ${
                      isActive
                        ? 'bg-white/[0.1] border-white/20 text-white'
                        : 'border-transparent text-white/40 hover:text-white/70 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className="text-[10px] font-bold text-white/30 flex-none">
                      {isVideo ? '▶' : isImage ? '⬛' : '#'}{i + 1}
                    </span>
                    <span className="text-[11px] font-medium truncate leading-tight">{file.file_name}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Right — review panel */}
        <aside className="w-[360px] flex-none bg-[#111214] border-l border-white/[0.08] flex flex-col overflow-hidden">
          <div className="flex-none px-5 py-4 border-b border-white/[0.06] space-y-3">
            <div>
              <p className="text-sm font-semibold text-white">Review</p>
              <p className="text-[11px] text-white/40 mt-0.5">
                {isReadOnly
                  ? reviewerName
                    ? <span>Submitted by <span className="text-white/60 font-medium">{reviewerName}</span></span>
                    : 'Client feedback is shown below.'
                  : 'Approve each section or note what needs to change.'}
              </p>
            </div>
            {!isReadOnly && (
              <div>
                <label className="block text-[10px] font-semibold text-white/30 uppercase tracking-wider mb-1">Your name</label>
                <input
                  type="text"
                  value={reviewerName}
                  onChange={e => setReviewerName(e.target.value)}
                  placeholder="e.g. Maria"
                  className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-white/25"
                />
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {SECTIONS.map(({ key, label, hint }) => {
              const s = review[key]
              const approved = s.status === 'approved'
              const needsChanges = s.status === 'changes'
              return (
                <div
                  key={key}
                  className={`rounded-xl border transition-all ${
                    approved
                      ? 'border-emerald-500/30 bg-emerald-500/[0.05]'
                      : needsChanges
                      ? 'border-amber-500/30 bg-amber-500/[0.05]'
                      : 'border-white/[0.08] bg-white/[0.03]'
                  }`}
                >
                  {/* Section header */}
                  <div className="px-4 pt-3 pb-2">
                    <div className="flex items-center justify-between">
                      <p className={`text-[13px] font-semibold ${approved ? 'text-emerald-300' : needsChanges ? 'text-amber-300' : 'text-white'}`}>
                        {label}
                      </p>
                      {approved && <span className="text-[11px] text-emerald-400 font-medium">✓ Approved</span>}
                      {needsChanges && <span className="text-[11px] text-amber-400 font-medium">Changes needed</span>}
                    </div>
                    <p className="text-[11px] text-white/30 mt-0.5">{hint}</p>
                  </div>

                  {/* Action buttons — only when editable */}
                  {!isReadOnly && (
                    <div className="px-4 pb-3 flex gap-2">
                      <button
                        onClick={() => setSection(key, { status: approved ? 'pending' : 'approved', note: '' })}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                          approved
                            ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                            : 'border-white/10 text-white/50 hover:text-white hover:border-white/25 hover:bg-white/[0.05]'
                        }`}
                      >
                        ✓ Looks good
                      </button>
                      <button
                        onClick={() => setSection(key, { status: needsChanges ? 'pending' : 'changes' })}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                          needsChanges
                            ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                            : 'border-white/10 text-white/50 hover:text-white hover:border-white/25 hover:bg-white/[0.05]'
                        }`}
                      >
                        ✗ Needs changes
                      </button>
                    </div>
                  )}

                  {/* Note — editable or read-only */}
                  {needsChanges && (
                    <div className="px-4 pb-3">
                      {isReadOnly ? (
                        <p className="text-[13px] text-white/70 bg-white/[0.04] rounded-lg px-3 py-2 border border-white/[0.06] leading-relaxed">
                          {s.note || <span className="italic text-white/30">No notes left</span>}
                        </p>
                      ) : key === 'button' ? (
                        <input
                          type="url"
                          value={s.note}
                          onChange={e => setSection(key, { note: e.target.value })}
                          placeholder="https://example.com/promo"
                          className="w-full bg-white/[0.05] border border-amber-500/20 rounded-lg px-3 py-2 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-amber-400/40"
                        />
                      ) : (
                        <textarea
                          value={s.note}
                          onChange={e => setSection(key, { note: e.target.value })}
                          placeholder={`What needs to change in the ${label.toLowerCase()}?`}
                          rows={3}
                          className="w-full bg-white/[0.05] border border-amber-500/20 rounded-lg px-3 py-2 text-[13px] text-white placeholder-white/20 focus:outline-none focus:border-amber-400/40 resize-none"
                        />
                      )}
                    </div>
                  )}

                  {/* Read-only approved label */}
                  {approved && isReadOnly && (
                    <div className="px-4 pb-3">
                      <p className="text-[11px] text-emerald-400/50 italic">Approved by client</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Submit or confirmation */}
          <div className="flex-none px-4 py-4 border-t border-white/[0.08]">
            {submitted ? (
              <p className="text-[13px] font-medium text-emerald-400 text-center">✓ Response sent — the FTE team has been notified.</p>
            ) : isPending ? (
              <>
                {!canSubmit && (
                  <p className="text-[11px] text-white/30 text-center mb-3">
                    {!reviewerName.trim() ? 'Enter your name above to submit' : 'Review all sections to submit'}
                  </p>
                )}
                <button
                  onClick={handleSubmit}
                  disabled={!canSubmit || submitting}
                  className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={canSubmit ? { background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)', color: 'white' } : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}
                >
                  {submitting ? 'Submitting…' : allApproved ? 'Submit Approval' : 'Submit Feedback'}
                </button>
              </>
            ) : (
              <p className="text-[11px] text-white/30 text-center">
                {tokenData.status === 'approved' ? '✓ Fully approved' : 'Revision feedback submitted'}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
