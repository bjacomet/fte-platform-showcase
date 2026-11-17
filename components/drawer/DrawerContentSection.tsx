'use client'

import { memo, useRef, useState } from 'react'
import Image from 'next/image'
import type { CarouselSlide, InstantExperience, LocalSlide, MessengerWelcome } from '@/types'
import { FB_CTA_OPTIONS } from '@/types'
import { drawerInputClass, drawerLabelClass } from '@/lib/formStyles'
import EditableTextField from '@/components/EditableTextField'
import MessengerWelcomeEditor from '@/components/MessengerWelcomeEditor'
import InstantExperienceEditor from '@/components/InstantExperienceEditor'
import { isSupabaseImageHost } from '@/lib/imageHost'

interface Props {
  // Visibility flags (derived from mediaType in parent)
  isDisplay: boolean
  hasFbMeta: boolean
  isOrganic: boolean
  isVideo: boolean
  isAudio: boolean
  isFbEvent: boolean
  isCarousel: boolean
  isMessenger: boolean
  isInstantExperience: boolean

  // Messenger Ad welcome message
  messengerWelcome: MessengerWelcome | null
  onMessengerWelcomeChange: (v: MessengerWelcome | null) => void
  // Instant Experience inner blocks
  instantExperience: InstantExperience | null
  onInstantExperienceChange: (v: InstantExperience | null) => void
  onUploadCardMedia: (file: File, onProgress?: (loaded: number, total: number) => void) => Promise<string | null>
  fbPageLogoUrl: string | null

  // Display fields
  heading: string
  onHeadingChange: (v: string) => void
  subheading: string
  onSubheadingChange: (v: string) => void
  buttonText: string
  onButtonTextChange: (v: string) => void

  // Caption / companion / event
  caption: string
  onCaptionChange: (v: string) => void
  boostBudget: string
  onBoostBudgetChange: (v: string) => void
  companionBannerLink: string
  onCompanionBannerLinkChange: (v: string) => void
  eventDescription: string
  onEventDescriptionChange: (v: string) => void

  // FB / ad meta
  fbPageName: string
  onFbPageNameChange: (v: string) => void
  fbBodyText: string
  onFbBodyTextChange: (v: string) => void
  fbHeadline: string
  onFbHeadlineChange: (v: string) => void
  fbSubheadline: string
  onFbSubheadlineChange: (v: string) => void
  fbLinkDescription: string
  onFbLinkDescriptionChange: (v: string) => void
  fbCta: string
  onFbCtaChange: (v: string) => void

  // Carousel
  slides: LocalSlide[]
  slidesLoaded: boolean
  uploadingSlide: string | null
  dragOverSlide: string | null
  onDragOverSlide: (id: string | null) => void
  onAddSlide: () => void
  onRemoveSlide: (id: string) => void
  onSlideChange: (id: string, field: keyof CarouselSlide, value: string) => void
  // Group drop / multi-select onto a slide: one image replaces that slide, several distribute
  // across it and the following slides (see CardDrawer.handleSlideImagesDrop).
  onSlideImagesDrop: (slideId: string, files: File[]) => void
  hasBuildLink: boolean
  rePulling: boolean
  onRePullSlides: () => void
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">{title}</span>
      <div className="flex-1 h-px bg-gray-700/60" />
    </div>
  )
}

