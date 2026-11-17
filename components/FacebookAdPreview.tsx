'use client'

import type { Card, CardFile, Client } from '@/types'

interface Props {
  card: Card
  client: Client | null
  previewImageUrl: string | null
}

const CTA_COLORS: Record<string, string> = {
  'Shop Now':      '#1877F2',
  'Learn More':    '#1877F2',
  'Sign Up':       '#1877F2',
  'Subscribe':     '#1877F2',
  'Contact Us':    '#1877F2',
  'Book Now':      '#1877F2',
  'Order Now':     '#1877F2',
  'Download':      '#1877F2',
  'Apply Now':     '#1877F2',
  'Get Quote':     '#1877F2',
  'Get Directions':'#1877F2',
  'Request Time':  '#1877F2',
  'See Menu':      '#1877F2',
  'Send Message':  '#1877F2',
  'Watch More':    '#1877F2',
}

function PageAvatar({ client, fbPageName }: { client: Client | null; fbPageName: string | null }) {
  const name = fbPageName || client?.name || 'Page'

  if (client?.fb_page_logo_url) {
    return (
      <img
        src={client.fb_page_logo_url}
        alt={name}
        className="w-10 h-10 rounded-full object-cover"
      />
    )
  }

  // Generate initials avatar
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()

  // Pick a consistent color based on name
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

export default function FacebookAdPreview({ card, client, previewImageUrl }: Props) {
  const pageName = card.fb_page_name || client?.name || 'Your Page'
  const cta = card.fb_cta || 'Learn More'
  const showCta = cta !== 'No Button'

  return (
    <div className="w-full max-w-[500px] mx-auto font-sans text-[15px] select-none">
      {/* Card container */}
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
          {/* Three dots */}
          <button className="text-[#65676B] p-1 rounded-full hover:bg-gray-100">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zm6 0a2 2 0 11-4 0 2 2 0 014 0zm6 0a2 2 0 11-4 0 2 2 0 014 0z"/>
            </svg>
          </button>
          {/* X */}
          <button className="text-[#65676B] p-1 rounded-full hover:bg-gray-100">
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/>
            </svg>
          </button>
        </div>

        {/* Body text */}
        {card.fb_body_text && (
          <div className="px-3 pb-2.5">
            <p className="text-[#050505] text-sm leading-snug whitespace-pre-wrap">
              {card.fb_body_text}
            </p>
          </div>
        )}

        {/* Ad image with headline + CTA overlaid on bottom */}
        <div className="relative w-full">
          {previewImageUrl ? (
            <img
              src={previewImageUrl}
              alt="Ad creative"
              className="w-full h-auto block"
            />
          ) : (
            <div className="w-full bg-gray-100 flex items-center justify-center text-gray-400 text-sm" style={{ height: 240 }}>
              <div className="text-center">
                <svg className="w-10 h-10 mx-auto mb-2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                </svg>
                <p className="text-xs">Upload an image to see preview</p>
              </div>
            </div>
          )}

          {/* Headline + CTA overlaid on image */}
          {(card.fb_headline || card.fb_link_description || showCta) && (
            <div className="absolute bottom-0 left-0 right-0 flex items-end justify-between gap-3 px-3 py-2.5"
              style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)' }}>
              <div className="min-w-0 flex-1">
                {card.fb_headline && (
                  <p className="font-semibold text-white text-sm leading-tight drop-shadow">
                    {card.fb_headline}
                  </p>
                )}
                {card.fb_link_description && (
                  <p className="text-xs text-gray-200 mt-0.5 drop-shadow">
                    {card.fb_link_description}
                  </p>
                )}
              </div>
              {showCta && (
                <button
                  className="flex-none text-white text-sm font-semibold px-3 py-1.5 rounded whitespace-nowrap shadow"
                  style={{ backgroundColor: '#1877F2' }}
                >
                  {cta}
                </button>
              )}
            </div>
          )}
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
