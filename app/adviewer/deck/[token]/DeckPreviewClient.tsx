'use client'

import { useState } from 'react'
import ParticleBackground from '../../components/ParticleBackground'
import { isVideoUrl, resolveFileUrl } from '@/lib/mediaKind'

interface FileSource {
  id: string
  file_name: string
  file_url: string | null
  position: number
  status: string
}

interface CardSource {
  id: string
  status: string
  card: { id: string; title: string; media_type: string | null } | null
}

interface DeckItem {
  id: string
  source_type: string
  source_id: string
  position: number
  file: FileSource | null
  card: CardSource | null
}

interface Props {
  deck: {
    id: string
    title: string
    token: string
    client_id: string | null
    created_at: string
    items: DeckItem[]
  }
  clientName: string | null
  clientLogo: string | null
}

// resolveUrl / isVideo were private copies here. The isVideo copy had already
// drifted — it omitted 'm4v', so an .m4v creative rendered as a broken image on
// this surface and correctly as video everywhere else. Exactly the drift
// lib/mediaKind.ts exists to stop.
const resolveUrl = resolveFileUrl
const isVideo = isVideoUrl

function initials(name: string) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

export default function DeckPreviewClient({ deck, clientName, clientLogo }: Props) {
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [lightboxVideo, setLightboxVideo] = useState(false)

  function openLightbox(url: string, video: boolean) {
    setLightbox(url)
    setLightboxVideo(video)
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ background: 'radial-gradient(ellipse 120% 90% at 50% 60%, #12101a 0%, #0d0d11 55%, #0a0a0e 100%)' }}>
      <ParticleBackground />

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-white/[0.07]" style={{ background: 'rgba(13,13,17,0.85)', backdropFilter: 'blur(16px)' }}>
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-4">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-none" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
            <span className="text-white font-black text-[10px] tracking-tight">FTE</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white leading-tight truncate">{deck.title}</p>
            <p className="text-[10px] text-white/30 uppercase tracking-widest">Creative Deck · {clientName ?? 'Follow The Eyes'}</p>
          </div>
          {clientLogo && (
            <img src={clientLogo} alt={clientName ?? ''} className="w-8 h-8 rounded-lg object-contain bg-white/10 flex-none" />
          )}
          {!clientLogo && clientName && (
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#7c3aed]/40 to-[#06b6d4]/40 flex items-center justify-center flex-none">
              <span className="text-white text-[10px] font-bold">{initials(clientName)}</span>
            </div>
          )}
        </div>
      </header>

      {/* Grid */}
      <main className="relative z-10 flex-1 max-w-6xl mx-auto w-full px-6 py-8">
        {deck.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <p className="text-sm text-white/30">This deck has no creatives.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {deck.items.map(item => {
              const fileUrl = item.file ? resolveUrl(item.file.file_url) : null
              const label = item.file?.file_name ?? item.card?.card?.title ?? 'Untitled'
              const video = fileUrl ? isVideo(fileUrl) : false

              return (
                <button
                  key={item.id}
                  onClick={() => fileUrl ? openLightbox(fileUrl, video) : undefined}
                  className="group rounded-2xl overflow-hidden border border-white/[0.08] hover:border-white/20 transition-all text-left bg-white/[0.03]"
                >
                  {/* Thumbnail */}
                  <div className="aspect-square bg-white/[0.04] flex items-center justify-center overflow-hidden relative">
                    {fileUrl && !video ? (
                      <>
                        <img src={fileUrl} alt={label} className="w-full h-full object-contain transition-transform duration-300 group-hover:scale-105" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 rounded-full p-2">
                            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
                            </svg>
                          </div>
                        </div>
                      </>
                    ) : fileUrl && video ? (
                      <div className="flex flex-col items-center gap-2 text-white/30">
                        <div className="w-12 h-12 rounded-full bg-white/[0.06] flex items-center justify-center group-hover:bg-white/10 transition-colors">
                          <svg className="w-6 h-6 text-white/50" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                        <span className="text-[10px]">Video</span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-white/20">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#7c3aed]/30 to-[#06b6d4]/30 flex items-center justify-center">
                          <span className="text-xs font-bold text-white/50">{clientName ? initials(clientName) : 'AD'}</span>
                        </div>
                        <span className="text-[10px] text-white/30">Social Ad</span>
                      </div>
                    )}
                  </div>

                  {/* Label */}
                  <div className="px-3 py-2.5">
                    <p className="text-[11px] font-medium text-white truncate">{label}</p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </main>

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(12px)' }}
          onClick={() => setLightbox(null)}
        >
          <button
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <div onClick={e => e.stopPropagation()} className="max-w-4xl max-h-[90vh] overflow-auto">
            {lightboxVideo ? (
              <video src={lightbox} controls autoPlay className="max-w-full max-h-[85vh] rounded-xl" />
            ) : (
              <img src={lightbox} alt="" className="max-w-full max-h-[85vh] rounded-xl object-contain" />
            )}
          </div>
        </div>
      )}

      <footer className="relative z-10 border-t border-white/[0.06] py-4">
        <p className="text-[10px] text-white/20 text-center uppercase tracking-widest">Follow The Eyes · Creative Deck</p>
      </footer>
    </div>
  )
}