export default memo(function DrawerContentSection({
  isDisplay, hasFbMeta, isOrganic, isVideo, isAudio, isFbEvent, isCarousel, isMessenger, isInstantExperience,
  messengerWelcome, onMessengerWelcomeChange,
  instantExperience, onInstantExperienceChange, onUploadCardMedia,
  fbPageLogoUrl,
  heading, onHeadingChange,
  subheading, onSubheadingChange,
  buttonText, onButtonTextChange,
  caption, onCaptionChange,
  boostBudget, onBoostBudgetChange,
  companionBannerLink, onCompanionBannerLinkChange,
  eventDescription, onEventDescriptionChange,
  fbPageName, onFbPageNameChange,
  fbBodyText, onFbBodyTextChange,
  fbHeadline, onFbHeadlineChange,
  fbSubheadline, onFbSubheadlineChange,
  fbLinkDescription, onFbLinkDescriptionChange,
  fbCta, onFbCtaChange,
  slides, slidesLoaded,
  uploadingSlide, dragOverSlide, onDragOverSlide,
  onAddSlide, onRemoveSlide, onSlideChange, onSlideImagesDrop,
  hasBuildLink, rePulling, onRePullSlides,
}: Props) {
  const lbl = drawerLabelClass
  const inp = drawerInputClass
  const ta  = `${inp} resize-none`

  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const visibleSlides = slides.filter((s) => !s._deleted)
  // Carousel slides are image-only — a video dropped here is the old IE workaround.
  // Reject it with a redirect to the Instant Experience card type (cleanup rule).
  const [videoRejected, setVideoRejected] = useState(false)

  // Messenger Ad cards get their own dedicated editor (no FB/ad-meta fields).
  if (isMessenger) {
    return <MessengerWelcomeEditor value={messengerWelcome} onChange={onMessengerWelcomeChange} pageName={fbPageName} pageLogoUrl={fbPageLogoUrl} />
  }

  // Instant Experience cards get the block builder (no FB/ad-meta fields — the outer
  // trigger ad reuses the card's Facebook copy from other tabs).
  if (isInstantExperience) {
    return (
      <InstantExperienceEditor
        value={instantExperience}
        onChange={onInstantExperienceChange}
        onUploadMedia={onUploadCardMedia}
        pageName={fbPageName}
        pageLogoUrl={fbPageLogoUrl}
        coverBodyText={fbBodyText}
      />
    )
  }

  // Display ads render in browsers, never in Facebook — so the section header
  // follows the media type instead of always claiming "Facebook Content".
  const sectionTitle =
    isDisplay ? 'Display Content'
    : hasFbMeta ? 'Facebook Content'
    : isOrganic ? 'Organic Post'
    : isVideo ? 'Video Content'
    : isAudio ? 'Audio Content'
    : isFbEvent ? 'Event Content'
    : 'Content'

  return (
    <div>
      <SectionHeader title={sectionTitle} />
      <div className="space-y-3">

        {/* Display: heading, subheading, button */}
        {isDisplay && (
          <>
            <div>
              <label className={lbl}>Heading / Focus</label>
              <input value={heading} onChange={(e) => onHeadingChange(e.target.value)} className={inp} placeholder="Main headline or focus statement" />
            </div>
            <div>
              <label className={lbl}>Subheading</label>
              <input value={subheading} onChange={(e) => onSubheadingChange(e.target.value)} className={inp} placeholder="Supporting text" />
            </div>
            <div>
              <label className={lbl}>Button (optional)</label>
              <input value={buttonText} onChange={(e) => onButtonTextChange(e.target.value)} className={inp} placeholder="e.g. Learn More" />
            </div>
          </>
        )}

        {/* Social Ad + Carousel: full ad meta */}
        {hasFbMeta && (
          <>
            <div>
              <label className={lbl}>Page Name</label>
              <input value={fbPageName} onChange={(e) => onFbPageNameChange(e.target.value)} className={inp} placeholder="Facebook page name" />
            </div>
            <div>
              <label className={lbl}>{isCarousel ? 'Main Message' : 'Primary Text'}</label>
              <EditableTextField value={fbBodyText} onChange={onFbBodyTextChange} rows={3} className={ta} placeholder="Ad body copy…" />
            </div>
            {isCarousel ? (
              /* Carousels: Headline + Link Description live per-slide (below). Only the
                 CTA stays at card level — one button label carries across all slides. */
              <div>
                <label className={lbl}>CTA</label>
                <select value={fbCta} onChange={(e) => onFbCtaChange(e.target.value)} className={inp}>
                  {FB_CTA_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
                <p className="text-[11px] text-gray-500 leading-snug pt-1">One CTA applies to every slide. Headline &amp; link description are set per slide below.</p>
              </div>
            ) : (
              <>
                <div>
                  <label className={lbl}>Headline</label>
                  <input value={fbHeadline} onChange={(e) => onFbHeadlineChange(e.target.value)} className={inp} placeholder="e.g. Summer Overstock Sale" />
                </div>
                <div>
                  <label className={lbl}>Sub Headline</label>
                  <input value={fbSubheadline} onChange={(e) => onFbSubheadlineChange(e.target.value)} className={inp} placeholder="e.g. Visit our dealer" />
                </div>
                <div>
                  <label className={lbl}>CTA</label>
                  <select value={fbCta} onChange={(e) => onFbCtaChange(e.target.value)} className={inp}>
                    {FB_CTA_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lbl}>Link Description</label>
                  <input value={fbLinkDescription} onChange={(e) => onFbLinkDescriptionChange(e.target.value)} className={inp} placeholder="Appears below the headline" />
                </div>
              </>
            )}
            {/* Single-graphic social ads keep the card-level Text for Graphic pair.
                Carousels do NOT — each slide carries its own Text for Graphic (below),
                which is what renders in the preview. The legacy card-level pair is hidden
                for carousels. */}
            {!isCarousel && (
              <>
                <div className="text-[10px] font-bold text-gray-300 uppercase tracking-widest pt-1">Text for Graphic</div>
                <div>
                  <label className={lbl}>Heading</label>
                  <input value={heading} onChange={(e) => onHeadingChange(e.target.value)} className={inp} placeholder="Heading on the graphic" />
                </div>
                <div>
                  <label className={lbl}>Subheading</label>
                  <input value={subheading} onChange={(e) => onSubheadingChange(e.target.value)} className={inp} placeholder="Subheading on the graphic" />
                </div>
              </>
            )}
          </>
        )}

        {/* Organic Post */}
        {isOrganic && (
          <>
            <div>
              <label className={lbl}>Primary Text</label>
              <EditableTextField value={fbBodyText} onChange={onFbBodyTextChange} rows={3} className={ta} placeholder="Post copy…" />
            </div>
            <div className="text-[10px] font-bold text-gray-300 uppercase tracking-widest pt-1">Text for Graphic</div>
            <div>
              <label className={lbl}>Heading</label>
              <input value={heading} onChange={(e) => onHeadingChange(e.target.value)} className={inp} placeholder="Heading on the graphic" />
            </div>
            <div>
              <label className={lbl}>Subheading</label>
              <input value={subheading} onChange={(e) => onSubheadingChange(e.target.value)} className={inp} placeholder="Subheading on the graphic" />
            </div>
            <div>
              <label className={lbl}>Boost Budget</label>
              <input value={boostBudget} onChange={(e) => onBoostBudgetChange(e.target.value)} className={inp} placeholder="e.g. $500" />
            </div>
          </>
        )}

        {/* Video / Reel */}
        {isVideo && (
          <div>
            <label className={lbl}>Caption to Use</label>
            <EditableTextField value={caption} onChange={onCaptionChange} rows={3} className={ta} placeholder="Caption or voiceover copy…" />
          </div>
        )}

        {/* Audio */}
        {isAudio && (
          <>
            <div>
              <label className={lbl}>Caption / Script</label>
              <EditableTextField value={caption} onChange={onCaptionChange} rows={8} maxLines={12} className={ta} placeholder="Paste the full audio script, or upload the script file in the Files tab…" />
            </div>
            <div>
              <label className={lbl}>Link to Companion Banner</label>
              <input value={companionBannerLink} onChange={(e) => onCompanionBannerLinkChange(e.target.value)} className={inp} placeholder="https://…" />
            </div>
          </>
        )}

        {/* FB Event Cover */}
        {isFbEvent && (
          <div>
            <label className={lbl}>Event Description</label>
            <EditableTextField value={eventDescription} onChange={onEventDescriptionChange} rows={4} className={ta} placeholder="Describe the event…" />
          </div>
        )}

        {/* Carousel slides */}
        {isCarousel && slidesLoaded && (
          <div className="space-y-3 pt-1">
            <div className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Carousel Slides</div>

            {videoRejected && (
              <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-300 flex items-start justify-between gap-2">
                <span>Carousel slides are <strong>images only</strong>. For video, create an <strong>Instant Experience</strong> card instead — it&apos;s built for video and graphics.</span>
                <button onClick={() => setVideoRejected(false)} className="text-amber-400/70 hover:text-amber-200 flex-none">×</button>
              </div>
            )}

            {visibleSlides.map((slide, i) => (
              <div key={slide.id} className="bg-gray-800/60 border border-gray-700/60 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-400">Slide {i + 1}</span>
                  <button
                    onClick={() => onRemoveSlide(slide.id)}
                    className="text-gray-600 hover:text-red-400 text-[10px] transition-colors"
                  >
                    Remove
                  </button>
                </div>
                <div className="flex gap-3">
                  {/* Square 1:1 thumbnail — click opens full size in a new tab; hover to replace */}
                  <div
                    className={`relative w-28 aspect-square flex-none self-start rounded border overflow-hidden group transition-colors ${
                      dragOverSlide === slide.id
                        ? 'bg-blue-950/30 border-blue-500'
                        : 'bg-gray-900 border-gray-700'
                    }`}
                    onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) onDragOverSlide(slide.id) }}
                    onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) onDragOverSlide(null) }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onDragOverSlide(null)
                      const all = Array.from(e.dataTransfer.files)
                      setVideoRejected(all.some((f) => f.type.startsWith('video/')))
                      const files = all.filter((f) => f.type.startsWith('image/'))
                      if (files.length) onSlideImagesDrop(slide.id, files)
                    }}
                  >
                    {slide.image_url ? (
                      <>
                        <a
                          href={slide.image_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open full size"
                          className="relative block w-full h-full"
                        >
                          <Image src={slide.image_url} alt="" fill sizes="112px" className="object-cover" unoptimized={!isSupabaseImageHost(slide.image_url)} />
                        </a>
                        <button
                          onClick={(e) => { e.stopPropagation(); onSlideChange(slide.id, 'image_url', '') }}
                          className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center text-white hover:bg-red-600 transition-colors opacity-0 group-hover:opacity-100"
                          title="Remove image"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                          </svg>
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => fileInputRefs.current[slide.id]?.click()}
                        className="w-full h-full flex items-center justify-center text-center px-1 text-[10px] cursor-pointer"
                      >
                        {uploadingSlide === slide.id
                          ? <span className="text-blue-400 animate-pulse">Uploading…</span>
                          : dragOverSlide === slide.id
                            ? <span className="text-blue-400">Drop to upload</span>
                            : <span className="text-gray-500">+ Add / drag image</span>}
                      </button>
                    )}
                    <input
                      ref={(el) => { fileInputRefs.current[slide.id] = el }}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? [])
                        if (files.length) onSlideImagesDrop(slide.id, files)
                        e.target.value = ''
                      }}
                    />
                  </div>
                  {/* Fields — 2-column grids keep the slide compact */}
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Facebook Copy</div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-0.5">
                        <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Headline</label>
                        <input value={slide.headline ?? ''} onChange={(e) => onSlideChange(slide.id, 'headline', e.target.value)} className={inp} placeholder="e.g. Summer Event Sale" />
                      </div>
                      <div className="space-y-0.5">
                        <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Sub Headline</label>
                        <input value={slide.subheadline ?? ''} onChange={(e) => onSlideChange(slide.id, 'subheadline', e.target.value)} className={inp} placeholder="e.g. Visit our dealer" />
                      </div>
                      <div className="space-y-0.5">
                        <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Display Link <span className="text-gray-600 normal-case">(optional)</span></label>
                        <input value={slide.display_link ?? ''} onChange={(e) => onSlideChange(slide.id, 'display_link', e.target.value)} className={inp} placeholder="e.g. example-moto.com" />
                      </div>
                      <div className="space-y-0.5">
                        <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Landing Page URL</label>
                        <input value={slide.landing_page_url ?? ''} onChange={(e) => onSlideChange(slide.id, 'landing_page_url', e.target.value)} className={inp} placeholder="Landing page URL" />
                      </div>
                    </div>
                    <div className="text-[10px] font-bold text-gray-300 uppercase tracking-widest pt-1">Text for Graphic</div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-0.5">
                        <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Graphic Heading</label>
                        <input value={slide.graphic_headline ?? ''} onChange={(e) => onSlideChange(slide.id, 'graphic_headline', e.target.value)} className={inp} placeholder="Graphic heading" />
                      </div>
                      <div className="space-y-0.5">
                        <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Graphic Subheading</label>
                        <input value={slide.graphic_subhead ?? ''} onChange={(e) => onSlideChange(slide.id, 'graphic_subhead', e.target.value)} className={inp} placeholder="Graphic subheading" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={onAddSlide}
              className="w-full py-2 border border-dashed border-gray-600 rounded text-sm text-gray-400 hover:text-gray-200 hover:border-gray-400 transition-colors"
            >
              + Add Slide
            </button>
            {hasBuildLink && (
              <button
                onClick={onRePullSlides}
                disabled={rePulling}
                className="w-full py-2 rounded text-sm font-medium text-blue-300 bg-blue-950/40 border border-blue-800/60 hover:bg-blue-900/50 hover:text-blue-200 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                title="Re-import the graphics from the Build folder onto slides by their trailing _NN"
              >
                {rePulling ? 'Re-pulling…' : 'Re-pull from Build folder'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})
