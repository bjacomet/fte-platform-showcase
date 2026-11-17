'use client'

import { useState } from 'react'
import type { Card, CarouselSlide, Client } from '@/types'
import { landingHostname } from '@/lib/url'

interface Props {
  card: Card
  client: Client | null
  slides: CarouselSlide[]
}

function PageAvatar({ client, fbPageName }: { client: Client | null; fbPageName: string | null }) {
  const name = fbPageName || client?.name || 'Page'

  if (client?.fb_page_logo_url) {
    return (
      <img src={client.fb_page_logo_url} alt={name} className="w-10 h-10 rounded-full object-cover" />
    )
  }

  const initials = name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  const colors = ['#1877F2', '#0084FF', '#3578E5', '#166FE5', '#0668E1']
  const color = colors[name.charCodeAt(0) % colors.length]

  return (
    <div
      className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm flex-none"
      style={{ backgroundColor: color }}
    >
      {initials}
    </div>
  )
}

function SlideCard({
  slide,
  isActive,
  cta,
  showCta,
}: {
  slide: CarouselSlide
  isActive: boolean
  cta: string
  showCta: boolean
}) {
  const domain = landingHostname(slide.landing_page_url) || null

  return (
    <div
      className={`flex-none w-[220px] rounded-lg overflow-hidden border flex flex-col transition-all duration-200 ${
        isActive ? 'border-gray-300 shadow-md' : 'border-gray-200 opacity-80'
      }`}
    >
      {/* Slide image — fixed height */}
      <div className="relative w-full bg-gray-100 flex-none" style={{ height: 220 }}>
        {slide.image_url ? (
          <img
            src={slide.image_url}
            alt={slide.headline ?? 'Slide'}
            className="w-full h-full object-cover block"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 flex-col gap-1">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
            </svg>
            <span className="text-xs text-gray-400">No image</span>
          </div>
        )}
      </div>

      {/* Slide info — flex-1 fills the card bottom so gray covers the full height */}
      <div className="bg-[#F0F2F5] px-3 py-2.5 flex-1 flex flex-col justify-between">
        <div>
          {domain && <p className="text-[10px] text-[#65676B] uppercase tracking-wide mb-0.5">{domain}</p>}
          {slide.headline && (
            <p className="text-sm font-semibold text-[#050505] leading-tight">{slide.headline}</p>
          )}
          {slide.link_description && (
            <p className="text-xs text-[#65676B] mt-0.5 leading-tight">{slide.link_description}</p>
          )}
        </div>
        {showCta && (
          <div className="flex justify-end mt-2">
            <button
              className="text-white text-xs font-semibold px-3 py-1.5 rounded whitespace-nowrap shadow"
              style={{ backgroundColor: '#1877F2' }}
            >
              {cta}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function FacebookCarouselPreview({ card, client, slides }: Props) {
  const [activeIndex, setActiveIndex] = useState(0)
  const pageName = card.fb_page_name || client?.name || 'Your Page'
  const cta = card.fb_cta || 'Learn More'
  const showCta = cta !== 'No Button'
  const sorted = [...slides].sort((a, b) => a.position - b.position)
  const canPrev = activeIndex > 0
  const canNext = activeIndex < sorted.length - 1

  if (sorted.length === 0) {
    return (
      <div className="w-full max-w-[500px] mx-auto font-sans text-[15px] select-none">
        <div className="bg-white rounded-lg shadow-md overflow-hidden border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-400">Add slides below to see the carousel preview.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full max-w-[500px] mx-auto font-sans text-[15px] select-none">
      <div className="bg-white rounded-lg shadow-md overflow-hidden border border-gray-200">

        {/* Post header */}
        <div className="flex items-center gap-2.5 px-3 pt-3 pb-2">
          <PageAvatar client={client} fbPageName={card.fb_page_name} />
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-[#050505] text-sm leading-tight">{pageName}</p>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-xs text-[#65676B]">Sponsored</span>
              <span className="text-[#65676B] text-xs">·</span>
              <svg className="w-3 h-3 text-[#65676B]" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm0 14A6 6 0 118 2a6 6 0 010 12z"/>
              </svg>
            </div>
          </div>
          <button className="text-[#65676B] p-1 rounded-full hover:bg-gray-100">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zm6 0a2 2 0 11-4 0 2 2 0 014 0zm6 0a2 2 0 11-4 0 2 2 0 014 0z"/>
            </svg>
          </button>
          <button className="text-[#65676B] p-1 rounded-full hover:bg-gray-100">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
            </svg>
          </button>
        </div>

        {/* Body text */}
        {card.fb_body_text && (
          <div className="px-3 pb-2.5">
            <p className="text-[#050505] text-sm leading-snug whitespace-pre-wrap">{card.fb_body_text}</p>
          </div>
        )}

        {/* Carousel slides strip — translate-based so the window pans on navigation */}
        <div className="relative overflow-hidden">
          <div
            className="flex gap-2 pl-3 pb-2 transition-transform duration-300 ease-in-out"
            style={{ transform: `translateX(${-activeIndex * 228}px)` }}
          >
            {sorted.map((slide, i) => (
              <SlideCard key={slide.id} slide={slide} isActive={i === activeIndex} cta={cta} showCta={showCta} />
            ))}
          </div>

          {/* Navigation arrows */}
          {canPrev && (
            <button
              onClick={() => setActiveIndex((i) => i - 1)}
              className="absolute left-1 top-[110px] -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-md flex items-center justify-center text-gray-600 hover:bg-gray-50 border border-gray-200 z-10"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
              </svg>
            </button>
          )}
          {canNext && (
            <button
              onClick={() => setActiveIndex((i) => i + 1)}
              className="absolute right-1 top-[110px] -translate-y-1/2 w-8 h-8 bg-white rounded-full shadow-md flex items-center justify-center text-gray-600 hover:bg-gray-50 border border-gray-200 z-10"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          )}
        </div>

        {/* Dot indicators */}
        <div className="flex items-center gap-1 px-3 pb-2.5 pt-1">
          {sorted.map((_, i) => (
            <button
              key={i}
              onClick={() => setActiveIndex(i)}
              className={`rounded-full transition-all ${
                i === activeIndex ? 'w-2.5 h-2.5 bg-[#1877F2]' : 'w-2 h-2 bg-gray-300 hover:bg-gray-400'
              }`}
            />
          ))}
        </div>

        {/* Engagement bar */}
        <div className="px-3 py-1 border-t border-gray-200">
          <div className="flex items-center justify-around">
            {[
              { icon: '👍', label: 'Like' },
              { icon: '💬', label: 'Comment' },
              { icon: '↗️', label: 'Share' },
            ].map(({ icon, label }) => (
              <button
                key={label}
                className="flex items-center gap-1.5 text-[#65676B] text-sm font-semibold py-2 px-4 rounded-lg hover:bg-gray-100 flex-1 justify-center"
              >
                <span>{icon}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
