'use client'

import { useState, useMemo, useRef, useEffect, useCallback, Fragment } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { isVideoUrl, resolveFileUrl } from '@/lib/mediaKind'
import type { AdviewerCampaign, AdviewerCampaignFile, CampaignCardData, CampaignCardReview, AdviewerStatus, ReviewRound, IEBlock } from '@/types'
import InstantExperienceMockup from '@/components/InstantExperienceMockup'
import SlideEditModal from './SlideEditModal'
import { copyForCopyTracker, collectLandingPages, resolveCreativeName } from '@/lib/copyTracker'
import { withHttpsScheme } from '@/lib/url'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  campaign: AdviewerCampaign
  // When set, only this campaign card / file ID is visible (single-creative link)
  only?: string
  // True only for logged-in FTE writers — unlocks the inline "Edit" control (copy +
  // graphic replace) on manually-uploaded creatives. Clients viewing via token get false.
  canEdit?: boolean
  // Set when this page was opened with a per-location scope token rather than the
  // campaign token: the campaign prop has already been filtered to that location's
  // creatives. Names the location and switches the copy to make clear that
  // responding here is optional — emailing us back is equally fine.
  scopeLocationName?: string | null
  // The token actually in the URL — a campaign token for corporate, a scope
  // token for a location. Every write posts THIS, never campaign.token, which
  // is blanked on a scoped link precisely so it cannot be read back out of the
  // page payload and replayed against the full campaign.
  reviewToken: string
}

type SectionKey = 'caption' | 'graphic' | 'headline' | 'subheader' | 'button'

// slide_id (carousel only): pin is anchored to that slide — x/y are % of the slide's
// framed card, so the pin travels/dims with the carousel track. Absent = legacy
// card-level pin whose x/y are % of the whole mockup plane.
// block_id (Instant Experience only): pin is anchored to that inner block — x/y are %
// of that block's rendered area. Same one-review-unit model as a carousel.
interface Pin { id: string; x: number; y: number; note: string; slide_id?: string; block_id?: string; by?: 'location' }

function toSectionStatus(s: AdviewerStatus): 'pending' | 'approved' | 'changes' {
  if (s === 'needs_revision') return 'changes'
  if (s === 'approved') return 'approved'
  return 'pending'
}


// ── Helpers ────────────────────────────────────────────────────────────────────

function isCarousel(mt: string | null | undefined) { return mt === 'Carousel Ad' }
function isInstantExperience(mt: string | null | undefined) { return mt === 'Instant Experience' }
function isSocial(mt: string | null | undefined) {
  return ['Social Ad Request', 'Organic Post', 'Reel Request'].includes(mt ?? '')
}
// Per-size review only applies to plain multi-file cards (display sizes). Carousel,
// Instant Experience and social cards are reviewed at card level even with 2+ files
// (e.g. a carousel with a screenshot + a .mov), because their adMockup pins at card level.
function isPerSizeCard(mt: string | null | undefined, fileCount: number) {
  return fileCount > 1 && !isCarousel(mt) && !isInstantExperience(mt) && !isSocial(mt)
}

// ── Body text with See more ────────────────────────────────────────────────────

function BodyText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const LIMIT = 120
  const long = text.length > LIMIT
  return (
    <p className="px-4 pb-3 text-[13px] text-gray-800 leading-relaxed"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
      {long && !expanded
        ? <>{text.slice(0, LIMIT)}… <button onClick={() => setExpanded(true)} className="text-gray-500 font-semibold hover:underline">See more</button></>
        : text}
    </p>
  )
}

// ── Video detection + player ───────────────────────────────────────────────────

function isZipUrl(url: string) {
  return url.split('?')[0].split('.').pop()?.toLowerCase() === 'zip'
}

// ── HTML5 Ad Player ────────────────────────────────────────────────────────────
// Downloads a ZIP, extracts it client-side with JSZip, and renders index.html
// in a sandboxed iframe using blob URLs for all assets.

function Html5AdPlayer({ src, replayKey, adWidth, adHeight }: { src: string; replayKey: number; adWidth?: number | null; adHeight?: number | null }) {
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [iframeHeight, setIframeHeight] = useState<number | null>(null)
  const blobUrlsRef = useRef<string[]>([])

  const load = useCallback(async () => {
    blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u))
    blobUrlsRef.current = []
    setIframeSrc(null)
    setError(null)
    setLoading(true)
    setIframeHeight(null)

    try {
      const JSZip = (await import('jszip')).default
      const res = await fetch(src)
      if (!res.ok) throw new Error(`Failed to fetch ZIP (${res.status})`)
      const arrayBuffer = await res.arrayBuffer()
      const zip = await JSZip.loadAsync(arrayBuffer)

      // Phase 1: build blob map with explicit MIME types so browsers render images correctly.
      // JSZip defaults everything to text/plain which breaks <img> tags.
      const MIME: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        avif: 'image/avif', ico: 'image/x-icon',
        mp4: 'video/mp4', webm: 'video/webm',
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
        css: 'text/css', js: 'text/javascript', html: 'text/html',
        json: 'application/json',
      }
      const blobMap: Record<string, string> = {}
      await Promise.all(
        Object.entries(zip.files).map(async ([name, file]) => {
          if (file.dir) return
          const ext = name.split('.').pop()?.toLowerCase() ?? ''
          const mimeType = MIME[ext] ?? 'application/octet-stream'
          const arrayBuf = await file.async('arraybuffer')
          const blob = new Blob([arrayBuf], { type: mimeType })
          const url = URL.createObjectURL(blob)
          blobUrlsRef.current.push(url)
          const key = name.includes('/') ? name.split('/').slice(1).join('/') : name
          blobMap[key] = url
          blobMap[name] = url
        })
      )

      // Phase 2: patch url() inside CSS files so fonts/images referenced from stylesheets load correctly
      await Promise.all(
        Object.entries(zip.files)
          .filter(([name, file]) => !file.dir && /\.css$/i.test(name))
          .map(async ([name, file]) => {
            const normalizedKey = name.includes('/') ? name.split('/').slice(1).join('/') : name
            const cssText = await file.async('string')
            const patchedCss = cssText.replace(
              /url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi,
              (match, path: string) => {
                const clean = path.replace(/^\.\//, '').split('?')[0].split('#')[0]
                const blobUrl = blobMap[clean] ?? blobMap[path]
                return blobUrl ? `url("${blobUrl}")` : match
              }
            )
            const oldUrl = blobMap[normalizedKey]
            if (oldUrl) {
              URL.revokeObjectURL(oldUrl)
              blobUrlsRef.current = blobUrlsRef.current.filter(u => u !== oldUrl)
            }
            const patchedBlob = new Blob([patchedCss], { type: 'text/css' })
            const patchedUrl = URL.createObjectURL(patchedBlob)
            blobUrlsRef.current.push(patchedUrl)
            blobMap[normalizedKey] = patchedUrl
            blobMap[name] = patchedUrl
          })
      )

      // Phase 3: patch src/href attributes and inline url() in the HTML
      const indexEntry = Object.keys(zip.files).find(
        n => n.split('/').pop()?.toLowerCase() === 'index.html'
      )
      if (!indexEntry) throw new Error('No index.html found in ZIP')

      const htmlText = await zip.files[indexEntry].async('string')
      const patched = htmlText
        .replace(
          /(src|href)\s*=\s*["']([^"'#?]+)["']/gi,
          (match, attr: string, path: string) => {
            const normalizedPath = path.replace(/^\.\//, '')
            const blobUrl = blobMap[normalizedPath] ?? blobMap[path]
            return blobUrl ? `${attr}="${blobUrl}"` : match
          }
        )
        .replace(
          /url\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi,
          (match, path: string) => {
            const clean = path.replace(/^\.\//, '').split('?')[0].split('#')[0]
            const blobUrl = blobMap[clean] ?? blobMap[path]
            return blobUrl ? `url("${blobUrl}")` : match
          }
        )

      // Phase 4: inject a runtime interceptor so React/JS apps that set img.src dynamically
      // still resolve to blob URLs instead of broken relative paths.
      const blobMapJson = JSON.stringify(blobMap)
      const interceptorScript = `<script>
(function(){
  var BM=${blobMapJson};
  function resolve(v){
    if(!v||v.startsWith('blob:')||v.startsWith('http')||v.startsWith('data:')) return v;
    var c=v.replace(/^\\.\\//,'').split('?')[0].split('#')[0];
    return BM[c]||BM[v]||v;
  }
  var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  if(d&&d.set){
    Object.defineProperty(HTMLImageElement.prototype,'src',{
      set:function(v){d.set.call(this,resolve(v));},
      get:d.get,configurable:true
    });
  }
})();
</script>`

      const patchedWithInterceptor = patched.includes('<head>')
        ? patched.replace('<head>', '<head>' + interceptorScript)
        : patched.replace('<body>', '<body>' + interceptorScript)

      const htmlBlob = new Blob([patchedWithInterceptor], { type: 'text/html' })
      const htmlBlobUrl = URL.createObjectURL(htmlBlob)
      blobUrlsRef.current.push(htmlBlobUrl)
      setIframeSrc(htmlBlobUrl)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load HTML5 ad')
    } finally {
      setLoading(false)
    }
  }, [src])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    return () => { blobUrlsRef.current.forEach(u => URL.revokeObjectURL(u)) }
  }, [load, replayKey])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[250px] gap-3">
        <svg className="w-6 h-6 text-[#7c3aed] animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
        <p className="text-[11px] text-gray-400">Loading HTML5 ad…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[250px] gap-2 px-6 text-center">
        <svg className="w-8 h-8 text-red-400/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
        <p className="text-[12px] text-red-400">{error}</p>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', width: adWidth ? `${adWidth}px` : '100%', lineHeight: 0 }}>
      <iframe
        src={iframeSrc ?? ''}
        sandbox="allow-scripts allow-same-origin"
        className="block border-0"
        style={{
          width: adWidth ? `${adWidth}px` : '100%',
          minHeight: '250px',
          height: adHeight ? `${adHeight}px` : (iframeHeight ? `${iframeHeight}px` : '250px'),
        }}
        onLoad={(e) => {
          try {
            const doc = e.currentTarget.contentDocument
            const h = doc?.documentElement?.scrollHeight ?? doc?.body?.scrollHeight
            if (h && h > 50) setIframeHeight(h)
          } catch { /* cross-origin — height stays at default */ }
        }}
        title="HTML5 Ad Preview"
      />
      {/* Transparent overlay so clicks reach the PinOverlay instead of disappearing into the iframe */}
      <div style={{ position: 'absolute', inset: 0 }} />
    </div>
  )
}

function ReplayButton({ onClick, label, size = 'md' }: { onClick: () => void; label: string; size?: 'sm' | 'md' }) {
  const isSm = size === 'sm'
  return (
    <button
      // stopPropagation: in the HTML5 branch this button sits inside PinOverlay,
      // so without it a Restart Animation click bubbles up and drops a stray pin.
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={`flex items-center rounded-full font-bold text-white transition-opacity hover:opacity-90 ${isSm ? 'gap-1.5 px-4 py-1.5 text-[11px]' : 'gap-2 px-5 py-2 text-[12px] active:scale-95'}`}
      style={{
        background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)',
        boxShadow: isSm ? '0 4px 12px rgba(124,58,237,0.35)' : '0 4px 16px rgba(124,58,237,0.4)',
      }}
    >
      <svg className={isSm ? 'w-3 h-3' : 'w-3.5 h-3.5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
      </svg>
      {label}
    </button>
  )
}

function VideoPlayer({ src, replayKey = 0, showReplayButton = true }: { src: string; replayKey?: number; showReplayButton?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [paused, setPaused] = useState(false)
  const [hovering, setHovering] = useState(false)

  function toggle() {
    const v = videoRef.current
    if (!v) return
    if (v.paused) { void v.play() } else { v.pause() }
  }

  const restart = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = 0
    void v.play()
  }, [])

  // Restart when an external replay control (e.g. the "Replay Animation" button
  // in the main review view) bumps replayKey. Guarded so it doesn't fire on mount.
  useEffect(() => {
    if (replayKey > 0) restart()
  }, [replayKey, restart])

  return (
    <div
      className="relative cursor-pointer select-none"
      onClick={toggle}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <video
        ref={videoRef}
        src={src}
        className="w-full block"
        preload="auto"
        autoPlay
        muted
        loop
        playsInline
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={() => {
          const v = videoRef.current
          if (v) { v.currentTime = 0; void v.play() }
        }}
      />
      {/* Subtle hover control — only appears on hover or when manually paused */}
      <div className={`absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${hovering || paused ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="w-12 h-12 rounded-full flex items-center justify-center shadow-xl"
          style={{ background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(4px)' }}>
          {paused
            ? <svg className="w-5 h-5 text-gray-900 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            : <svg className="w-5 h-5 text-gray-900" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
          }
        </div>
      </div>
      {/* Compact restart control — for surfaces (social/carousel/mockup) that don't
          render the standalone "Replay Animation" button. Suppressed in the main
          review view, which shows that button and drives replay via replayKey. */}
      {showReplayButton && (
        <div className="absolute bottom-2 right-2 z-10">
          <ReplayButton onClick={restart} label="Replay" size="sm" />
        </div>
      )}
    </div>
  )
}

// ── Browser frame ──────────────────────────────────────────────────────────────

function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden shadow-2xl" style={{ width: '960px' }}>
      {/* Browser chrome */}
      <div className="bg-[#dde1e7] px-3 py-2.5 flex items-center gap-3">
        <div className="flex gap-1.5 flex-none">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        {/* Tabs */}
        <div className="flex items-end gap-0.5 flex-1 min-w-0">
          <div className="bg-white rounded-t-md px-4 py-1 flex items-center gap-2 max-w-[220px]">
            <svg className="w-3 h-3 text-[#1877f2] flex-none" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
            <span className="text-[11px] text-gray-600 truncate">Facebook</span>
          </div>
        </div>
        {/* URL bar */}
        <div className="flex-none w-48 bg-white rounded-md px-3 py-1 flex items-center gap-1.5">
          <svg className="w-3 h-3 text-gray-400 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
          <span className="text-[11px] text-gray-400">facebook.com</span>
        </div>
      </div>
      {/* Facebook desktop nav */}
      <div className="bg-white border-b border-gray-200 px-4 flex items-center justify-between" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <div className="flex items-center gap-3 py-2">
          <span className="text-[22px] font-black" style={{ color: '#1877f2', fontFamily: 'Georgia, serif' }}>facebook</span>
          <div className="bg-[#f0f2f5] rounded-full px-3 py-1.5 flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-gray-400" fill="currentColor" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            <span className="text-[12px] text-gray-400">Search</span>
          </div>
        </div>
        {/* Nav icons */}
        <div className="flex items-center gap-1 py-1">
          {[
            'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
            'M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z',
            'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z',
          ].map((d, i) => (
            <div key={i} className="w-9 h-9 rounded-full bg-[#e4e6eb] flex items-center justify-center cursor-pointer hover:bg-[#d8dadf]">
              <svg className="w-4 h-4 text-gray-700" fill="currentColor" viewBox="0 0 24 24"><path d={d} /></svg>
            </div>
          ))}
        </div>
      </div>
      {/* Feed — centered column */}
      <div className="bg-[#f0f2f5] flex gap-4 p-4" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        {/* Left nav stub */}
        <div className="w-[240px] flex-none space-y-1 pt-1">
          {['Home', 'Friends', 'Watch', 'Marketplace'].map(item => (
            <div key={item} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-black/5 cursor-pointer">
              <div className="w-7 h-7 rounded-full bg-gray-200 flex-none" />
              <span className="text-[13px] font-medium text-gray-700">{item}</span>
            </div>
          ))}
        </div>
        {/* Center feed */}
        <div className="flex-1 min-w-0">
          {children}
        </div>
        {/* Right stub */}
        <div className="w-[220px] flex-none space-y-2 pt-1">
          <p className="text-[13px] font-semibold text-gray-500 px-2">Sponsored</p>
          {[1, 2].map(i => (
            <div key={i} className="flex gap-2 px-2 py-1">
              <div className="w-14 h-14 rounded-lg bg-gray-200 flex-none" />
              <div className="space-y-1.5 pt-1">
                <div className="h-2.5 bg-gray-200 rounded w-20" />
                <div className="h-2 bg-gray-100 rounded w-16" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Phone frame ────────────────────────────────────────────────────────────────

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex-none" style={{ width: '375px' }}>
      {/* Side buttons */}
      <div className="absolute left-[-3px] top-[96px] w-[3px] h-8 rounded-l-sm" style={{ background: '#2a2a2a' }} />
      <div className="absolute left-[-3px] top-[140px] w-[3px] h-12 rounded-l-sm" style={{ background: '#2a2a2a' }} />
      <div className="absolute left-[-3px] top-[164px] w-[3px] h-12 rounded-l-sm" style={{ background: '#2a2a2a' }} />
      <div className="absolute right-[-3px] top-[140px] w-[3px] h-16 rounded-r-sm" style={{ background: '#2a2a2a' }} />
      {/* Phone shell */}
      <div className="rounded-[44px] overflow-hidden"
        style={{ background: '#1c1c1e', padding: '10px', boxShadow: '0 0 0 1px #3a3a3c, 0 40px 100px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(255,255,255,0.06)' }}>
        {/* Screen */}
        <div className="rounded-[36px] overflow-hidden bg-white flex flex-col" style={{ height: '720px' }}>
          {/* iOS status bar */}
          <div className="flex-none flex items-center justify-between px-6 pt-3 pb-1 bg-white relative">
            <span className="text-[13px] font-semibold text-gray-900">9:41</span>
            {/* Dynamic island */}
            <div className="absolute top-2.5 left-1/2 -translate-x-1/2 w-[110px] h-[30px] bg-black rounded-full" />
            <div className="flex items-center gap-1.5">
              {/* Signal bars */}
              <svg width="17" height="12" viewBox="0 0 17 12" fill="none">
                <rect x="0" y="7" width="3" height="5" rx="1" fill="#1c1c1e" />
                <rect x="4.5" y="5" width="3" height="7" rx="1" fill="#1c1c1e" />
                <rect x="9" y="3" width="3" height="9" rx="1" fill="#1c1c1e" />
                <rect x="13.5" y="0" width="3" height="12" rx="1" fill="#1c1c1e" />
              </svg>
              {/* Wifi */}
              <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
                <path d="M8 9.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z" fill="#1c1c1e" />
                <path d="M3.5 6.5a6.5 6.5 0 019 0" stroke="#1c1c1e" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M1 4a10 10 0 0114 0" stroke="#1c1c1e" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              {/* Battery */}
              <div className="flex items-center gap-0.5">
                <div className="w-[22px] h-[11px] rounded-[3px] border border-gray-800 p-[1.5px]">
                  <div className="w-full h-full bg-gray-900 rounded-[1.5px]" />
                </div>
                <div className="w-[2px] h-[5px] bg-gray-800 rounded-r-sm" />
              </div>
            </div>
          </div>

          {/* Facebook app header */}
          <div className="flex-none bg-white border-b border-gray-200">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[22px] font-black" style={{ color: '#1877f2', fontFamily: 'Georgia, serif' }}>facebook</span>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-[#e4e6eb] flex items-center justify-center">
                  <svg className="w-4 h-4 text-gray-800" fill="currentColor" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" /></svg>
                </div>
                <div className="w-8 h-8 rounded-full bg-[#e4e6eb] flex items-center justify-center">
                  <svg className="w-4 h-4 text-gray-800" fill="currentColor" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" /></svg>
                </div>
              </div>
            </div>
            {/* Feed tabs */}
            <div className="flex border-t border-gray-100">
              {[
                { icon: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z', active: true },
                { icon: 'M18 3v2h-2V3H8v2H6V3H4v18h16V3h-2zM11 15H6v-2h5v2zm7 0h-5v-2h5v2zm0-4H6V9h12v2z', active: false },
                { icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z', active: false },
                { icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z', active: false },
              ].map(({ icon, active }, i) => (
                <button key={i} className={`flex-1 py-2 flex items-center justify-center border-b-2 ${active ? 'border-[#1877f2]' : 'border-transparent'}`}>
                  <svg className={`w-5 h-5 ${active ? 'text-[#1877f2]' : 'text-gray-400'}`} fill="currentColor" viewBox="0 0 24 24">
                    <path d={icon} />
                  </svg>
                </button>
              ))}
            </div>
          </div>

          {/* Feed area — scrollable */}
          <div className="flex-1 overflow-y-auto bg-[#f0f2f5]">
            {/* Divider */}
            <div className="h-2 bg-[#f0f2f5]" />
            {/* Ad card */}
            {children}
            {/* Placeholder feed item below ad */}
            <div className="mt-2 bg-white px-3 py-3 flex gap-2 items-start">
              <div className="w-8 h-8 rounded-full bg-gray-200 flex-none" />
              <div className="flex-1 space-y-1.5">
                <div className="h-2.5 bg-gray-200 rounded w-3/4" />
                <div className="h-2 bg-gray-100 rounded w-1/2" />
              </div>
            </div>
          </div>

          {/* iOS home bar */}
          <div className="flex-none h-7 bg-white flex items-center justify-center">
            <div className="w-28 h-1 bg-gray-900/25 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Facebook mockup ────────────────────────────────────────────────────────────

function FacebookMockup({ fileUrl, pageName, clientName, bodyText, headline, subheadline, description, cta, logoUrl, landingPageUrl, mediaType, hoveredSection, viewMode, showReplay = true }: {
  fileUrl: string; pageName: string | null; clientName: string | null; bodyText: string | null;
  headline: string | null; subheadline: string | null; description: string | null; cta: string | null; logoUrl: string | null;
  landingPageUrl: string | null; mediaType: string | null | undefined; hoveredSection: SectionKey | null; viewMode: 'mobile' | 'desktop'; showReplay?: boolean
}) {
  const displayName = pageName || clientName || 'Page Name'
  const initials = displayName.slice(0, 2).toUpperCase()

  const hl = (key: SectionKey) => hoveredSection === key

  const adCard = (
    <div className="bg-white"
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        {logoUrl
          ? <img src={logoUrl} alt="" className="w-9 h-9 rounded-full object-cover flex-none" />
          : <div className="w-9 h-9 rounded-full bg-[#0075A9] flex items-center justify-center text-white text-sm font-bold flex-none">{initials}</div>}
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-gray-900 leading-tight">{displayName}</p>
          <p className="text-[11px] text-gray-500 flex items-center gap-1">Sponsored · <span>Ad ·</span>
            <svg className="w-3 h-3 text-gray-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-4H7l5-8v4h4l-5 8z" /></svg>
          </p>
        </div>
        <div className="flex gap-2 text-gray-400">
          <span className="text-lg cursor-pointer">···</span>
          <span className="text-lg cursor-pointer">✕</span>
        </div>
      </div>
      {/* Caption */}
      {bodyText && (
        <div className={`transition-all duration-150 ${hl('caption') ? 'bg-violet-50 outline outline-2 outline-violet-400' : ''}`}>
          <BodyText text={bodyText} />
        </div>
      )}
      {/* Graphic + link bar share the carousel slide's framed-card treatment
          (rounded / bordered / shadowed inside a padded band) so a single social
          reads as "a carousel with one card". Copy fields are unchanged. */}
      <div className="px-2 py-2 bg-white">
        <div className="rounded-xl overflow-hidden border border-gray-200 bg-white shadow-sm">
          {/* Graphic */}
          <div className={`bg-gray-100 transition-all duration-150 ${hl('graphic') ? 'outline outline-2 outline-violet-400' : ''}`}>
            {/* 1:1 square for all social ads on this project (Facebook's recommended ratio). */}
            {fileUrl
              ? (isVideoUrl(fileUrl) || mediaType === 'Reel Request' || mediaType === 'Video Request'
                  ? <div className="w-full aspect-square overflow-hidden"><VideoPlayer src={fileUrl} showReplayButton={showReplay} /></div>
                  : <img src={fileUrl} alt="Ad creative" className="w-full aspect-square object-cover block" />)
              : <div className="w-full aspect-square flex items-center justify-center text-gray-400 text-sm">No creative uploaded</div>}
          </div>
          {(headline || subheadline || description || cta) && (
            <div className="px-3 py-2 bg-[#f0f2f5] border-t border-gray-200 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                {/* Domain URL intentionally not shown: these are regular social posts,
                    which by agreement don't display the website URL. The landing page
                    is still used as the CTA button href below. */}
                {/* Headline */}
                {headline && (
                  <p className={`text-[13px] font-semibold text-gray-900 line-clamp-2 transition-all duration-150 rounded px-1 -mx-1 ${hl('headline') ? 'bg-violet-200' : ''}`}>
                    {headline}
                  </p>
                )}
                {/* Sub Headline */}
                {subheadline && (
                  <p className={`text-[12px] text-gray-700 line-clamp-2 transition-all duration-150 rounded px-1 -mx-1 ${hl('subheader') ? 'bg-violet-200' : ''}`}>
                    {subheadline}
                  </p>
                )}
                {/* Link Description */}
                {description && (
                  <p className="text-[11px] text-gray-500 truncate">
                    {description}
                  </p>
                )}
              </div>
              {/* Button URL */}
              {cta && cta !== 'No Button' && (
                <a href={withHttpsScheme(landingPageUrl) || '#'} target="_blank" rel="noopener noreferrer"
                  className={`ml-3 flex-none text-[13px] font-semibold bg-[#e4e6eb] text-gray-800 rounded px-3.5 py-1.5 hover:bg-[#d8dadf] transition-all whitespace-nowrap ${hl('button') ? 'outline outline-2 outline-violet-400 bg-violet-100' : ''}`}>
                  {cta}
                </a>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex border-t border-gray-200">
        {(['👍 Like', '💬 Comment', '↗ Share'] as const).map(a => (
          <button key={a} className="flex-1 py-2 text-[12px] font-semibold text-gray-600 hover:bg-gray-50 transition-colors">{a}</button>
        ))}
      </div>
    </div>
  )

  return viewMode === 'desktop'
    ? <BrowserFrame>{adCard}</BrowserFrame>
    : <PhoneFrame>{adCard}</PhoneFrame>
}

// ── Carousel mockup ────────────────────────────────────────────────────────────

type Slide = NonNullable<NonNullable<CampaignCardData['card']>['carousel_slides']>[number]

interface CarouselSlidePinProps {
  // Slide-anchored pins keyed by carousel_slides.id (already filtered to unresolved).
  slidePins: Record<string, Pin[]>
  onAddSlidePin: (slideId: string, x: number, y: number, note: string) => void
  onUpdateSlidePin: (pinId: string, note: string) => void
  onRemoveSlidePin: (pinId: string) => void
  readOnly: boolean
  pinningEnabled: boolean
  pinNumber: (pinId: string) => number
  nextPinNumber: number
}

function CarouselMockup({ slides, pageName, clientName, bodyText, cta, logoUrl, hoveredSection, viewMode, pinProps, canEdit, onEditSlide }: {
  slides: Slide[]; pageName: string | null; clientName: string | null;
  bodyText: string | null; cta: string | null; logoUrl: string | null; hoveredSection: SectionKey | null;
  viewMode: 'mobile' | 'desktop'; pinProps?: CarouselSlidePinProps
  canEdit?: boolean; onEditSlide?: (slide: Slide) => void
}) {
  const [idx, setIdx] = useState(0)
  const [anchored, setAnchored] = useState(false)
  // Facebook carousel cards are strictly 1:1 (per Meta's ad spec), so every slide renders
  // as a square — this also keeps all cards aligned.
  // Measured pixel height of a slide's image band, so the arrows stay centered on the
  // image (not the whole card, which also includes the footer).
  const imgBoxRef = useRef<HTMLDivElement>(null)
  const [imgH, setImgH] = useState(0)
  useEffect(() => {
    const el = imgBoxRef.current
    if (!el) return
    const update = () => setImgH(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const sorted = [...slides].sort((a, b) => a.position - b.position)

  // Deep-link: /adviewer/c/{token}#slide-{position} jumps to + briefly highlights that slide.
  // State updates are deferred into rAF so they don't fire synchronously within the effect.
  useEffect(() => {
    const m = /^#slide-(\d+)$/.exec(window.location.hash)
    if (!m) return
    const target = sorted.findIndex((s) => s.position === Number(m[1]))
    if (target < 0) return
    const raf = requestAnimationFrame(() => {
      setIdx(target)
      setAnchored(true)
    })
    const t = setTimeout(() => setAnchored(false), 2000)
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clamp active slide if the deck shrinks (e.g. deep-link target no longer present).
  const safeIdx = Math.min(idx, sorted.length - 1)
  const ctaLabel = cta && cta !== 'No Button' ? cta : 'Learn More'
  const displayName = pageName || clientName || 'Page Name'
  const initials = displayName.slice(0, 2).toUpperCase()

  const hl = (key: SectionKey) => hoveredSection === key

  if (sorted.length === 0) return null

  const adCard = (
    <div className={`bg-white transition-shadow duration-300 ${anchored ? 'ring-4 ring-violet-400' : ''}`}
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' }}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        {logoUrl
          ? <img src={logoUrl} alt="" className="w-10 h-10 rounded-full object-cover flex-none" />
          : <div className="w-10 h-10 rounded-full bg-[#0075A9] flex items-center justify-center text-white text-sm font-bold flex-none">{initials}</div>}
        <div>
          <p className="text-[13px] font-semibold text-gray-900">{displayName}</p>
          <p className="text-[11px] text-gray-500">Sponsored · Ad ·</p>
        </div>
      </div>
      {/* Caption */}
      {bodyText && (
        <div className={`transition-all duration-150 ${hl('caption') ? 'bg-violet-50 outline outline-2 outline-violet-400' : ''}`}>
          <BodyText text={bodyText} />
        </div>
      )}
      {/* Carousel — center-peek: the active card is centered and in focus, with the
          previous card peeking on the left and the next on the right. Each slide is its
          own framed card (rounded image + its own link footer + CTA) that slides as a unit,
          exactly like a real Facebook carousel. */}
      {/* overflow-x-clip (not overflow-hidden): the track must clip horizontally, but
          slide-pin popovers need to extend below the band without being cut off. */}
      <div className={`relative px-2 py-2 bg-white overflow-x-clip transition-all duration-150 ${hl('graphic') ? 'outline outline-2 outline-violet-400' : ''}`}>
        {(() => {
          const single = sorted.length === 1
          const slideW = single ? 100 : 82 // % of band width per card; leaves a peek each side
          // translateX % is relative to the track's own width, which stays at 100% of the
          // band (the oversized flex children just overflow) — so shift by container %.
          // Centers the active card: its center sits at (safeIdx + 0.5) * slideW from the
          // track's left; move that to the band's 50%.
          const trackShift = single ? 0 : 50 - (safeIdx + 0.5) * slideW
          return (
            <div className="flex items-start" style={{ transform: `translateX(${trackShift}%)`, transition: 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)' }}>
              {sorted.map((s, i) => (
                <div key={s.id} className="relative flex-none px-1" style={{ width: `${slideW}%` }}>
                  <div className={`relative rounded-xl overflow-hidden border border-gray-200 bg-white shadow-sm transition-opacity duration-300 ${i === safeIdx ? 'opacity-100' : 'opacity-45'}`}>
                    <button
                      type="button"
                      // Clicking a peeking neighbor navigates (and must NOT bubble to the
                      // PinOverlay, or it drops a phantom pin). Clicking the ACTIVE slide does
                      // nothing here and is allowed to bubble so the client can place a pin.
                      onClick={(e) => { if (i !== safeIdx) { e.stopPropagation(); setIdx(i) } }}
                      className={`block w-full ${i === safeIdx ? '' : 'cursor-pointer'}`}
                    >
                      {s.image_url && (isVideoUrl(resolveFileUrl(s.image_url))
                        ? <div ref={i === 0 ? imgBoxRef : undefined} className="w-full aspect-square overflow-hidden"><VideoPlayer src={resolveFileUrl(s.image_url)} /></div>
                        : <div ref={i === 0 ? imgBoxRef : undefined} className="w-full aspect-square overflow-hidden">
                            <img
                              src={resolveFileUrl(s.image_url)}
                              alt={s.headline ?? ''}
                              className="w-full h-full object-cover block"
                            />
                          </div>
                      )}
                      {/* Text for Graphic is baked into the creative by the designer, so it
                          is NOT overlaid here — the image already carries that copy. */}
                    </button>
                    {/* Open this graphic full-size in a new tab (review aid). Sibling of the
                        jump button so we don't nest interactive elements. */}
                    {i === safeIdx && s.image_url && !isVideoUrl(resolveFileUrl(s.image_url)) && (
                      <a
                        href={resolveFileUrl(s.image_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open graphic in a new tab"
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-2 right-2 z-20 w-8 h-8 rounded-full bg-black/55 hover:bg-black/75 text-white flex items-center justify-center backdrop-blur-sm transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5m0 0v5m0-5L10 14M9 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-3" /></svg>
                      </a>
                    )}
                    {/* Staff-only per-slide edit (gap #2) — copy + graphic replace. */}
                    {i === safeIdx && canEdit && onEditSlide && (
                      <button
                        type="button"
                        title="Edit this slide"
                        onClick={(e) => { e.stopPropagation(); onEditSlide(s) }}
                        className="absolute top-2 left-2 z-20 h-8 px-2.5 rounded-full bg-black/55 hover:bg-black/75 text-white text-[11px] font-semibold flex items-center gap-1 backdrop-blur-sm transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        Edit
                      </button>
                    )}
                    {/* Per-card link footer — real FB carousel cards show headline +
                        description + CTA (no display-link line). */}
                    {(s.headline || s.subheadline) && (
                      <div className="px-3 py-2 bg-[#f0f2f5] border-t border-gray-200 flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          {s.headline && (
                            <p className={`text-[13px] font-semibold text-gray-900 truncate transition-all duration-150 rounded px-1 -mx-1 ${i === safeIdx && hl('headline') ? 'bg-violet-200' : ''}`}>{s.headline}</p>
                          )}
                          {s.subheadline && (
                            <p className={`text-[12px] text-gray-700 truncate transition-all duration-150 rounded px-1 -mx-1 ${i === safeIdx && hl('subheader') ? 'bg-violet-200' : ''}`}>{s.subheadline}</p>
                          )}
                        </div>
                        <a href={withHttpsScheme(s.landing_page_url) || '#'} target="_blank" rel="noopener noreferrer"
                          className={`flex-none text-[12px] font-semibold bg-[#e4e6eb] text-gray-800 rounded px-3 py-1.5 hover:bg-[#d8dadf] whitespace-nowrap transition-all duration-150 ${i === safeIdx && hl('button') ? 'outline outline-2 outline-violet-400 bg-violet-100' : ''}`}>
                          {ctaLabel}
                        </a>
                      </div>
                    )}
                  </div>
                  {/* Slide-anchored pins — sibling of the framed card (which is
                      overflow-hidden), overlaid to its bounds via left-1/right-1
                      matching the wrapper's px-1. Travels with the track. */}
                  {pinProps && (
                    <SlidePinLayer
                      pins={pinProps.slidePins[s.id] ?? []}
                      active={i === safeIdx}
                      onAddPin={(x, y, note) => pinProps.onAddSlidePin(s.id, x, y, note)}
                      onUpdatePin={pinProps.onUpdateSlidePin}
                      onRemovePin={pinProps.onRemoveSlidePin}
                      readOnly={pinProps.readOnly}
                      pinningEnabled={pinProps.pinningEnabled}
                      pinNumber={pinProps.pinNumber}
                      nextPinNumber={pinProps.nextPinNumber}
                    />
                  )}
                </div>
              ))}
            </div>
          )
        })()}
        {/* Slide arrows — siblings of the track, centered on the image band (imgH). */}
        {sorted.length > 1 && (
          <>
            <button onClick={(e) => { e.stopPropagation(); setIdx(i => Math.max(0, Math.min(i, sorted.length - 1) - 1)) }} disabled={safeIdx === 0}
              className="absolute left-3 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow flex items-center justify-center disabled:opacity-30 z-10" style={{ top: imgH ? imgH / 2 + 8 : '40%' }}>
              <svg className="w-4 h-4 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button onClick={(e) => { e.stopPropagation(); setIdx(i => Math.min(sorted.length - 1, Math.min(i, sorted.length - 1) + 1)) }} disabled={safeIdx === sorted.length - 1}
              className="absolute right-3 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow flex items-center justify-center disabled:opacity-30 z-10" style={{ top: imgH ? imgH / 2 + 8 : '40%' }}>
              <svg className="w-4 h-4 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </>
        )}
      </div>
      <div className="flex border-t border-gray-200">
        {(['👍 Like', '💬 Comment', '↗ Share'] as const).map(a => (
          <button key={a} className="flex-1 py-2 text-[12px] font-semibold text-gray-600 hover:bg-gray-50 transition-colors">{a}</button>
        ))}
      </div>
    </div>
  )

  return viewMode === 'desktop'
    ? <BrowserFrame>{adCard}</BrowserFrame>
    : <PhoneFrame>{adCard}</PhoneFrame>
}

// ── Display mockup ─────────────────────────────────────────────────────────────

function DisplayMockup({ fileUrl, title, hoveredSection, externalReplayKey = 0 }: { fileUrl: string; title: string; hoveredSection: SectionKey | null; externalReplayKey?: number }) {
  const isHighlighted = hoveredSection === 'graphic'
  const isHtml5 = isZipUrl(fileUrl)
  const [replayKey, setReplayKey] = useState(0)
  const isVideo = isVideoUrl(fileUrl)

  // HTML5 ads: full-width, no browser chrome; parse dimensions from filename for exact iframe sizing
  if (isHtml5) {
    const urlFileName = fileUrl.split('/').pop()?.split('?')[0] ?? ''
    const dimMatch = urlFileName.match(/(\d+)[x×](\d+)/i) ?? title.match(/(\d+)[x×](\d+)/i)
    const adWidth = dimMatch ? parseInt(dimMatch[1]) : null
    const adHeight = dimMatch ? parseInt(dimMatch[2]) : null
    return (
      <div className="flex flex-col items-center">
        <Html5AdPlayer src={fileUrl} replayKey={replayKey + externalReplayKey} adWidth={adWidth} adHeight={adHeight} />
        <div className="pt-3">
          <ReplayButton onClick={() => setReplayKey(k => k + 1)} label="Restart Animation" size="sm" />
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex items-center justify-center w-full">
      {/* Subtle color-bleed backdrop — the creative's own colors, softly washing behind it */}
      {fileUrl && !isVideo && (
        <div
          className="absolute pointer-events-none"
          style={{
            inset: '-80px',
            backgroundImage: `url(${fileUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: 'blur(110px) saturate(1.3)',
            opacity: 0.18,
            transform: 'scale(1.3)',
            zIndex: 0,
          }}
        />
      )}
      {/* Ambient glow */}
      <div className="absolute pointer-events-none" style={{ inset: '-60px', background: 'radial-gradient(ellipse at 50% 50%, rgba(124,58,237,0.12) 0%, rgba(6,182,212,0.05) 45%, transparent 72%)', filter: 'blur(30px)', zIndex: 0 }} />

      {/* The creative, floating with depth + reflection */}
      <div className="relative z-[1]">
        {fileUrl
          ? (isVideo
              ? (
                <div
                  className={`rounded-xl overflow-hidden ring-1 ring-white/10 ${isHighlighted ? 'outline outline-2 outline-violet-400' : ''}`}
                  style={{ boxShadow: '0 40px 90px -20px rgba(0,0,0,0.75), 0 12px 32px rgba(0,0,0,0.45)' }}
                >
                  <VideoPlayer src={fileUrl} />
                </div>
              )
              : (
                <div className="relative w-fit">
                  <img
                    src={fileUrl}
                    alt={title}
                    className={`relative z-[1] block h-auto w-auto rounded-xl ring-1 ring-white/10 ${isHighlighted ? 'outline outline-2 outline-violet-400' : ''}`}
                    style={{ maxWidth: 'min(720px, calc(100vw - 2rem))', boxShadow: '0 44px 90px -18px rgba(0,0,0,0.80), 0 16px 36px rgba(0,0,0,0.5)' }}
                  />
                  {/* Reflection — absolute so it hangs below without shifting the banner off-center */}
                  <img
                    src={fileUrl}
                    alt=""
                    aria-hidden="true"
                    className="absolute left-0 top-full w-full h-auto rounded-xl pointer-events-none"
                    style={{
                      transform: 'scaleY(-1)',
                      transformOrigin: 'top',
                      WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.4), transparent 45%)',
                      maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.4), transparent 45%)',
                      opacity: 0.55,
                    }}
                  />
                </div>
              ))
          : <div className="w-[400px] max-w-full h-48 flex items-center justify-center text-gray-400 text-sm rounded-xl bg-white/[0.04] ring-1 ring-white/10">No file</div>}
      </div>
    </div>
  )
}

// ── Shared pin overlay — wraps any mockup ──────────────────────────────────────

interface PinOverlayProps {
  children: React.ReactNode
  pins: Pin[]
  onAddPin: (x: number, y: number, note: string) => void
  onUpdatePin: (id: string, note: string) => void
  onRemovePin: (id: string) => void
  readOnly: boolean
  // Pins can only be dropped once the client has entered "needs changes" mode
  // for this creative. Existing pins keep it enabled so they can keep annotating.
  pinningEnabled: boolean
  // Global marker number for a pin. Carousels split one pins array between this
  // overlay (card-level) and per-slide layers, so a pin's number must come from
  // its position in the FULL array — not its index in the filtered slice.
  pinNumber?: (pinId: string) => number
  // Number shown on the pending (unconfirmed) pin — full-array length + 1.
  nextPinNumber?: number
}

function PinOverlay({ children, pins, onAddPin, onUpdatePin, onRemovePin, readOnly, pinningEnabled, pinNumber, nextPinNumber }: PinOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [pendingPin, setPendingPin] = useState<{ x: number; y: number; note: string } | null>(null)
  const [activePin, setActivePin] = useState<string | null>(null)

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (readOnly) return
    if ((e.target as HTMLElement).closest('[data-pin]')) return
    if (!pinningEnabled) return  // gated: client must click "Needs changes" first
    if (pendingPin) { setPendingPin(null); return }
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    setActivePin(null)
    setPendingPin({ x, y, note: '' })
  }

  function confirmPendingPin() {
    if (!pendingPin) return
    onAddPin(pendingPin.x, pendingPin.y, pendingPin.note)
    setPendingPin(null)
  }

  const pendingNumber = nextPinNumber ?? pins.length + 1
  const numberOf = (pin: Pin, i: number) => pinNumber ? pinNumber(pin.id) : i + 1

  function popoverPosition(x: number) {
    if (x > 65) return { right: '0', left: 'auto', transform: 'none' }
    if (x < 35) return { left: '0', transform: 'none' }
    return { left: '50%', transform: 'translateX(-50%)' }
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{ cursor: readOnly || !pinningEnabled ? 'default' : 'crosshair' }}
      onClick={handleClick}
    >
      {children}

      {/* Confirmed pins */}
      {pins.map((pin, i) => (
        <div
          key={pin.id}
          data-pin="true"
          className="absolute"
          style={{ left: `${pin.x}%`, top: `${pin.y}%`, transform: 'translate(-50%, -50%)', zIndex: activePin === pin.id ? 50 : 10 }}
        >
          <button
            onClick={e => { e.stopPropagation(); setActivePin(activePin === pin.id ? null : pin.id) }}
            className="w-6 h-6 rounded-full text-white text-[10px] font-bold flex items-center justify-center shadow-lg border-2 border-white transition-transform hover:scale-110"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
          >
            {numberOf(pin, i)}
          </button>
          {activePin === pin.id && (
            <div
              className="absolute z-20 w-52 max-w-[calc(100vw-2rem)] rounded-xl border border-white/20 shadow-2xl p-3 flex flex-col gap-2"
              style={{
                background: 'rgba(18,16,26,0.97)',
                backdropFilter: 'blur(12px)',
                top: '110%',
                ...popoverPosition(pin.x),
              }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Pin {numberOf(pin, i)}</span>
                {!readOnly && (
                  <button
                    onClick={() => { onRemovePin(pin.id); setActivePin(null) }}
                    className="text-[10px] text-rose-400 hover:text-rose-300 transition-colors"
                  >Remove</button>
                )}
              </div>
              {readOnly ? (
                <p className="text-xs text-white/70 leading-relaxed">{pin.note || <span className="text-white/30 italic">No note</span>}</p>
              ) : (
                <textarea
                  autoFocus
                  value={pin.note}
                  onChange={e => onUpdatePin(pin.id, e.target.value)}
                  placeholder="Describe the change needed…"
                  rows={3}
                  className="w-full text-xs bg-white/[0.06] border border-white/15 rounded-lg px-2.5 py-2 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60 resize-none"
                />
              )}
            </div>
          )}
        </div>
      ))}


      {/* Pending (unconfirmed) pin — awaiting comment */}
      {pendingPin && (
        <div
          data-pin="true"
          className="absolute"
          style={{ left: `${pendingPin.x}%`, top: `${pendingPin.y}%`, transform: 'translate(-50%, -50%)', zIndex: 50 }}
        >
          <div
            className="w-6 h-6 rounded-full text-white text-[10px] font-bold flex items-center justify-center border-2 border-white"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', boxShadow: '0 0 0 5px rgba(124,58,237,0.3)' }}
          >
            {pendingNumber}
          </div>
          <div
            className="absolute z-20 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-white/20 shadow-2xl p-4 flex flex-col gap-3"
            style={{
              background: 'rgba(18,16,26,0.97)',
              backdropFilter: 'blur(12px)',
              top: '110%',
              ...popoverPosition(pendingPin.x),
            }}
            onClick={e => e.stopPropagation()}
          >
            <span className="text-[11px] font-bold text-white/60 uppercase tracking-wider">Pin {pendingNumber} — What needs to change?</span>
            <textarea
              autoFocus
              value={pendingPin.note}
              onChange={e => setPendingPin(p => p ? { ...p, note: e.target.value } : p)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmPendingPin() } }}
              placeholder="Describe exactly what needs to change here…"
              rows={5}
              className="w-full text-[13px] bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60 resize-none leading-relaxed"
            />
            <div className="flex gap-2">
              <button
                onClick={confirmPendingPin}
                className="flex-1 py-2 rounded-lg text-[12px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
              >
                Submit
              </button>
              <button
                onClick={() => setPendingPin(null)}
                className="px-4 py-2 rounded-lg text-[12px] font-medium text-white/40 hover:text-white/70 bg-white/[0.05] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Per-slide pin layer — lives INSIDE a carousel slide's framed card ─────────
// Sibling of the framed card (inside the slide's track wrapper), so pins travel
// with the carousel track and dim with the inactive slides. Coordinates are % of
// the slide card, not the whole mockup plane. Only the ACTIVE slide captures
// clicks; every interaction stops propagation so nothing bubbles to the outer
// PinOverlay and drops a phantom card-level pin.

interface SlidePinLayerProps {
  pins: Pin[]
  active: boolean
  onAddPin: (x: number, y: number, note: string) => void
  onUpdatePin: (id: string, note: string) => void
  onRemovePin: (id: string) => void
  readOnly: boolean
  pinningEnabled: boolean
  pinNumber: (pinId: string) => number
  nextPinNumber: number
}

function SlidePinLayer({ pins, active, onAddPin, onUpdatePin, onRemovePin, readOnly, pinningEnabled, pinNumber, nextPinNumber }: SlidePinLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [pendingPin, setPendingPin] = useState<{ x: number; y: number; note: string } | null>(null)
  const [activePin, setActivePin] = useState<string | null>(null)

  const capturing = active && !readOnly && pinningEnabled

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    // MUST stop propagation — otherwise the outer PinOverlay also fires and
    // drops a duplicate card-level pin at whole-plane coordinates.
    e.stopPropagation()
    if (!capturing) return
    if ((e.target as HTMLElement).closest('[data-pin]')) return
    if (pendingPin) { setPendingPin(null); return }
    const rect = layerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    setActivePin(null)
    setPendingPin({ x, y, note: '' })
  }

  function confirmPendingPin() {
    if (!pendingPin) return
    onAddPin(pendingPin.x, pendingPin.y, pendingPin.note)
    setPendingPin(null)
  }

  function popoverPosition(x: number) {
    if (x > 65) return { right: '0', left: 'auto', transform: 'none' }
    if (x < 35) return { left: '0', transform: 'none' }
    return { left: '50%', transform: 'translateX(-50%)' }
  }
  // Pins low on the slide open their popover ABOVE the marker so it isn't
  // clipped by the carousel band / pushed into the feed below.
  function popoverVertical(y: number) {
    return y > 55 ? { bottom: '110%' } : { top: '110%' }
  }

  if (!capturing && pins.length === 0) return null

  return (
    <div
      ref={layerRef}
      className={`absolute top-0 bottom-0 left-1 right-1 transition-opacity duration-300 ${active ? 'opacity-100' : 'opacity-45'}`}
      style={{ pointerEvents: capturing ? 'auto' : 'none', cursor: capturing ? 'crosshair' : 'default' }}
      onClick={handleClick}
    >
      {pins.map((pin) => (
        <div
          key={pin.id}
          data-pin="true"
          className="absolute"
          style={{ left: `${pin.x}%`, top: `${pin.y}%`, transform: 'translate(-50%, -50%)', zIndex: activePin === pin.id ? 50 : 10, pointerEvents: active ? 'auto' : 'none' }}
        >
          <button
            onClick={e => { e.stopPropagation(); setActivePin(activePin === pin.id ? null : pin.id) }}
            className="w-6 h-6 rounded-full text-white text-[10px] font-bold flex items-center justify-center shadow-lg border-2 border-white transition-transform hover:scale-110"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
          >
            {pinNumber(pin.id)}
          </button>
          {activePin === pin.id && (
            <div
              className="absolute z-20 w-52 max-w-[calc(100vw-2rem)] rounded-xl border border-white/20 shadow-2xl p-3 flex flex-col gap-2"
              style={{
                background: 'rgba(18,16,26,0.97)',
                backdropFilter: 'blur(12px)',
                ...popoverVertical(pin.y),
                ...popoverPosition(pin.x),
              }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Pin {pinNumber(pin.id)}</span>
                {!readOnly && (
                  <button
                    onClick={() => { onRemovePin(pin.id); setActivePin(null) }}
                    className="text-[10px] text-rose-400 hover:text-rose-300 transition-colors"
                  >Remove</button>
                )}
              </div>
              {readOnly ? (
                <p className="text-xs text-white/70 leading-relaxed">{pin.note || <span className="text-white/30 italic">No note</span>}</p>
              ) : (
                <textarea
                  autoFocus
                  value={pin.note}
                  onChange={e => onUpdatePin(pin.id, e.target.value)}
                  placeholder="Describe the change needed…"
                  rows={3}
                  className="w-full text-xs bg-white/[0.06] border border-white/15 rounded-lg px-2.5 py-2 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60 resize-none"
                />
              )}
            </div>
          )}
        </div>
      ))}

      {pendingPin && (
        <div
          data-pin="true"
          className="absolute"
          style={{ left: `${pendingPin.x}%`, top: `${pendingPin.y}%`, transform: 'translate(-50%, -50%)', zIndex: 50 }}
        >
          <div
            className="w-6 h-6 rounded-full text-white text-[10px] font-bold flex items-center justify-center border-2 border-white"
            style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)', boxShadow: '0 0 0 5px rgba(124,58,237,0.3)' }}
          >
            {nextPinNumber}
          </div>
          <div
            className="absolute z-20 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-white/20 shadow-2xl p-4 flex flex-col gap-3"
            style={{
              background: 'rgba(18,16,26,0.97)',
              backdropFilter: 'blur(12px)',
              ...popoverVertical(pendingPin.y),
              ...popoverPosition(pendingPin.x),
            }}
            onClick={e => e.stopPropagation()}
          >
            <span className="text-[11px] font-bold text-white/60 uppercase tracking-wider">Pin {nextPinNumber} — What needs to change?</span>
            <textarea
              autoFocus
              value={pendingPin.note}
              onChange={e => setPendingPin(p => p ? { ...p, note: e.target.value } : p)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmPendingPin() } }}
              placeholder="Describe exactly what needs to change here…"
              rows={4}
              className="w-full text-[13px] bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60 resize-none leading-relaxed"
            />
            <div className="flex gap-2">
              <button
                onClick={confirmPendingPin}
                className="flex-1 py-2 rounded-lg text-[12px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}
              >
                Submit
              </button>
              <button
                onClick={() => setPendingPin(null)}
                className="px-4 py-2 rounded-lg text-[12px] font-medium text-white/40 hover:text-white/70 bg-white/[0.05] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Change History — client-visible resolved rounds ───────────────────────────
// Renders client_notes.history (rounds frozen when a graphic was replaced or a
// file swapped out). Resolved pins vanish from the creative and live here as
// text, with the old graphic's retained thumbnail for context.

function ChangeHistorySection({ history, reviewer }: { history: ReviewRound[]; reviewer: string | null }) {
  if (history.length === 0) return null
  const rounds = [...history].reverse()
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider px-1">
        Change History · {history.length} round{history.length !== 1 ? 's' : ''}
      </p>
      {rounds.map((h, i) => (
        <div key={`${h.file_id}-${h.round}-${i}`} className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          {h.thumb_url && (
            <div className="bg-black/30 border-b border-white/[0.06]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={h.thumb_url} alt={h.file_name} className="w-full max-h-28 object-contain opacity-70" />
            </div>
          )}
          <div className="p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-emerald-400/80 bg-emerald-500/10 px-1.5 py-0.5 rounded-full">Resolved</span>
              <span className="text-[10px] font-medium text-white/50">{h.dimensions ?? h.file_name}</span>
              {h.resolved_at && <span className="text-[10px] text-white/25">{new Date(h.resolved_at).toLocaleDateString()}</span>}
              {reviewer && <span className="text-[10px] text-white/25">· {reviewer}</span>}
            </div>
            {h.pins.map((pin, idx) => (
              <div key={pin.id} className="flex items-start gap-2">
                <span className="flex-none w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-bold flex items-center justify-center mt-0.5">✓</span>
                <p className="text-[11px] text-white/40 leading-relaxed line-through">{pin.note || `Pin ${idx + 1}`}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Chrome display mockup (for uploaded GIFs / display ads) ───────────────────

interface ChromeDisplayMockupProps {
  fileUrl: string
  fileName: string
  pins: Pin[]
  onAddPin: (x: number, y: number, note: string) => void
  onUpdatePin: (id: string, note: string) => void
  onRemovePin: (id: string) => void
  readOnly: boolean
  pinningEnabled: boolean
}


function ChromeDisplayMockup({ fileUrl, fileName, pins, onAddPin, onUpdatePin, onRemovePin, readOnly, pinningEnabled }: ChromeDisplayMockupProps) {
  const [replayKey, setReplayKey] = useState(0)
  const isVideo = isVideoUrl(fileUrl)
  const isHtml5 = isZipUrl(fileUrl)
  const isGif = !isVideo && !isHtml5 && fileUrl.split('?')[0].toLowerCase().endsWith('.gif')
  // Replay only makes sense for animated creatives (GIF, video, HTML5).
  const isAnimated = isGif || isVideo || isHtml5

  // Creative on its own — no browser-chrome frame. The old mockup hard-capped the
  // creative to a 480px window, which shrank wide banners (e.g. 970x250) to ~43% and
  // made them unreadable. Here the creative renders at its native size, capped only to
  // the available column width, so it reads at (or near) 1:1.
  return (
    <div className="inline-block max-w-full rounded-lg overflow-hidden shadow-2xl bg-white ring-1 ring-black/10">
      {/* Ad display area — wrapped in PinOverlay, native size */}
      <PinOverlay pins={isVideo ? [] : pins} onAddPin={onAddPin} onUpdatePin={onUpdatePin} onRemovePin={onRemovePin} readOnly={readOnly || isVideo} pinningEnabled={pinningEnabled}>
        <div className="flex items-center justify-center bg-white">
          {isVideo
            ? <VideoPlayer src={fileUrl} replayKey={replayKey} showReplayButton={false} />
            : isHtml5
            ? <Html5AdPlayer src={fileUrl} replayKey={replayKey} />
            : <img key={replayKey} src={`${fileUrl}${fileUrl.includes('?') ? '&' : '?'}r=${replayKey}`} alt={fileName} className="max-w-full h-auto block" />
          }
        </div>
      </PinOverlay>

      {/* Replay — animated creatives only (GIF, video, HTML5) */}
      {isAnimated && (
        <div className="bg-white flex flex-col items-center pb-3 pt-2 gap-1.5">
          <ReplayButton onClick={() => setReplayKey(k => k + 1)} label={isHtml5 ? 'Restart Animation' : 'Replay Animation'} />
          {isHtml5 && !readOnly && (
            <p className="text-[10px] text-gray-400 text-center px-4">
              Tip: restart and wait for the frame you want, then click to pin.
            </p>
          )}
        </div>
      )}

      {/* Caption + review controls — replaces the fake browser bar */}
      <div className="bg-[#f1f3f5] px-3 py-2 flex items-center justify-between gap-3">
        <span className="text-[11px] text-gray-500 truncate">{fileName}</span>
        <div className="flex-none flex items-center gap-2">
          {isHtml5 && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: 'linear-gradient(135deg,rgba(124,58,237,0.2),rgba(6,182,212,0.2))', color: '#7c3aed' }}>
              HTML5
            </span>
          )}
          {!readOnly && !isVideo && (
            <span className="flex items-center gap-1 text-[10px] text-gray-400" title="Click the creative to drop a pin">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
              </svg>
              Click to pin
            </span>
          )}
          {pins.length > 0 && (
            <span className="text-[10px] text-gray-400">{pins.length} pin{pins.length !== 1 ? 's' : ''}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AdviewerStatus }) {
  if (status === 'approved') return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-400/15 text-emerald-300 border border-emerald-400/25 whitespace-nowrap">✓ Approved</span>
  )
  if (status === 'needs_revision') return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-400/15 text-amber-300 border border-amber-400/25 whitespace-nowrap">Changes needed</span>
  )
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white/[0.06] text-white/30 border border-white/10 whitespace-nowrap">Pending</span>
  )
}

// ── Gallery view ──────────────────────────────────────────────────────────────

type SidebarItem =
  | { kind: 'card'; id: string; data: CampaignCardData }
  | { kind: 'file'; id: string; data: AdviewerCampaignFile }

interface GalleryViewProps {
  sidebarItems: SidebarItem[]
  filePins: Record<string, Pin[]>
  cardPins: Record<string, Pin[]>
  fileReviews: Record<string, { status: 'pending' | 'approved' | 'changes' }>
  cardReviews: Record<string, { status: 'pending' | 'approved' | 'changes' }>
  submitted: Set<string>
  onSelect: (id: string) => void
}

function GalleryView({ sidebarItems, filePins, cardPins, fileReviews, cardReviews, submitted, onSelect }: GalleryViewProps) {
  const [replayKeys, setReplayKeys] = useState<Record<string, number>>({})

  function replay(id: string) {
    setReplayKeys(prev => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
  }

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="flex flex-wrap gap-6 justify-center">
        {sidebarItems.map(item => {
          const label = item.kind === 'card' ? (item.data.card?.title ?? 'Untitled') : item.data.file_name
          const pinCount = item.kind === 'file'
            ? (filePins[item.id] ?? []).length
            : (cardPins[item.id] ?? []).length
          const reviewStatus = item.kind === 'file'
            ? fileReviews[item.id]?.status
            : cardReviews[item.id]?.status
          const isSubmitted = submitted.has(item.id)
          const rKey = replayKeys[item.id] ?? 0

          // Resolve image URL
          let imageUrl: string | null = null
          let isGif = false
          if (item.kind === 'file') {
            const raw = item.data.file_url
            imageUrl = raw?.startsWith('http') ? raw : raw ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/creative-files/${raw}` : null
            isGif = imageUrl?.toLowerCase().includes('.gif') ?? false
          } else {
            const cardFiles = item.data.card?.card_files ?? []
            const firstFile = cardFiles[0]
            if (firstFile) {
              const raw = firstFile.file_url
              imageUrl = raw?.startsWith('http') ? raw : raw ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/creative-files/${raw}` : null
              isGif = imageUrl?.toLowerCase().includes('.gif') ?? false
            } else {
              // Instant Experience cards carry no card_files — pull the first block's
              // media (header/image/carousel) as the sidebar thumbnail.
              const blocks = item.data.card?.instant_experience?.blocks ?? []
              const isImg = (u: string | null | undefined) => !!u && !/\.(mp4|mov|webm|m4v)(\?|$)/i.test(u)
              for (const b of blocks) {
                const u = b.type === 'image' || b.type === 'header' ? b.media_url
                  : b.type === 'image_carousel' ? (b.images.find(im => im.url)?.url ?? null) : null
                if (isImg(u)) { imageUrl = u as string; isGif = (u as string).toLowerCase().includes('.gif'); break }
              }
            }
          }

          // An Atlas social creative is an MP4, and both the file path and the
          // card_files path above resolve one straight into `imageUrl`. Rendered
          // in an <img> that paints a blank box with the alt text. Branch on the
          // resolved URL so this grid agrees with the detail view, the Lookbook
          // and the deck preview, which all already do it.
          // (The Instant Experience path is deliberately untouched — it filters
          // video out already and falling through to "No preview" is correct.)
          const isVideoThumb = !!imageUrl && isVideoUrl(imageUrl)

          const statusDot = isSubmitted
            ? (reviewStatus === 'approved' ? 'bg-emerald-400' : 'bg-amber-400')
            : reviewStatus === 'approved' ? 'bg-emerald-400'
            : reviewStatus === 'changes' ? 'bg-amber-400/60'
            : 'bg-white/20'

          return (
            <div
              key={item.id}
              className="flex flex-col rounded-2xl overflow-hidden border border-white/[0.08] bg-[#111214] cursor-pointer group transition-all hover:border-white/20 hover:shadow-2xl"
              style={{ width: '240px' }}
              onClick={() => onSelect(item.id)}
            >
              {/* Ad image — raw, no frame */}
              <div className="relative bg-[#f0f0f0] flex items-center justify-center min-h-[180px] overflow-hidden">
                {imageUrl && isVideoThumb ? (
                  // A still, not a player: no controls, because the tile itself is
                  // the click target that opens the review and control chrome would
                  // swallow the click on the exact pixels people aim for. The
                  // `#t=0.1` media fragment goes AFTER the cache-busting query so it
                  // parses, and makes the browser paint the frame at 0.1s.
                  <video
                    key={`${item.id}-${rKey}`}
                    src={`${imageUrl}${imageUrl.includes('?') ? '&' : '?'}r=${rKey}#t=0.1`}
                    muted
                    playsInline
                    preload="metadata"
                    className="max-w-full max-h-[320px] h-auto block object-contain"
                  />
                ) : imageUrl ? (
                  <img
                    key={`${item.id}-${rKey}`}
                    src={`${imageUrl}${imageUrl.includes('?') ? '&' : '?'}r=${rKey}`}
                    alt={label}
                    className="max-w-full max-h-[320px] h-auto block object-contain"
                  />
                ) : (
                  <div className="w-full h-36 flex items-center justify-center text-white/20 text-[11px]">No preview</div>
                )}
                {/* Status dot */}
                <div className={`absolute top-2 right-2 w-2.5 h-2.5 rounded-full border-2 border-[#111214] ${statusDot}`} />
                {/* Pin count badge */}
                {pinCount > 0 && (
                  <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold text-white" style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)' }}>
                    {pinCount} pin{pinCount !== 1 ? 's' : ''}
                  </div>
                )}
              </div>

              {/* Replay button for GIFs */}
              {isGif && imageUrl && (
                <div className="bg-[#f0f0f0] flex justify-center pb-2.5 pt-1.5">
                  <button
                    onClick={e => { e.stopPropagation(); replay(item.id) }}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold text-white transition-opacity hover:opacity-90"
                    style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)', boxShadow: '0 2px 10px rgba(124,58,237,0.4)' }}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                    </svg>
                    Replay
                  </button>
                </div>
              )}

              {/* Label + click to review hint */}
              <div className="px-3 py-2.5 border-t border-white/[0.06]">
                <p className="text-[11px] font-medium text-white/70 truncate">{label}</p>
                <p className="text-[10px] text-white/25 mt-0.5 group-hover:text-[#7c3aed] transition-colors">Click to review →</p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────



export default function CampaignPreviewClient({ campaign, only, canEdit = false, scopeLocationName = null, reviewToken }: Props) {
  // The pins this link's verdict counts. A location link only ever sees its own;
  // corporate's link also shows the location's pins (one list for designers),
  // but they are the location's answer (location_status), not corporate's.
  const ownPins = (ps: Pin[]) => (scopeLocationName ? ps : ps.filter(p => p.by !== 'location'))
  // Client review writes (pins, per-file/-card status, campaign rollup) go through
  // this token-gated server route, NOT the browser Supabase client: the anon role
  // has no write policy on adviewer_campaign_* (is_writer()-only), so a direct
  // browser update from a link-only client is silently dropped by RLS and the note
  // never persists. The route validates the token + row ownership and writes with
  // the service-role client. See app/api/adviewer/review/route.ts.
  const persistReview = useCallback(
    (payload: { kind: 'card' | 'file' | 'campaign'; id?: string; client_notes?: unknown; status?: AdviewerStatus }) =>
      fetch('/api/adviewer/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: reviewToken, ...payload }),
      }),
    [reviewToken]
  )

  const cards = campaign.campaign_cards ?? []
  // State (not a const off props) so a writer's copy edit re-renders the mockup live.
  const [files, setFiles] = useState<AdviewerCampaignFile[]>(campaign.campaign_files ?? [])
  const client = campaign.client

  // Staff-only (canEdit) admin action: approve the whole campaign and send it to
  // the Lookbook in one step, bypassing the client per-item submit flow. Two-click
  // confirm to match the dashboard's no-native-dialog convention.
  const [approving, setApproving] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  async function handleApproveCampaign() {
    setApproving(true)
    setApproveError(null)
    const res = await fetch(`/api/adviewer/campaign/${campaign.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    })
    if (res.ok) {
      window.location.href = '/adviewer/dashboard'
      return
    }
    const data = await res.json().catch(() => ({})) as { error?: string }
    setApproveError(data.error ?? 'Approve failed')
    setApproving(false)
    setConfirmApprove(false)
  }

  // Build unified sidebar items (cards first, then files)
  // `only` can be "itemId" (scopes to one card/file) or "itemId::fileId" (scopes to one specific file within a card)
  const onlyParts = only?.includes('::') ? only.split('::') : null
  const onlyItemId = onlyParts ? onlyParts[0] : (only ?? null)
  const onlyFileId = onlyParts ? onlyParts[1] : null

  const sidebarItems = useMemo<SidebarItem[]>(() => {
    const all: SidebarItem[] = [
      ...cards.map(cc => ({ kind: 'card' as const, id: cc.id, data: cc })),
      ...files.map(f => ({ kind: 'file' as const, id: f.id, data: f })),
    ]
    if (onlyItemId) {
      const match = all.find(i => i.id === onlyItemId)
      return match ? [match] : all
    }
    return all
  }, [cards, files, onlyItemId])

  // Gallery / single view toggle — gallery only available when there are multiple items and no `only` filter
  const [galleryMode, setGalleryMode] = useState(false)

  // Mobile-only layout state (below lg): creative list overlay drawer + review bottom sheet.
  // No effect at lg+ where the desktop 3-column layout renders as before.
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [mobileReviewOpen, setMobileReviewOpen] = useState(false)

  // Copy-link feedback — stores the ID of the item whose link was just copied, or 'all' for the full campaign link
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  function copyItemLink(itemId: string) {
    const url = new URL(window.location.href)
    url.searchParams.set('only', itemId)
    void navigator.clipboard.writeText(url.toString())
    setCopiedLinkId(itemId)
    setTimeout(() => setCopiedLinkId(null), 2000)
  }
  function copyAllLink() {
    const url = new URL(window.location.href)
    url.searchParams.delete('only')
    void navigator.clipboard.writeText(url.toString())
    setCopiedLinkId('all')
    setTimeout(() => setCopiedLinkId(null), 2000)
  }
  // Copy the creative name (linked to the campaign Adviewer URL), landing page(s), and end
  // date — formatted for pasting into the Copy Tracker Google Sheet. Card items only.
  const [copiedTrackerId, setCopiedTrackerId] = useState<string | null>(null)
  async function copyItemForTracker(cardData: CampaignCardData) {
    const card = cardData.card
    if (!card) return
    const url = new URL(window.location.href)
    url.searchParams.set('only', cardData.id)
    const ok = await copyForCopyTracker({
      creativeName: resolveCreativeName(card.card_files, card.creative_name, card.title),
      adviewerUrl: url.toString(),
      cardUrl: `${window.location.origin}/card/${card.id}`,
      landingPages: collectLandingPages(
        card.landing_page_url,
        card.media_type === 'Carousel Ad' ? card.carousel_slides : null,
      ),
      endDate: card.flight_end_date,
    })
    if (!ok) return
    setCopiedTrackerId(cardData.id)
    setTimeout(() => setCopiedTrackerId(null), 2000)
  }
  // Hovered section — drives ad preview highlights
  const [hoveredSection, setHoveredSection] = useState<SectionKey | null>(null)

  // Device view mode — mobile (phone frame) or desktop (browser frame)
  const [viewMode, setViewMode] = useState<'mobile' | 'desktop'>('mobile')

  // Reviewer identity — collected once via modal on first submit
  const [identityName, setIdentityName] = useState('')
  const [identityEmail, setIdentityEmail] = useState('')
  const [identityConfirmed, setIdentityConfirmed] = useState(false)
  const [showIdentityModal, setShowIdentityModal] = useState(false)
  const [thankYou, setThankYou] = useState<null | { approved: number; changes: number; done: boolean }>(null)
  const [pendingSubmitAfterIdentity, setPendingSubmitAfterIdentity] = useState(false)

  // Selected item (card or file)
  const [selectedItemId, setSelectedItemId] = useState<string>(sidebarItems[0]?.id ?? '')
  const selectedItem = sidebarItems.find(i => i.id === selectedItemId) ?? sidebarItems[0]

  // Backwards compat — selected campaign card (null if a file is selected)
  const selectedCampaignCard = selectedItem?.kind === 'card' ? selectedItem.data : undefined

  const [submitting, setSubmitting] = useState<string | null>(null)
  const [sessionSubmitted, setSessionSubmitted] = useState(false)

  // Confirm-summary modal shown before the real submit/email fires.
  const [showConfirmModal, setShowConfirmModal] = useState(false)

  // Transient "Saved" indicator — flashed whenever a live edit is persisted.
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const markSaved = useCallback(() => {
    setSavedAt(Date.now())
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setSavedAt(null), 2000)
  }, [])
  const [submitted, setSubmitted] = useState<Set<string>>(
    () => new Set([
      ...cards.filter(cc => cc.status !== 'pending').map(cc => cc.id),
      ...files.filter(f => f.status !== 'pending').map(f => f.id),
    ])
  )

  // ── Writer-only: edit a manually-uploaded creative's copy after campaign creation.
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  // Staff-only carousel slide edit (gap #2). Holds the slide being edited; the modal
  // hits the /api/adviewer/slide routes then router.refresh() reloads server data.
  const [editingSlide, setEditingSlide] = useState<Slide | null>(null)
  const router = useRouter()
  const [copyDraft, setCopyDraft] = useState({
    fb_page_name: '', fb_body_text: '', fb_headline: '', fb_subheadline: '', fb_cta: '', landing_page_url: '',
  })
  const [graphicDraft, setGraphicDraft] = useState<File | null>(null) // staged new graphic
  const [graphicDragOver, setGraphicDragOver] = useState(false)
  const [savingCopy, setSavingCopy] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)

  function openCopyEditor(f: AdviewerCampaignFile) {
    setCopyError(null)
    setGraphicDraft(null)
    setCopyDraft({
      fb_page_name: f.fb_page_name ?? '',
      fb_body_text: f.fb_body_text ?? '',
      fb_headline: f.fb_headline ?? '',
      fb_subheadline: f.fb_subheadline ?? '',
      fb_cta: f.fb_cta ?? '',
      landing_page_url: f.landing_page_url ?? '',
    })
    setEditingFileId(f.id)
  }

  // One Save for the whole "edit creative" window: write the copy, then (if a new
  // graphic was dropped) replace the file. Either resets an existing review to
  // pending; a graphic swap also clears the stale pins.
  async function saveCopy() {
    if (!editingFileId) return
    const fileId = editingFileId
    setSavingCopy(true)
    setCopyError(null)
    try {
      const res = await fetch(`/api/adviewer/creative/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(copyDraft),
      })
      const data = await res.json()
      if (!res.ok) {
        setCopyError(typeof data?.error === 'string' ? data.error : 'Failed to save')
        setSavingCopy(false)
        return
      }
      // Apply the copy result to state immediately — so if the graphic step below
      // fails, the UI still reflects the copy that was actually persisted (no stale
      // display until reload).
      const applyReset = (fid: string) => {
        setFileReviews(prev => ({ ...prev, [fid]: { status: 'pending', note: '' } }))
        setSubmitted(prev => {
          const next = new Set(prev)
          next.delete(fid)
          return next
        })
      }
      const copyRow = data.file as AdviewerCampaignFile
      setFiles(prev => prev.map(f => (f.id === copyRow.id ? copyRow : f)))
      if (data.reviewReset) applyReset(fileId)

      if (graphicDraft) {
        const fd = new FormData()
        fd.append('file', graphicDraft)
        const gRes = await fetch(`/api/adviewer/creative/${fileId}/replace`, { method: 'POST', body: fd })
        const gData = await gRes.json()
        if (!gRes.ok) {
          // Copy already saved + reflected above; only the graphic failed.
          setCopyError(typeof gData?.error === 'string' ? gData.error : 'Copy saved, but the graphic could not be replaced — try again.')
          setSavingCopy(false)
          return
        }
        const graphicRow = gData.file as AdviewerCampaignFile
        setFiles(prev => prev.map(f => (f.id === graphicRow.id ? graphicRow : f)))
        setFilePins(prev => ({ ...prev, [fileId]: [] })) // new image → old pins are meaningless
        applyReset(fileId) // a graphic swap always resets the review
      }

      setEditingFileId(null)
      setGraphicDraft(null)
    } catch {
      setCopyError('Failed to save')
    }
    setSavingCopy(false)
  }


  // Per-file pin annotations — keyed by file ID, seeded from client_notes
  const [filePins, setFilePins] = useState<Record<string, Pin[]>>(() => {
    const map: Record<string, Pin[]> = {}
    for (const f of files) {
      const pins = f.client_notes?.pins
      if (pins && pins.length > 0) map[f.id] = pins as Pin[]
    }
    return map
  })

  function saveFilePins(fileId: string, pins: Pin[]) {
    markSaved()
    void persistReview({ kind: 'file', id: fileId, client_notes: { pins } })
  }
  function addPin(fileId: string, x: number, y: number, note: string) {
    const newPin: Pin = { id: crypto.randomUUID(), x, y, note }
    setFilePins(prev => {
      const next = { ...prev, [fileId]: [...(prev[fileId] ?? []), newPin] }
      saveFilePins(fileId, next[fileId])
      return next
    })
    setFileReviews(prev => ({ ...prev, [fileId]: { ...prev[fileId], status: 'changes' } }))
    setNeedsChangesMode(prev => ({ ...prev, [fileId]: false }))
  }
  function removePin(fileId: string, pinId: string) {
    setFilePins(prev => {
      const next = { ...prev, [fileId]: (prev[fileId] ?? []).filter(p => p.id !== pinId) }
      saveFilePins(fileId, next[fileId])
      return next
    })
  }
  function updatePin(fileId: string, pinId: string, note: string) {
    setFilePins(prev => {
      const next = { ...prev, [fileId]: (prev[fileId] ?? []).map(p => p.id === pinId ? { ...p, note } : p) }
      saveFilePins(fileId, next[fileId])
      return next
    })
  }

  // Per-card pin annotations — keyed by campaign_card ID, seeded from client_notes
  const [cardPins, setCardPins] = useState<Record<string, Pin[]>>(() => {
    const map: Record<string, Pin[]> = {}
    for (const cc of cards) {
      const pins = cc.client_notes?.pins
      if (pins && pins.length > 0) map[cc.id] = pins as Pin[]
    }
    return map
  })

  function saveCardPins(cardId: string, pins: Pin[]) {
    // Spread the existing blob so a card-level pin edit doesn't wipe designer-authored
    // fields (resolved_pins, history) or reviewer/submitted_at.
    markSaved()
    const existing = cards.find(c => c.id === cardId)?.client_notes
    void persistReview({ kind: 'card', id: cardId, client_notes: { ...(existing ?? {}), pins } })
  }
  function addCardPin(cardId: string, x: number, y: number, note: string, slideId?: string, blockId?: string) {
    const newPin: Pin = { id: crypto.randomUUID(), x, y, note }
    if (slideId) newPin.slide_id = slideId
    if (blockId) newPin.block_id = blockId
    setCardPins(prev => {
      const next = { ...prev, [cardId]: [...(prev[cardId] ?? []), newPin] }
      saveCardPins(cardId, next[cardId])
      return next
    })
    setNeedsChangesMode(prev => ({ ...prev, [cardId]: false }))
  }
  function removeCardPin(cardId: string, pinId: string) {
    setCardPins(prev => {
      const next = { ...prev, [cardId]: (prev[cardId] ?? []).filter(p => p.id !== pinId) }
      saveCardPins(cardId, next[cardId])
      return next
    })
  }
  function updateCardPin(cardId: string, pinId: string, note: string) {
    setCardPins(prev => {
      const next = { ...prev, [cardId]: (prev[cardId] ?? []).map(p => p.id === pinId ? { ...p, note } : p) }
      saveCardPins(cardId, next[cardId])
      return next
    })
  }

  // Per-sub-file pin annotations for multi-file board cards — keyed by card_files.id.
  // Board-card sub-files have no adviewer_campaign_files row, so their pins persist on
  // the parent card link's client_notes.file_pins map (Option 1: no schema change).
  const cardFileToCardId = useMemo(() => {
    const m: Record<string, string> = {}
    for (const cc of cards) for (const f of cc.card?.card_files ?? []) m[f.id] = cc.id
    return m
  }, [cards])

  const [subFilePins, setSubFilePins] = useState<Record<string, Pin[]>>(() => {
    const map: Record<string, Pin[]> = {}
    for (const cc of cards) {
      const fp = cc.client_notes?.file_pins
      if (!fp) continue
      for (const [fileId, pins] of Object.entries(fp)) {
        if (Array.isArray(pins) && pins.length > 0) map[fileId] = pins as Pin[]
      }
    }
    return map
  })

  // Per-sub-file explicit approvals for multi-file cards, keyed by card_files.id.
  // Seeded from client_notes.file_reviews (only the 'approved' entries — 'changes'
  // is derived from the presence of pins).
  const [subFileApproved, setSubFileApproved] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {}
    for (const cc of cards) {
      const fr = cc.client_notes?.file_reviews
      if (!fr) continue
      for (const [fileId, status] of Object.entries(fr)) {
        if (status === 'approved') map[fileId] = true
      }
    }
    return map
  })

  // Single writer for a card's per-sub-file state. Both pins and approvals live on
  // the same client_notes blob, so we always rebuild the whole file_pins/file_reviews
  // map from the current in-memory state to avoid one write clobbering the other.
  function persistCard(cardId: string, pinsMap: Record<string, Pin[]>, approvedMap: Record<string, boolean>) {
    const cc = cards.find(c => c.id === cardId)
    if (!cc) return
    const fileIds = (cc.card?.card_files ?? []).map(f => f.id)
    const file_pins: Record<string, Pin[]> = {}
    const file_reviews: Record<string, 'approved' | 'changes'> = {}
    for (const fid of fileIds) {
      const pins = pinsMap[fid] ?? []
      if (pins.length > 0) file_pins[fid] = pins
      if (ownPins(pins).length > 0) file_reviews[fid] = 'changes'
      else if (approvedMap[fid]) file_reviews[fid] = 'approved'
    }
    markSaved()
    void persistReview({ kind: 'card', id: cardId, client_notes: { ...cc.client_notes, file_pins, file_reviews } })
  }
  function addSubFilePin(fileId: string, x: number, y: number, note: string) {
    const cardId = cardFileToCardId[fileId]
    const newPin: Pin = { id: crypto.randomUUID(), x, y, note }
    // A pinned size can't also be "approved" — clear any stale approval.
    setSubFileApproved(prev => (prev[fileId] ? { ...prev, [fileId]: false } : prev))
    setSubFilePins(prev => {
      const next = { ...prev, [fileId]: [...(prev[fileId] ?? []), newPin] }
      if (cardId) persistCard(cardId, next, { ...subFileApproved, [fileId]: false })
      return next
    })
  }
  function removeSubFilePin(fileId: string, pinId: string) {
    const cardId = cardFileToCardId[fileId]
    setSubFilePins(prev => {
      const next = { ...prev, [fileId]: (prev[fileId] ?? []).filter(p => p.id !== pinId) }
      if (cardId) persistCard(cardId, next, subFileApproved)
      return next
    })
  }
  function updateSubFilePin(fileId: string, pinId: string, note: string) {
    const cardId = cardFileToCardId[fileId]
    setSubFilePins(prev => {
      const next = { ...prev, [fileId]: (prev[fileId] ?? []).map(p => p.id === pinId ? { ...p, note } : p) }
      if (cardId) persistCard(cardId, next, subFileApproved)
      return next
    })
  }
  function toggleSubFileApprove(fileId: string) {
    const cardId = cardFileToCardId[fileId]
    setSubFileApproved(prev => {
      const next = { ...prev, [fileId]: !prev[fileId] }
      if (cardId) persistCard(cardId, subFilePins, next)
      return next
    })
    // Approving a size exits its needs-changes mode.
    setNeedsChangesMode(prev => ({ ...prev, [fileId]: false }))
  }

  // Per-card review state — simplified single status (mirrors file review)
  type CardReviewState = { status: 'pending' | 'approved' | 'changes'; note: string }
  const initialCardReviews = useMemo(() => {
    const map: Record<string, CardReviewState> = {}
    // Seed from the authoritative status column first. This used to read only the
    // legacy per-section key client_notes.caption.status, which nothing has written
    // since the review moved to card-level status — so every reviewed single-creative
    // card reloaded as "pending": an approved campaign read "0/4 reviewed" and could
    // never roll up (Example University, Oct 2026; same root cause as the Aug 17 "Changes
    // needed" badge on an approved card). Order: the adviewer_campaign_cards.status
    // column (also set by staff approve, which writes no client_notes), then
    // client_notes.status, then the legacy caption key for very old rows.
    for (const cc of cards) {
      const status: AdviewerStatus = cc.status !== 'pending'
        ? cc.status
        : (cc.client_notes?.status ?? cc.client_notes?.caption?.status ?? 'pending')
      map[cc.id] = { status: toSectionStatus(status), note: '' }
    }
    return map
  }, [cards])
  const [cardReviews, setCardReviews] = useState<Record<string, CardReviewState>>(initialCardReviews)


  // Resolved pin IDs — keyed by campaign_card id, persisted to client_notes.resolved_pins
  const [resolvedPins, setResolvedPins] = useState<Record<string, string[]>>(() => {
    const map: Record<string, string[]> = {}
    for (const cc of cards) {
      map[cc.id] = cc.client_notes?.resolved_pins ?? []
    }
    return map
  })

  // Comment panel tab — 'comments' or 'resolved'
  const [commentTab, setCommentTab] = useState<'comments' | 'resolved'>('comments')

  async function toggleResolvePin(cardId: string, pinId: string) {
    const current = resolvedPins[cardId] ?? []
    const next = current.includes(pinId) ? current.filter(id => id !== pinId) : [...current, pinId]
    setResolvedPins(prev => ({ ...prev, [cardId]: next }))
    const card = cards.find(c => c.id === cardId)
    if (!card) return
    await persistReview({ kind: 'card', id: cardId, client_notes: { ...card.client_notes, resolved_pins: next } })
  }

  // Per-file review state (simplified: single approve/reject + note)
  type FileReviewState = { status: 'pending' | 'approved' | 'changes'; note: string }
  const initialFileReviews = useMemo(() => {
    const map: Record<string, FileReviewState> = {}
    for (const f of files) {
      map[f.id] = f.client_notes?.status
        ? { status: toSectionStatus(f.client_notes.status), note: f.client_notes.note ?? '' }
        : { status: 'pending', note: '' }
    }
    return map
  }, [files])
  const [fileReviews, setFileReviews] = useState<Record<string, FileReviewState>>(initialFileReviews)

  // Pin status tracking — keyed by pin ID: 'resolved' | 'pending' (absent = open)
  const [pinStatuses, setPinStatuses] = useState<Record<string, 'resolved' | 'pending'>>({})
  // Pending reason text — keyed by pin ID
  const [pendingPinNotes, setPendingPinNotes] = useState<Record<string, string>>({})
  // Editing pending note — pin ID currently in edit mode
  const [editingPendingPin, setEditingPendingPin] = useState<string | null>(null)
  // "Needs changes" instruction mode — keyed by file/card ID
  const [needsChangesMode, setNeedsChangesMode] = useState<Record<string, boolean>>({})

  function togglePinResolved(pinId: string) {
    setPinStatuses(prev => {
      const next = { ...prev }
      if (next[pinId] === 'resolved') delete next[pinId]
      else next[pinId] = 'resolved'
      return next
    })
  }

  function setPinPending(pinId: string, note: string) {
    setPinStatuses(prev => ({ ...prev, [pinId]: 'pending' }))
    setPendingPinNotes(prev => ({ ...prev, [pinId]: note }))
    setEditingPendingPin(null)
  }

  function clearPinPending(pinId: string) {
    setPinStatuses(prev => { const next = { ...prev }; delete next[pinId]; return next })
    setEditingPendingPin(null)
  }

  const isFileSelected = selectedItem?.kind === 'file'
  const selectedFile_ = isFileSelected ? (selectedItem.data as AdviewerCampaignFile) : null

  const fileReviewForSelected = fileReviews[selectedFile_?.id ?? ''] ?? { status: 'pending' as const, note: '' }

  const cardReviewForSelected = cardReviews[selectedCampaignCard?.id ?? ''] ?? { status: 'pending' as const, note: '' }

  const isReadOnly = submitted.has(selectedItem?.id ?? '')


  // Per-item "was this approved" — used for the right panel header badge
  const selectedItemApproved = isFileSelected
    ? fileReviewForSelected.status === 'approved'
    : (cardPins[selectedCampaignCard?.id ?? ''] ?? []).length === 0 && cardReviewForSelected.status === 'approved'

  // Size-aware review units — each sub-file of a multi-file card is its own unit,
  // so progress and the submit gate count sizes ("Reviewed 4 of 6"), not cards.
  type ReviewUnit = { key: string; label: string; status: 'pending' | 'approved' | 'changes'; pins: number }
  const reviewUnits = useMemo<ReviewUnit[]>(() => {
    const units: ReviewUnit[] = []
    for (const item of sidebarItems) {
      if (item.kind === 'file') {
        const f = item.data
        const pins = (filePins[f.id] ?? []).length
        const fr = fileReviews[f.id]?.status ?? 'pending'
        units.push({ key: f.id, label: f.file_name, status: pins > 0 ? 'changes' : fr, pins })
        continue
      }
      const cc = item.data
      const subs = cc.card?.card_files ?? []
      if (isPerSizeCard(cc.card?.media_type, subs.length)) {
        for (const sf of subs) {
          const pins = (subFilePins[sf.id] ?? []).length
          units.push({ key: sf.id, label: sf.file_name, status: pins > 0 ? 'changes' : subFileApproved[sf.id] ? 'approved' : 'pending', pins })
        }
      } else {
        // Resolved-but-not-replaced pins must not keep counting as open "changes" —
        // otherwise this unit (and the campaign-wide approval rollup below) can never
        // reach 'approved' once a client resolves a pin without a physical replace.
        const resolved = resolvedPins[cc.id] ?? []
        const pins = (cardPins[cc.id] ?? []).filter(p => !resolved.includes(p.id)).length
        units.push({ key: cc.id, label: cc.card?.title ?? 'Ad', status: pins > 0 ? 'changes' : cardReviews[cc.id]?.status === 'approved' ? 'approved' : 'pending', pins })
      }
    }
    return units
  }, [sidebarItems, filePins, fileReviews, subFilePins, subFileApproved, cardPins, cardReviews, resolvedPins])

  const reviewedUnitCount = reviewUnits.filter(u => u.status !== 'pending').length
  const allActioned = reviewUnits.length > 0 && reviewedUnitCount >= reviewUnits.length
  // Partial submit: one actioned unit (approved or pinned) is enough. Un-actioned
  // units are listed in the confirm modal as left-pending, excluded from the
  // submit/email, and stay open for a later "Submit Additional Feedback" round.
  const anyActioned = reviewedUnitCount > 0

  const allAlreadySubmitted = sidebarItems.length > 0 && sidebarItems.every(i => submitted.has(i.id))


  async function handleSubmitAll({ identityJustConfirmed = false }: { identityJustConfirmed?: boolean } = {}) {
    if (submitting) return

    // Show identity modal first if reviewer hasn't identified yet. The modal's own
    // Submit calls this in the same tick as setIdentityConfirmed(true), so this closure
    // still sees identityConfirmed === false — hence the explicit override.
    if (!identityConfirmed && !identityJustConfirmed) {
      setPendingSubmitAfterIdentity(true)
      setShowIdentityModal(true)
      return
    }

    setSubmitting('all')

    interface EmailItem { title: string; status: AdviewerStatus; note: string }
    const emailItems: EmailItem[] = []
    const boardCardIds: string[] = []
    const approvedBoardCardIds: string[] = []
    const newSubmittedIds: string[] = []

    // ── Process each campaign card ───────────────────────────────────────────
    for (const cc of cards) {
      const subFiles = cc.card?.card_files ?? []
      const isMulti = isPerSizeCard(cc.card?.media_type, subFiles.length)
      const cPins = cardPins[cc.id] ?? []
      // Preserve the per-sub-file maps instead of flattening them away.
      const filePinsMap: Record<string, Pin[]> = {}
      const fileReviewsMap: Record<string, 'approved' | 'changes'> = {}
      for (const f of subFiles) {
        const p = subFilePins[f.id] ?? []
        if (p.length > 0) filePinsMap[f.id] = p
        if (ownPins(p).length > 0) fileReviewsMap[f.id] = 'changes'
        else if (subFileApproved[f.id]) fileReviewsMap[f.id] = 'approved'
      }
      const fPins = Object.values(filePinsMap).flat()
      // `pins` stays flattened (card-level + sub-file) for backwards compatibility
      // with the designer-side Change Requests tab, which reads client_notes.pins.
      const pins = [...cPins, ...fPins]
      const cardRev = cardReviews[cc.id]

      // Multi-file cards roll up from per-size state; others use the card-level review.
      let status: AdviewerStatus
      if (isMulti) {
        const anyChanges = subFiles.some(f => ownPins(subFilePins[f.id] ?? []).length > 0)
        const anyReviewed = subFiles.some(f => ownPins(subFilePins[f.id] ?? []).length > 0 || subFileApproved[f.id])
        status = anyChanges ? 'needs_revision' : anyReviewed ? 'approved' : 'pending'
      } else {
        // Same resolved-pin filter as reviewUnits — a resolved-but-not-replaced pin
        // must not keep this card (and the campaign-wide rollup) stuck on 'needs_revision'.
        const resolved = cc.client_notes?.resolved_pins ?? []
        const openPinCount = ownPins(cPins).filter(p => !resolved.includes(p.id)).length + ownPins(fPins).length
        status = openPinCount > 0 ? 'needs_revision' : cardRev?.status === 'approved' ? 'approved' : 'pending'
      }

      if (status === 'pending') continue  // not reviewed — skip

      await persistReview({
        kind: 'card',
        id: cc.id,
        status,
        client_notes: {
          reviewer: identityName.trim(),

          submitted_at: new Date().toISOString(),
          status,
          note: cardRev?.note ?? '',
          pins,
          file_pins: filePinsMap,
          file_reviews: fileReviewsMap,
          // Preserve resolved pins across re-submits — a new submission must not
          // un-resolve pins the designer already resolved on other cards.
          resolved_pins: cc.client_notes?.resolved_pins ?? [],
          // Preserve the retained change-request history across re-submits — a new
          // review round must not erase prior resolved rounds (snapshotted on file replace).
          history: cc.client_notes?.history ?? [],
        } as unknown as CampaignCardReview,
      })

      if (status === 'needs_revision') boardCardIds.push(cc.card_id)
      if (status === 'approved') approvedBoardCardIds.push(cc.card_id)
      newSubmittedIds.push(cc.id)
      emailItems.push({
        title: cc.card?.title ?? 'Ad',
        status,
        note: pins.length > 0 ? `${pins.length} pin${pins.length !== 1 ? 's' : ''} added` : 'Approved',
      })
    }

    // ── Process each uploaded file ───────────────────────────────────────────
    for (const f of files) {
      const fr = fileReviews[f.id]
      if (!fr || fr.status === 'pending') continue
      const status: AdviewerStatus = fr.status === 'approved' ? 'approved' : 'needs_revision'
      const fPins = filePins[f.id] ?? []

      await persistReview({
        kind: 'file',
        id: f.id,
        status,
        client_notes: {
          reviewer: identityName.trim(),
          status,
          note: fr.note,
          pins: fPins,
        },
      })

      newSubmittedIds.push(f.id)
      emailItems.push({ title: f.file_name, status, note: fr.note })
    }

    // ── Update overall campaign status ───────────────────────────────────────
    if (emailItems.length > 0) {
      // Partial submits must not mark the whole campaign approved while units are
      // still un-reviewed — roll up across ALL review units, not just this batch.
      const anyChanges = emailItems.some(i => i.status === 'needs_revision') || reviewUnits.some(u => u.status === 'changes')
      const everyUnitApproved = reviewUnits.length > 0 && reviewUnits.every(u => u.status === 'approved')
      const campaignStatus: AdviewerStatus = anyChanges ? 'needs_revision' : everyUnitApproved ? 'approved' : 'pending'
      // On a scope token this rolls up THIS LOCATION, not the campaign: the
      // route writes the scope row and moves the campaign only once every
      // location has approved. reviewUnits is already this location's slice,
      // so the arithmetic above is correct for whichever the token is.
      await persistReview({ kind: 'campaign', status: campaignStatus })

      // ── Notify: email + board card column move ───────────────────────────
      void fetch('/api/adviewer/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaign_token: reviewToken,
          reviewer: identityName.trim(),
          reviewerEmail: identityEmail.trim(),
          campaignTitle: campaign.title,
          clientName: client?.name ?? 'Client',

          items: emailItems,
          board_card_ids: boardCardIds,
          approved_board_card_ids: approvedBoardCardIds,
        }),
      })
    }

    setSubmitted(prev => new Set([...prev, ...newSubmittedIds]))
    setSubmitting(null)
    setSessionSubmitted(true)

    // Post-submit confirmation screen (replaces the awkward bounce back to the
    // campaign). Only show it when something was actually submitted this round.
    if (emailItems.length > 0) {
      setThankYou({
        approved: emailItems.filter(i => i.status === 'approved').length,
        changes: emailItems.filter(i => i.status === 'needs_revision').length,
        done: false,
      })
    }
  }

  const card = selectedCampaignCard?.card
  const mediaType = card?.media_type ?? null
  const cardFiles = (card?.card_files ?? [])
  const slides = (card?.carousel_slides ?? [])
  const ieBlocks: IEBlock[] = card?.instant_experience?.blocks ?? []

  // "Slide N" label for a slide-anchored pin (panel lists + confirm summary).
  function slideLabel(slideId?: string): string | null {
    if (!slideId) return null
    const s = slides.find(sl => sl.id === slideId)
    return s ? `Slide ${s.position + 1}` : 'Slide'
  }

  const [selectedFileId, setSelectedFileId] = useState<string | null>(onlyFileId ?? null)
  const selectedFile = cardFiles.find(f => f.id === selectedFileId) ?? (onlyFileId ? null : (cardFiles[0] ?? null))

  const [galleryReplayKeys, setGalleryReplayKeys] = useState<Record<string, number>>({})

  const navigateFile = useCallback((dir: 'next' | 'prev') => {
    if (cardFiles.length < 2 || onlyFileId) return
    const currentId = selectedFileId ?? cardFiles[0]?.id
    const idx = cardFiles.findIndex(f => f.id === currentId)
    const nextIdx = dir === 'next' ? (idx + 1) % cardFiles.length : (idx - 1 + cardFiles.length) % cardFiles.length
    const nextId = cardFiles[nextIdx].id
    setSelectedFileId(nextId)
    setGalleryReplayKeys(prev => ({ ...prev, [nextId]: (prev[nextId] ?? 0) + 1 }))
  }, [cardFiles, selectedFileId, onlyFileId])

  // Card-level pin partitions for the selected campaign card. Markers on the
  // creative hide resolved pins (they live in the Change History panel instead);
  // numbering always comes from the FULL array so marker numbers match the panel.
  const selectedCardId = selectedCampaignCard?.id ?? ''
  const selectedCardAllPins = cardPins[selectedCardId] ?? []
  const selectedCardResolvedIds = resolvedPins[selectedCardId] ?? []
  const visibleCardPins = selectedCardAllPins.filter(p => !selectedCardResolvedIds.includes(p.id))
  const cardLevelVisiblePins = visibleCardPins.filter(p => !p.slide_id)
  const slidePinsBySlide = visibleCardPins.reduce<Record<string, Pin[]>>((acc, p) => {
    if (p.slide_id) (acc[p.slide_id] = acc[p.slide_id] ?? []).push(p)
    return acc
  }, {})
  // Instant Experience: card pins anchored per inner block (block_id).
  const blockPinsByBlock = visibleCardPins.reduce<Record<string, Pin[]>>((acc, p) => {
    if (p.block_id) (acc[p.block_id] = acc[p.block_id] ?? []).push(p)
    return acc
  }, {})
  const cardPinNumber = (pinId: string) => selectedCardAllPins.findIndex(p => p.id === pinId) + 1
  const nextCardPinNumber = selectedCardAllPins.length + 1
  const cardPinningEnabled = !!needsChangesMode[selectedCardId] || selectedCardAllPins.length > 0

  const adMockup = isFileSelected && selectedFile_ ? (
    selectedFile_.render_mode === 'social' ? (
      // Manually-uploaded social spec — render inside the FB feed mockup using the
      // file's own copy (no board card). File-level pins/review flow is unchanged.
      <PinOverlay
        pins={filePins[selectedFile_.id] ?? []}
        onAddPin={(x, y, note) => addPin(selectedFile_.id, x, y, note)}
        onUpdatePin={(pinId, note) => updatePin(selectedFile_.id, pinId, note)}
        onRemovePin={(pinId) => removePin(selectedFile_.id, pinId)}
        readOnly={isReadOnly}
        pinningEnabled={!!needsChangesMode[selectedFile_.id] || (filePins[selectedFile_.id] ?? []).length > 0}
        pinNumber={(pinId) => (filePins[selectedFile_.id] ?? []).findIndex(p => p.id === pinId) + 1}
        nextPinNumber={(filePins[selectedFile_.id] ?? []).length + 1}
      >
        <FacebookMockup
          fileUrl={resolveFileUrl(selectedFile_.file_url)}
          pageName={selectedFile_.fb_page_name}
          clientName={client?.name ?? null}
          bodyText={selectedFile_.fb_body_text}
          headline={selectedFile_.fb_headline}
          subheadline={selectedFile_.fb_subheadline}
          description={null}
          cta={selectedFile_.fb_cta}
          logoUrl={client?.fb_page_logo_url ?? null}
          landingPageUrl={selectedFile_.landing_page_url}
          mediaType={null}
          hoveredSection={hoveredSection}
          viewMode={viewMode}
          showReplay={false}
        />
      </PinOverlay>
    ) : (
      <ChromeDisplayMockup
        fileUrl={selectedFile_.file_url}
        fileName={selectedFile_.file_name}
        pins={filePins[selectedFile_.id] ?? []}
        onAddPin={(x, y, note) => addPin(selectedFile_.id, x, y, note)}
        onUpdatePin={(pinId, note) => updatePin(selectedFile_.id, pinId, note)}
        onRemovePin={(pinId) => removePin(selectedFile_.id, pinId)}
        readOnly={isReadOnly}
        pinningEnabled={!!needsChangesMode[selectedFile_.id] || (filePins[selectedFile_.id] ?? []).length > 0}
      />
    )
  ) : isCarousel(mediaType) && slides.length > 0 ? (
    // Outer overlay handles card-level pins only (caption/header — whole-plane
    // coords); slide-anchored pins render inside each slide's framed card via
    // SlidePinLayer. The carousel stays ONE review unit either way.
    <PinOverlay
      pins={cardLevelVisiblePins}
      onAddPin={(x, y, note) => addCardPin(selectedCampaignCard!.id, x, y, note)}
      onUpdatePin={(pinId, note) => updateCardPin(selectedCampaignCard!.id, pinId, note)}
      onRemovePin={(pinId) => removeCardPin(selectedCampaignCard!.id, pinId)}
      readOnly={isReadOnly}
      pinningEnabled={cardPinningEnabled}
      pinNumber={cardPinNumber}
      nextPinNumber={nextCardPinNumber}
    >
      <CarouselMockup
        slides={slides} pageName={card?.fb_page_name ?? null} clientName={client?.name ?? null} bodyText={card?.fb_body_text ?? null} cta={card?.fb_cta ?? null} logoUrl={client?.fb_page_logo_url ?? null} hoveredSection={hoveredSection} viewMode={viewMode}
        canEdit={canEdit} onEditSlide={setEditingSlide}
        pinProps={{
          slidePins: slidePinsBySlide,
          onAddSlidePin: (slideId, x, y, note) => addCardPin(selectedCampaignCard!.id, x, y, note, slideId),
          onUpdateSlidePin: (pinId, note) => updateCardPin(selectedCampaignCard!.id, pinId, note),
          onRemoveSlidePin: (pinId) => removeCardPin(selectedCampaignCard!.id, pinId),
          readOnly: isReadOnly,
          pinningEnabled: cardPinningEnabled,
          pinNumber: cardPinNumber,
          nextPinNumber: nextCardPinNumber,
        }}
      />
    </PinOverlay>
  ) : isInstantExperience(mediaType) && ieBlocks.length > 0 ? (
    // Instant Experience — one review unit (like a carousel). Each inner block gets
    // its own SlidePinLayer (active) so pins anchor to the block, block-relative, and
    // travel with the scrolling phone canvas. No outer PinOverlay: the mockup scrolls,
    // so whole-plane coords would drift off content.
    <InstantExperienceMockup
      blocks={ieBlocks}
      cover={{ pageName: card?.fb_page_name ?? null, logoUrl: client?.fb_page_logo_url ?? null, bodyText: card?.fb_body_text ?? null }}
      pinLayer={(block) => (
        <SlidePinLayer
          active
          pins={blockPinsByBlock[block.id] ?? []}
          onAddPin={(x, y, note) => addCardPin(selectedCampaignCard!.id, x, y, note, undefined, block.id)}
          onUpdatePin={(pinId, note) => updateCardPin(selectedCampaignCard!.id, pinId, note)}
          onRemovePin={(pinId) => removeCardPin(selectedCampaignCard!.id, pinId)}
          readOnly={isReadOnly}
          pinningEnabled={cardPinningEnabled}
          pinNumber={cardPinNumber}
          nextPinNumber={nextCardPinNumber}
        />
      )}
    />
  ) : isSocial(mediaType) && selectedFile ? (
    <PinOverlay
      pins={visibleCardPins}
      onAddPin={(x, y, note) => addCardPin(selectedCampaignCard!.id, x, y, note)}
      onUpdatePin={(pinId, note) => updateCardPin(selectedCampaignCard!.id, pinId, note)}
      onRemovePin={(pinId) => removeCardPin(selectedCampaignCard!.id, pinId)}
      readOnly={isReadOnly}
      pinningEnabled={cardPinningEnabled}
      pinNumber={cardPinNumber}
      nextPinNumber={nextCardPinNumber}
    >
      <FacebookMockup
        fileUrl={resolveFileUrl(selectedFile.file_url)}
        pageName={card?.fb_page_name ?? null}
        clientName={client?.name ?? null}
        bodyText={card?.fb_body_text ?? null}
        headline={card?.fb_headline ?? null}
        subheadline={card?.fb_subheadline ?? null}
        description={card?.fb_link_description ?? null}
        cta={card?.fb_cta ?? null}
        logoUrl={client?.fb_page_logo_url ?? null}
        landingPageUrl={card?.landing_page_url ?? null}
        mediaType={mediaType}
        hoveredSection={hoveredSection}
        viewMode={viewMode}
      />
    </PinOverlay>
  ) : selectedFile && cardFiles.length <= 1 ? (
    // One file = one card-level review unit (the side panel, livePins and the submit
    // rollup all key it by card id), so pins must go to cardPins, same as social.
    <PinOverlay
      pins={visibleCardPins}
      onAddPin={(x, y, note) => addCardPin(selectedCampaignCard!.id, x, y, note)}
      onUpdatePin={(pinId, note) => updateCardPin(selectedCampaignCard!.id, pinId, note)}
      onRemovePin={(pinId) => removeCardPin(selectedCampaignCard!.id, pinId)}
      readOnly={isReadOnly}
      pinningEnabled={cardPinningEnabled}
      pinNumber={cardPinNumber}
      nextPinNumber={nextCardPinNumber}
    >
      <DisplayMockup fileUrl={resolveFileUrl(selectedFile.file_url)} title={card?.title ?? 'Preview'} hoveredSection={hoveredSection} />
    </PinOverlay>
  ) : selectedFile ? (
    <PinOverlay
      pins={subFilePins[selectedFile.id] ?? []}
      onAddPin={(x, y, note) => addSubFilePin(selectedFile.id, x, y, note)}
      onUpdatePin={(pinId, note) => updateSubFilePin(selectedFile.id, pinId, note)}
      onRemovePin={(pinId) => removeSubFilePin(selectedFile.id, pinId)}
      readOnly={isReadOnly}
      pinningEnabled={!!needsChangesMode[selectedFile.id] || (subFilePins[selectedFile.id] ?? []).length > 0}
    >
      <DisplayMockup fileUrl={resolveFileUrl(selectedFile.file_url)} title={card?.title ?? 'Preview'} hoveredSection={hoveredSection} />
    </PinOverlay>
  ) : (
    <p className="text-white/25 text-sm text-center py-16">No files uploaded yet</p>
  )

  const totalCards = reviewUnits.length
  const reviewedCount = reviewedUnitCount

  // Shared creative-list content — rendered in the desktop aside (lg+) and the
  // mobile overlay drawer (below lg) so the nav JSX is never duplicated.
  const sidebarInner = (
    <>
      <div className="flex-none px-4 py-3 border-b border-white/[0.06]">
        <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider">Campaign Creatives</p>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {/* View All Creatives — gallery mode */}
        {sidebarItems.length > 1 && (
          <div className={`relative group/all flex items-center border-b border-white/[0.05] mb-1 transition-colors ${galleryMode ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'}`}>
            <button
              onClick={() => { setGalleryMode(m => !m); setMobileListOpen(false) }}
              className="flex-1 text-left px-4 py-2.5 flex items-center gap-2.5"
            >
              <svg className={`w-3.5 h-3.5 flex-none ${galleryMode ? 'text-[#7c3aed]' : 'text-white/30'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
              </svg>
              <span className={`text-[12px] font-semibold ${galleryMode ? 'text-white' : 'text-white/50'}`}>View All Creatives</span>
            </button>
            {/* Copy full campaign link */}
            <button
              onClick={copyAllLink}
              title="Copy link to all creatives"
              className="mr-2.5 opacity-0 group-hover/all:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-white/[0.08]"
            >
              {copiedLinkId === 'all'
                ? <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                : <svg className="w-3 h-3 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
              }
            </button>
          </div>
        )}
        {sidebarItems.map(item => {
          const isActive = item.id === selectedItem?.id && !galleryMode
          const itemStatus = item.kind === 'card'
            ? (submitted.has(item.id) ? (cardReviews[item.id]?.status === 'approved' ? 'approved' : 'needs_revision') : item.data.status)
            : (submitted.has(item.id) ? (fileReviews[item.id]?.status === 'approved' ? 'approved' : 'needs_revision') : item.data.status)
          const label = item.kind === 'card' ? (item.data.card?.title ?? 'Untitled') : item.data.file_name
          const sublabel = item.kind === 'card' ? (item.data.card?.media_type ?? null) : (item.data.render_mode === 'social' ? 'Social Upload' : 'Display Upload')
          return (
            <Fragment key={item.id}>
            <div className="relative group">
              <button
                onClick={() => { setSelectedItemId(item.id); setSelectedFileId(null); setGalleryMode(false); setMobileListOpen(false) }}
                className={`w-full text-left px-4 py-3 flex items-start gap-2.5 transition-colors pr-16 ${isActive ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'}`}
              >
                <div className={`mt-1 w-2 h-2 rounded-full flex-none ${
                  itemStatus === 'approved' ? 'bg-emerald-400' :
                  itemStatus === 'needs_revision' ? 'bg-amber-400' :
                  item.kind === 'file' ? 'bg-cyan-400/50' : 'bg-white/20'
                }`} />
                <div className="min-w-0">
                  <p className={`text-[12px] font-medium leading-snug truncate ${isActive ? 'text-white' : 'text-white/50'}`}>{label}</p>
                  {sublabel && <p className="text-[10px] text-white/25 truncate mt-0.5">{sublabel}</p>}
                  {/* Staff, corporate link only: the location's own answer, kept
                      apart from corporate's (dot above). */}
                  {canEdit && !scopeLocationName && item.kind === 'card' && item.data.location_status && item.data.location_status !== 'pending' && (
                    <p className={`text-[10px] truncate mt-0.5 ${item.data.location_status === 'approved' ? 'text-emerald-300/70' : 'text-amber-300/80'}`}>
                      {item.data.location_name ?? 'Location'}: {item.data.location_status === 'approved' ? 'approved' : 'changes'}
                    </p>
                  )}
                </div>
              </button>
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {/* Copy for Copy Tracker (card items only) */}
                {item.kind === 'card' && (
                  <button
                    onClick={() => void copyItemForTracker(item.data)}
                    title="Copy for Copy Tracker — creative name (linked), landing page, and end date, formatted for the tracker sheet"
                    className="p-1.5 rounded-lg hover:bg-white/[0.08]"
                  >
                    {copiedTrackerId === item.id ? (
                      <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                    ) : (
                      <svg className="w-3 h-3 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    )}
                  </button>
                )}
                {/* Copy shareable link */}
                <button
                  onClick={() => copyItemLink(item.id)}
                  title="Copy link to this creative"
                  className="p-1.5 rounded-lg hover:bg-white/[0.08]"
                >
                  {copiedLinkId === item.id ? (
                    <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                  ) : (
                    <svg className="w-3 h-3 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
                  )}
                </button>
              </div>
            </div>
            {/* Sub-file rows — shown for multi-file display cards */}
            {(() => {
              const subFiles = item.kind === 'card' ? (item.data.card?.card_files ?? []) : []
              if (item.kind !== 'card' || !isPerSizeCard(item.data.card?.media_type, subFiles.length) || onlyFileId) return null
              return (
                <div className="pb-1">
                  {/* View all row */}
                  <div className={`group/sub flex items-center gap-2 px-4 py-1.5 transition-colors ${isActive && !selectedFileId ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}>
                    <button
                      onClick={() => { setSelectedItemId(item.id); setSelectedFileId(null); setGalleryMode(false); setMobileListOpen(false) }}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <span className="text-[10px] text-white/20 flex-none w-4 text-right">·</span>
                      <span className={`text-[11px] font-medium truncate ${isActive && !selectedFileId ? 'text-white' : 'text-white/40'}`}>View all</span>
                    </button>
                    <button
                      onClick={() => copyItemLink(item.id)}
                      title="Copy link to all files"
                      className="flex-none p-1 rounded opacity-0 group-hover/sub:opacity-100 transition-opacity hover:bg-white/[0.08]"
                    >
                      {copiedLinkId === item.id
                        ? <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                        : <svg className="w-3 h-3 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
                      }
                    </button>
                  </div>
                  {subFiles.map((file, fi) => {
                    const isFileSel = isActive && selectedFileId === file.id
                    const compositeId = `${item.id}::${file.id}`
                    return (
                      <div key={file.id} className={`group/sub flex items-center gap-2 px-4 py-1.5 transition-colors ${isFileSel ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}>
                        <button
                          onClick={() => { setSelectedItemId(item.id); setSelectedFileId(file.id); setGalleryMode(false); setMobileListOpen(false) }}
                          className="flex items-center gap-2 flex-1 min-w-0 text-left"
                        >
                          <span className="text-[10px] text-white/20 flex-none w-4 text-right">{fi + 1}</span>
                          <span className={`text-[11px] font-medium truncate ${isFileSel ? 'text-white' : 'text-white/40'}`}>{file.file_name}</span>
                        </button>
                        <button
                          onClick={() => copyItemLink(compositeId)}
                          title="Copy link to this file"
                          className="flex-none p-1 rounded hover:bg-white/[0.08] transition-colors"
                        >
                          {copiedLinkId === compositeId
                            ? <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                            : <svg className="w-3 h-3 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" /></svg>
                          }
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            </Fragment>
          )
        })}
      </nav>

      {/* Reviewer identity pill — shown after identity confirmed */}
      {identityConfirmed && (
        <div className="flex-none p-3 border-t border-white/[0.06]">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-[#7c3aed]/30 flex items-center justify-center text-[9px] font-bold text-purple-300 flex-none">
              {identityName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-white/60 truncate">{identityName}</p>
              {identityEmail && <p className="text-[10px] text-white/25 truncate">{identityEmail}</p>}
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <div className="h-screen flex flex-col bg-[#1a1b1e] overflow-hidden">

      {/* Top nav */}
      <header className="flex-none flex items-center justify-between px-5 py-3 bg-[#111214] border-b border-white/[0.08]">
        <div className="flex items-center gap-3">
          <Link href="/adviewer/dashboard" className="flex items-center gap-2 text-white/50 hover:text-white transition-colors">
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
            <p className="text-sm font-semibold text-white leading-tight">{campaign.title}</p>
            {/* On a scoped link the location matters more than the client name:
                it is how the viewer confirms they are looking at THEIR creatives
                and not the whole account. */}
            {scopeLocationName
              ? <p className="text-[10px] text-cyan-300/70">{scopeLocationName}</p>
              : client?.name && <p className="text-[10px] text-white/30">{client.name}</p>}
          </div>
          {/* Mobile-only creative list trigger (opens overlay drawer below lg) */}
          {!only && sidebarItems.length > 0 && (
            <button
              onClick={() => setMobileListOpen(true)}
              className="lg:hidden ml-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-white/70 bg-white/[0.06] border border-white/[0.1] hover:bg-white/[0.1] transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
              </svg>
              Creatives
              <span className="text-white/40">{sidebarItems.length}</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Overall progress */}
          <div className="flex items-center gap-2">
            <div className="w-24 h-1.5 bg-white/[0.08] rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{
                width: `${totalCards ? (reviewedCount / totalCards) * 100 : 0}%`,
                background: 'linear-gradient(90deg, #7c3aed, #06b6d4)',
              }} />
            </div>
            <p className="hidden sm:block text-[11px] text-white/30">{reviewedCount}/{totalCards} reviewed</p>
          </div>

          {/* Staff-only: one-click approve → Lookbook. The review tools below stay available. */}
          {canEdit && (
            confirmApprove ? (
              <div className="flex items-center gap-1.5">
                <span className="hidden sm:inline text-[11px] text-white/40">Send to Lookbook?</span>
                <button
                  onClick={() => void handleApproveCampaign()}
                  disabled={approving}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                >
                  {approving ? 'Approving…' : 'Confirm'}
                </button>
                <button
                  onClick={() => { setConfirmApprove(false); setApproveError(null) }}
                  disabled={approving}
                  className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white/60 bg-white/[0.06] hover:bg-white/[0.1] transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmApprove(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white transition-colors"
                style={{ background: 'linear-gradient(135deg, #10b981, #06b6d4)' }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Approve → Lookbook
              </button>
            )
          )}
          {approveError && <span className="text-[11px] text-red-300">{approveError}</span>}

          <StatusBadge status={campaign.status} />
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">

        {/* Left sidebar — card list (hidden in single-creative link mode).
            Desktop (lg+) shows it inline; below lg it lives in the mobile overlay drawer. */}
        {!only && (
        <aside className="hidden lg:flex w-56 flex-none bg-[#111214] border-r border-white/[0.08] flex-col overflow-hidden">
          {sidebarInner}
        </aside>
        )}

        {/* Mobile creative-list overlay drawer (below lg) */}
        {!only && mobileListOpen && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div className="absolute inset-0 bg-black/50" onClick={() => setMobileListOpen(false)} />
            <aside className="relative w-72 max-w-[80%] bg-[#111214] border-r border-white/[0.08] flex flex-col overflow-hidden">
              <button
                onClick={() => setMobileListOpen(false)}
                title="Close"
                className="absolute right-2 top-2 z-10 p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              {sidebarInner}
            </aside>
          </div>
        )}

        {/* Center — ad preview (or gallery) */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">

          {/* ── Gallery view ─────────────────────────────────────────────────── */}
          {galleryMode && (
            <GalleryView
              sidebarItems={sidebarItems}
              filePins={filePins}
              cardPins={cardPins}
              fileReviews={fileReviews}
              cardReviews={cardReviews}
              submitted={submitted}
              onSelect={(id) => { setSelectedItemId(id); setGalleryMode(false) }}
            />
          )}

          {/* ── Single ad view ───────────────────────────────────────────────── */}
          {!galleryMode && (<>

          {/* Atmospheric background — blurred ad creative, fades as card switches */}
          {!isFileSelected && selectedFile && isSocial(mediaType) && !isVideoUrl(resolveFileUrl(selectedFile.file_url)) && (
            <div
              key={selectedFile.id}
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `url(${resolveFileUrl(selectedFile.file_url)})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                filter: 'blur(80px) saturate(1.2)',
                opacity: 0.13,
                transform: 'scale(1.15)',
                animation: 'fadeAtmo 0.8s ease forwards',
              }}
            />
          )}
          <style>{`@keyframes fadeAtmo { from { opacity: 0 } to { opacity: 0.13 } }`}</style>

          <div className="flex-1 overflow-y-auto flex flex-col lg:flex-row items-center justify-start lg:justify-center p-4 pb-24 lg:p-8 relative">
            {/* Device toggle — social ads + carousels + manually-uploaded social files */}
            {(isSocial(mediaType) || isCarousel(mediaType) || (isFileSelected && selectedFile_?.render_mode === 'social')) && (
              <div className="relative mb-3 lg:mb-0 lg:absolute lg:top-4 lg:left-1/2 lg:-translate-x-1/2 z-10 flex items-center gap-0.5 rounded-lg p-0.5"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <button
                  onClick={() => setViewMode('mobile')}
                  title="Mobile view"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all ${viewMode === 'mobile' ? 'bg-white/15 text-white' : 'text-white/30 hover:text-white/60'}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="7" y="2" width="10" height="20" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
                    <line x1="12" y1="18" x2="12.01" y2="18" strokeLinecap="round" />
                  </svg>
                  Mobile
                </button>
                <button
                  onClick={() => setViewMode('desktop')}
                  title="Desktop view"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold transition-all ${viewMode === 'desktop' ? 'bg-white/15 text-white' : 'text-white/30 hover:text-white/60'}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" strokeLinecap="round" strokeLinejoin="round" />
                    <line x1="8" y1="21" x2="16" y2="21" strokeLinecap="round" />
                    <line x1="12" y1="17" x2="12" y2="21" strokeLinecap="round" />
                  </svg>
                  Desktop
                </button>
              </div>
            )}
            {/* Writer-only: edit this creative's copy + graphic (staff only, hidden from clients) */}
            {canEdit && isFileSelected && selectedFile_ && (
              <button
                onClick={() => openCopyEditor(selectedFile_)}
                title="Edit this creative — copy + graphic (staff only)"
                className="absolute top-3 right-3 lg:top-4 lg:right-4 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-semibold text-white/70 hover:text-white transition-all"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit
              </button>
            )}
            {/* Ambient glow under phone */}
            <div className="relative">
              {(isSocial(mediaType) || isCarousel(mediaType)) && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    inset: '-40px',
                    background: 'radial-gradient(ellipse at 50% 60%, rgba(124,58,237,0.18) 0%, rgba(6,182,212,0.08) 40%, transparent 70%)',
                    filter: 'blur(20px)',
                    zIndex: 0,
                  }}
                />
              )}
              <div className="relative" style={{ zIndex: 1 }}>
                {(() => {
                  const showGallery = !isFileSelected && isPerSizeCard(mediaType, cardFiles.length) && !onlyFileId
                  if (!showGallery) return adMockup

                  const currIdx = cardFiles.findIndex(f => f.id === (selectedFileId ?? cardFiles[0]?.id))
                  const prevFile = cardFiles[(currIdx - 1 + cardFiles.length) % cardFiles.length]
                  const nextFile = cardFiles[(currIdx + 1) % cardFiles.length]
                  const currDim = cardFiles[currIdx]?.file_name.match(/(\d+)[x×](\d+)/i)
                  const cW = currDim ? parseInt(currDim[1]) : null
                  const cH = currDim ? parseInt(currDim[2]) : null

                  const ghostPlaceholder = (file: typeof cardFiles[0], side: 'left' | 'right') => {
                    const sd = file.file_name.match(/(\d+)[x×](\d+)/i)
                    const gw = sd ? parseInt(sd[1]) : 300
                    const gh = sd ? parseInt(sd[2]) : 250
                    return (
                      <div key={file.id} style={{
                        position: 'absolute', top: '50%',
                        ...(side === 'left' ? { right: 'calc(100% + 22px)' } : { left: 'calc(100% + 22px)' }),
                        transform: `translateY(-50%) perspective(750px) rotateY(${side === 'left' ? 44 : -44}deg) scale(0.56)`,
                        transformOrigin: side === 'left' ? 'right center' : 'left center',
                        opacity: 0.28, filter: 'blur(2.5px)', pointerEvents: 'none', zIndex: 0,
                        width: gw, height: gh, borderRadius: 10,
                        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
                        overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <div style={{ position: 'absolute', inset: 0, zIndex: 1,
                          background: side === 'left'
                            ? 'linear-gradient(to left, rgba(0,0,0,0.0) 30%, rgba(0,0,0,0.6))'
                            : 'linear-gradient(to right, rgba(0,0,0,0.0) 30%, rgba(0,0,0,0.6))',
                        }} />
                        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.22)', fontFamily: 'monospace', position: 'relative', zIndex: 2 }}>{gw}×{gh}</span>
                      </div>
                    )
                  }

                  const arrowBtn = (dir: 'prev' | 'next') => (
                    <div style={{
                      position: 'absolute',
                      ...(dir === 'prev' ? { right: 'calc(100% + 14px)' } : { left: 'calc(100% + 14px)' }),
                      top: '50%', transform: 'translateY(-50%)', zIndex: 30,
                    }}>
                      <button
                        onClick={() => navigateFile(dir)}
                        className="w-10 h-10 rounded-full flex items-center justify-center hover:scale-[1.08] active:scale-[0.90]"
                        style={{
                          background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
                          backdropFilter: 'blur(20px)',
                          boxShadow: '0 4px 20px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.1)',
                          transition: 'transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1), background 160ms ease, box-shadow 160ms ease',
                          cursor: 'pointer', color: 'rgba(255,255,255,0.85)',
                        }}
                      >
                        {dir === 'prev'
                          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                        }
                      </button>
                    </div>
                  )

                  return (
                    <div style={{ position: 'relative', zIndex: 1, ...(cW ? { width: cW } : {}), ...(cH ? { height: cH } : {}) }}>
                      {ghostPlaceholder(prevFile, 'left')}
                      {arrowBtn('prev')}
                      <PinOverlay
                        pins={subFilePins[cardFiles[currIdx].id] ?? []}
                        onAddPin={(x, y, note) => addSubFilePin(cardFiles[currIdx].id, x, y, note)}
                        onUpdatePin={(pinId, note) => updateSubFilePin(cardFiles[currIdx].id, pinId, note)}
                        onRemovePin={(pinId) => removeSubFilePin(cardFiles[currIdx].id, pinId)}
                        readOnly={isReadOnly}
                        pinningEnabled={!!needsChangesMode[cardFiles[currIdx].id] || (subFilePins[cardFiles[currIdx].id] ?? []).length > 0}
                      >
                        <DisplayMockup
                          fileUrl={resolveFileUrl(cardFiles[currIdx].file_url)}
                          title={card?.title ?? 'Preview'}
                          hoveredSection={hoveredSection}
                          externalReplayKey={galleryReplayKeys[cardFiles[currIdx].id] ?? 0}
                        />
                      </PinOverlay>
                      {arrowBtn('next')}
                      {ghostPlaceholder(nextFile, 'right')}
                    </div>
                  )
                })()}
              </div>
            </div>
          </div>

          </>)}
        </div>

        {/* Right — review panel (hidden in gallery mode).
            Desktop (lg+) is the inline 340px column; below lg it becomes a bottom sheet. */}
        {!galleryMode && (<>
        {mobileReviewOpen && (
          <div className="fixed inset-0 bg-black/40 z-20 lg:hidden" onClick={() => setMobileReviewOpen(false)} />
        )}
        <aside className={`fixed inset-x-0 bottom-0 z-30 rounded-t-2xl border-t border-white/[0.08] bg-[#111214] flex flex-col overflow-hidden lg:static lg:w-[340px] lg:flex-none lg:rounded-none lg:border-t-0 lg:border-l lg:h-auto ${mobileReviewOpen ? 'h-[85vh]' : 'h-auto'}`}>
          {/* Mobile grabber / summary bar — tap to expand or collapse the sheet */}
          <button
            onClick={() => setMobileReviewOpen(o => !o)}
            className="lg:hidden flex-none w-full flex items-center gap-2 px-5 py-3 border-b border-white/[0.06] text-left"
          >
            <p className="text-sm font-semibold text-white truncate flex-1 min-w-0">
              {isFileSelected ? selectedFile_?.file_name : (card?.title ?? 'Review')}
            </p>
            <StatusBadge status={
              submitted.has(selectedItem?.id ?? '')
                ? (selectedItemApproved ? 'approved' : 'needs_revision')
                : (selectedItem?.data.status ?? 'pending')
            } />
            <svg className={`w-4 h-4 flex-none text-white/40 transition-transform ${mobileReviewOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
            </svg>
          </button>
          {/* Existing panel content — always shown at lg; below lg only when the sheet is expanded */}
          <div className={`${mobileReviewOpen ? 'flex' : 'hidden'} lg:flex flex-col min-h-0 flex-1 overflow-hidden`}>
          <div className="flex-none px-5 py-4 border-b border-white/[0.06]">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-white truncate pr-2">
                {isFileSelected ? selectedFile_?.file_name : (card?.title ?? 'Review')}
              </p>
              <StatusBadge status={
                submitted.has(selectedItem?.id ?? '')
                  ? (selectedItemApproved ? 'approved' : 'needs_revision')
                  : (selectedItem?.data.status ?? 'pending')
              } />
            </div>
            <p className="text-[11px] text-white/40 mt-0.5">
              {isReadOnly
                ? `Reviewed by ${isFileSelected ? (selectedFile_?.client_notes?.reviewer ?? 'client') : (selectedCampaignCard?.client_notes?.reviewer ?? 'client')}`
                : 'Approve this creative or note what needs to change.'}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
            {isFileSelected ? (
              // ── Simplified file review ────────────────────────────────────────
              <>
              <div className="rounded-xl overflow-hidden border border-white/[0.08]">
                {/* Branded header */}
                <div className="px-4 pt-3 pb-3" style={{ background: 'linear-gradient(135deg, rgba(124,58,237,0.25) 0%, rgba(6,182,212,0.15) 100%)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-white/80 uppercase tracking-wider">Creative Review</span>
                    {fileReviewForSelected.status === 'approved' && (
                      <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">Approved</span>
                    )}
                    {(filePins[selectedFile_?.id ?? ''] ?? []).length > 0 && (
                      <span className="text-[10px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{(filePins[selectedFile_?.id ?? ''] ?? []).length} pin{(filePins[selectedFile_?.id ?? ''] ?? []).length !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-white/40 mt-0.5">Does this display creative look correct?</p>
                </div>
                {!isReadOnly && (
                  <div className="px-4 py-3 flex gap-2">
                    <button
                      onClick={() => {
                        setFileReviews(r => ({ ...r, [selectedFile_!.id]: { ...r[selectedFile_!.id], status: fileReviewForSelected.status === 'approved' ? 'pending' : 'approved', note: '' } }))
                        setNeedsChangesMode(prev => ({ ...prev, [selectedFile_!.id]: false }))
                      }}
                      disabled={(filePins[selectedFile_?.id ?? ''] ?? []).length > 0}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                        fileReviewForSelected.status === 'approved'
                          ? 'border-emerald-500/50 text-emerald-300'
                          : 'border-white/10 text-white/60 hover:text-white hover:border-white/25 hover:bg-white/[0.05]'
                      }`}
                      style={fileReviewForSelected.status === 'approved' ? { background: 'rgba(16,185,129,0.15)' } : {}}
                    >
                      {fileReviewForSelected.status === 'approved' ? '✓ Approved' : '✓ Approve'}
                    </button>
                    <button
                      onClick={() => {
                        setFileReviews(r => ({ ...r, [selectedFile_!.id]: { ...r[selectedFile_!.id], status: 'changes' } }))
                        setNeedsChangesMode(prev => ({ ...prev, [selectedFile_!.id]: !prev[selectedFile_!.id] }))
                      }}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all ${
                        fileReviewForSelected.status === 'changes' || needsChangesMode[selectedFile_?.id ?? '']
                          ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                          : 'border-white/10 text-white/60 hover:text-white hover:border-white/25 hover:bg-white/[0.05]'
                      }`}
                    >✗ Needs changes</button>
                  </div>
                )}
                {/* Instruction banner when needs-changes mode is active */}
                {!isReadOnly && needsChangesMode[selectedFile_?.id ?? ''] && (
                  <div className="mx-4 mb-3 rounded-lg px-3 py-2.5 flex items-start gap-2.5" style={{ background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.3)' }}>
                    <svg className="w-3.5 h-3.5 text-[#a78bfa] flex-none mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                    </svg>
                    <p className="text-[11px] text-[#a78bfa] leading-relaxed">Click anywhere on the ad to drop a pin and describe the change needed.</p>
                  </div>
                )}
                {fileReviewForSelected.status === 'approved' && isReadOnly && (
                  <div className="px-4 pb-3">
                    <p className="text-[11px] text-emerald-400/50 italic">Approved by client</p>
                  </div>
                )}
              </div>


              {/* File pin list */}
              {(() => {
                const fileId = selectedFile_?.id ?? ''
                const livePins = filePins[fileId] ?? []
                const isFileSubmitted = submitted.has(fileId) || sessionSubmitted
                if (livePins.length === 0) return null
                return (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider px-1">
                      Pinned Notes · {livePins.length}
                    </p>
                    {livePins.map((pin, i) => {
                      const pStatus = pinStatuses[pin.id]
                      return (
                        <div key={pin.id} className={`rounded-xl border p-3 space-y-2.5 transition-all ${
                          pStatus === 'resolved' ? 'border-emerald-500/25 bg-emerald-500/[0.04]' :
                          pStatus === 'pending' ? 'border-amber-500/25 bg-amber-500/[0.04]' :
                          'border-white/[0.08] bg-white/[0.03]'
                        }`}>
                          <div className="flex items-start gap-2.5">
                            <span className="flex-none w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white mt-0.5" style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)' }}>{i + 1}</span>
                            <p className="flex-1 text-[11px] text-white/70 leading-relaxed min-w-0">
                              {pin.note || <span className="italic text-white/25">No note</span>}
                            </p>
                            {!isFileSubmitted && (
                              <button
                                onClick={() => removePin(fileId, pin.id)}
                                className="flex-none text-[10px] text-white/20 hover:text-rose-400 transition-colors"
                                title="Remove pin"
                              >✕</button>
                            )}
                          </div>
                          {pStatus === 'pending' && pendingPinNotes[pin.id] && (
                            <p className="text-[10px] text-amber-300/70 bg-amber-500/[0.08] rounded-lg px-2.5 py-1.5 italic leading-relaxed">{pendingPinNotes[pin.id]}</p>
                          )}
                          {/* Status row */}
                          <div className="flex gap-1.5 pt-0.5">
                            <button
                              onClick={() => togglePinResolved(pin.id)}
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-all ${
                                pStatus === 'resolved'
                                  ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                  : 'border-white/10 text-white/35 hover:text-emerald-300 hover:border-emerald-500/30'
                              }`}
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                              Resolved
                            </button>
                            <button
                              onClick={() => setEditingPendingPin(editingPendingPin === pin.id ? null : pin.id)}
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-all ${
                                pStatus === 'pending' || editingPendingPin === pin.id
                                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                                  : 'border-white/10 text-white/35 hover:text-amber-300 hover:border-amber-500/30'
                              }`}
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                              Pending
                            </button>
                            {pStatus === 'pending' && (
                              <button onClick={() => clearPinPending(pin.id)} className="px-2 py-1 rounded-lg text-[10px] text-white/25 hover:text-white/50 border border-white/[0.06] transition-colors">Clear</button>
                            )}
                          </div>
                          {editingPendingPin === pin.id && (
                            <div className="space-y-1.5">
                              <textarea
                                autoFocus
                                defaultValue={pendingPinNotes[pin.id] ?? ''}
                                placeholder="Why is this pending? (e.g. waiting on new graphic from client)"
                                rows={2}
                                id={`pending-note-${pin.id}`}
                                className="w-full text-[11px] bg-white/[0.05] border border-amber-500/20 rounded-lg px-2.5 py-2 text-white placeholder-white/20 focus:outline-none focus:border-amber-400/40 resize-none"
                              />
                              <button
                                onClick={() => {
                                  const el = document.getElementById(`pending-note-${pin.id}`) as HTMLTextAreaElement | null
                                  setPinPending(pin.id, el?.value ?? '')
                                }}
                                className="w-full py-1.5 rounded-lg text-[10px] font-bold text-amber-300 border border-amber-500/30 bg-amber-500/[0.08] transition-colors hover:bg-amber-500/[0.15]"
                              >Save pending reason</button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}

              {/* Instruction to pin — file review */}
              {!isReadOnly && (filePins[selectedFile_?.id ?? ''] ?? []).length === 0 && (
                <div className="flex items-center gap-2 px-1 py-1">
                  <svg className="w-3.5 h-3.5 text-white/20 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                  </svg>
                  <p className="text-[11px] text-white/25">Click anywhere on the ad to pin a note</p>
                </div>
              )}
              </>
            ) : (
              // ── Card review — pin-based ───────────────────────────────────────
              (() => {
                // Multi-file display card → per-size review + per-size pin catalog.
                if (isPerSizeCard(mediaType, cardFiles.length) && selectedFile) {
                  const fileId = selectedFile.id
                  const livePins = subFilePins[fileId] ?? []
                  const approved = !!subFileApproved[fileId]
                  const inChangesMode = !!needsChangesMode[fileId]
                  const sizeStatus: 'approved' | 'changes' | 'pending' = livePins.length > 0 ? 'changes' : approved ? 'approved' : 'pending'
                  const reviewedSizes = cardFiles.filter(f => (subFilePins[f.id] ?? []).length > 0 || subFileApproved[f.id]).length
                  const currentSizeIdx = cardFiles.findIndex(f => f.id === fileId)
                  return (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between px-1">
                        <span className="text-[10px] font-semibold text-white/30 uppercase tracking-wider">Size {currentSizeIdx + 1} of {cardFiles.length}</span>
                        <span className="text-[10px] text-white/40">{reviewedSizes}/{cardFiles.length} reviewed</span>
                      </div>

                      <div className="rounded-xl overflow-hidden border border-white/[0.08]">
                        <div className="px-4 pt-3 pb-3" style={{ background: 'linear-gradient(135deg, rgba(124,58,237,0.25) 0%, rgba(6,182,212,0.15) 100%)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-bold text-white/80 uppercase tracking-wider">Creative Review</span>
                            {sizeStatus === 'approved' && <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">Approved</span>}
                            {livePins.length > 0 && <span className="text-[10px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{livePins.length} pin{livePins.length !== 1 ? 's' : ''}</span>}
                          </div>
                          <p className="text-[11px] text-white/40 mt-0.5 truncate">{selectedFile.file_name}</p>
                        </div>
                        {!isReadOnly && (
                          <div className="px-4 py-3 flex gap-2">
                            <button
                              onClick={() => toggleSubFileApprove(fileId)}
                              disabled={livePins.length > 0}
                              className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${approved ? 'border-emerald-500/50 text-emerald-300' : 'border-white/10 text-white/60 hover:text-white hover:border-white/25 hover:bg-white/[0.05]'}`}
                              style={approved ? { background: 'rgba(16,185,129,0.15)' } : {}}
                            >{approved ? '✓ Approved' : '✓ Approve'}</button>
                            <button
                              onClick={() => setNeedsChangesMode(prev => ({ ...prev, [fileId]: !prev[fileId] }))}
                              className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all ${livePins.length > 0 || inChangesMode ? 'bg-amber-500/15 border-amber-500/40 text-amber-300' : 'border-white/10 text-white/60 hover:text-white hover:border-white/25 hover:bg-white/[0.05]'}`}
                            >✗ Needs changes</button>
                          </div>
                        )}
                        {!isReadOnly && inChangesMode && livePins.length === 0 && (
                          <div className="mx-4 mb-3 rounded-lg px-3 py-2.5 flex items-start gap-2.5" style={{ background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.3)' }}>
                            <svg className="w-3.5 h-3.5 text-[#a78bfa] flex-none mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                            </svg>
                            <p className="text-[11px] text-[#a78bfa] leading-relaxed">Click anywhere on this size to drop a pin and describe the change needed.</p>
                          </div>
                        )}
                      </div>

                      {livePins.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider px-1">Pinned Notes · {livePins.length}</p>
                          {livePins.map((pin, i) => (
                            <div key={pin.id} className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
                              <div className="flex items-start gap-2.5">
                                <span className="flex-none w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white mt-0.5" style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)' }}>{i + 1}</span>
                                <p className="flex-1 text-[11px] text-white/70 leading-relaxed min-w-0">{pin.note || <span className="italic text-white/25">No note</span>}</p>
                                {!isReadOnly && (
                                  <button onClick={() => removeSubFilePin(fileId, pin.id)} className="flex-none text-[10px] text-white/20 hover:text-rose-400 transition-colors" title="Remove pin">✕</button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {!isReadOnly && livePins.length === 0 && !inChangesMode && sizeStatus === 'pending' && (
                        <p className="text-[11px] text-white/25 px-1">Approve this size, or click &ldquo;Needs changes&rdquo; to pin edits.</p>
                      )}

                      <ChangeHistorySection
                        history={selectedCampaignCard?.client_notes?.history ?? []}
                        reviewer={selectedCampaignCard?.client_notes?.reviewer ?? null}
                      />
                    </div>
                  )
                }
                const cardId = selectedCampaignCard?.id ?? ''
                const livePins = cardPins[cardId] ?? []
                const submittedPins = (selectedCampaignCard?.client_notes?.pins ?? []) as Pin[]
                const isCardSubmitted = submitted.has(cardId)
                const allPins = isCardSubmitted ? submittedPins : livePins
                const resolved = resolvedPins[cardId] ?? []
                const reviewer = isCardSubmitted
                  ? (selectedCampaignCard?.client_notes?.reviewer ?? 'Client')
                  : (identityConfirmed ? identityName : 'You')
                const submittedAt = selectedCampaignCard?.client_notes?.submitted_at
                const openPins = allPins.filter(p => !resolved.includes(p.id))
                const donePins = allPins.filter(p => resolved.includes(p.id))
                const viewPins = commentTab === 'comments' ? openPins : donePins

                return (
                  <div className="space-y-3">
                    {/* Review header with Approve / Needs changes — only before submit */}
                    {!isReadOnly && (
                      <div className="rounded-xl overflow-hidden border border-white/[0.08]">
                        <div className="px-4 pt-3 pb-3" style={{ background: 'linear-gradient(135deg, rgba(124,58,237,0.25) 0%, rgba(6,182,212,0.15) 100%)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-bold text-white/80 uppercase tracking-wider">Creative Review</span>
                            {cardReviewForSelected.status === 'approved' && (
                              <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">Approved</span>
                            )}
                            {livePins.length > 0 && (
                              <span className="text-[10px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{livePins.length} pin{livePins.length !== 1 ? 's' : ''}</span>
                            )}
                          </div>
                          <p className="text-[11px] text-white/40 mt-0.5">Approve or mark what needs to change</p>
                        </div>
                        <div className="px-4 py-3 flex gap-2">
                          <button
                            onClick={() => {
                              setCardReviews(r => ({ ...r, [cardId]: { ...r[cardId], status: cardReviewForSelected.status === 'approved' ? 'pending' : 'approved', note: '' } }))
                              setNeedsChangesMode(prev => ({ ...prev, [cardId]: false }))
                            }}
                            disabled={livePins.length > 0}
                            className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                              cardReviewForSelected.status === 'approved'
                                ? 'border-emerald-500/50 text-emerald-300'
                                : 'border-white/10 text-white/60 hover:text-white hover:border-white/25 hover:bg-white/[0.05]'
                            }`}
                            style={cardReviewForSelected.status === 'approved' ? { background: 'rgba(16,185,129,0.15)' } : {}}
                          >
                            {cardReviewForSelected.status === 'approved' ? '✓ Approved' : '✓ Approve'}
                          </button>
                          <button
                            onClick={() => setNeedsChangesMode(prev => ({ ...prev, [cardId]: !prev[cardId] }))}
                            className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all ${
                              livePins.length > 0 || needsChangesMode[cardId]
                                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                                : 'border-white/10 text-white/60 hover:text-white hover:border-white/25 hover:bg-white/[0.05]'
                            }`}
                          >✗ Needs changes</button>
                        </div>
                        {needsChangesMode[cardId] && livePins.length === 0 && (
                          <div className="mx-4 mb-3 rounded-lg px-3 py-2.5 flex items-start gap-2.5" style={{ background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.3)' }}>
                            <svg className="w-3.5 h-3.5 text-[#a78bfa] flex-none mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                            </svg>
                            <p className="text-[11px] text-[#a78bfa] leading-relaxed">Click anywhere on the ad to drop a pin and describe the change needed.</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Live pin list (pre-submit) */}
                    {livePins.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-[10px] font-semibold text-white/30 uppercase tracking-wider px-1">
                          Pinned Notes · {livePins.length}
                        </p>
                        {livePins.map((pin, i) => {
                          const pStatus = pinStatuses[pin.id]
                          return (
                            <div key={pin.id} className={`rounded-xl border p-3 space-y-2.5 transition-all ${
                              pStatus === 'resolved' ? 'border-emerald-500/25 bg-emerald-500/[0.04]' :
                              pStatus === 'pending' ? 'border-amber-500/25 bg-amber-500/[0.04]' :
                              'border-white/[0.08] bg-white/[0.03]'
                            }`}>
                              <div className="flex items-start gap-2.5">
                                <span className="flex-none w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white mt-0.5" style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)' }}>{i + 1}</span>
                                <div className="flex-1 min-w-0">
                                  {slideLabel(pin.slide_id) && (
                                    <span className="inline-block mb-0.5 text-[9px] font-semibold uppercase tracking-wider text-cyan-300/80 bg-cyan-500/10 px-1.5 py-0.5 rounded-full">{slideLabel(pin.slide_id)}</span>
                                  )}
                                  <p className="text-[11px] text-white/70 leading-relaxed">
                                    {pin.note || <span className="italic text-white/25">No note</span>}
                                  </p>
                                </div>
                                {!isCardSubmitted && (
                                  <button
                                    onClick={() => removeCardPin(cardId, pin.id)}
                                    className="flex-none text-[10px] text-white/20 hover:text-rose-400 transition-colors"
                                    title="Remove pin"
                                  >✕</button>
                                )}
                              </div>
                              {pStatus === 'pending' && pendingPinNotes[pin.id] && (
                                <p className="text-[10px] text-amber-300/70 bg-amber-500/[0.08] rounded-lg px-2.5 py-1.5 italic leading-relaxed">{pendingPinNotes[pin.id]}</p>
                              )}
                              <div className="flex gap-1.5 pt-0.5">
                                <button
                                  onClick={() => togglePinResolved(pin.id)}
                                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-all ${
                                    pStatus === 'resolved'
                                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                      : 'border-white/10 text-white/35 hover:text-emerald-300 hover:border-emerald-500/30'
                                  }`}
                                >
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                                  Resolved
                                </button>
                                <button
                                  onClick={() => setEditingPendingPin(editingPendingPin === pin.id ? null : pin.id)}
                                  className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-all ${
                                    pStatus === 'pending' || editingPendingPin === pin.id
                                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                                      : 'border-white/10 text-white/35 hover:text-amber-300 hover:border-amber-500/30'
                                  }`}
                                >
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                  Pending
                                </button>
                                {pStatus === 'pending' && (
                                  <button onClick={() => clearPinPending(pin.id)} className="px-2 py-1 rounded-lg text-[10px] text-white/25 hover:text-white/50 border border-white/[0.06] transition-colors">Clear</button>
                                )}
                              </div>
                              {editingPendingPin === pin.id && (
                                <div className="space-y-1.5">
                                  <textarea
                                    autoFocus
                                    defaultValue={pendingPinNotes[pin.id] ?? ''}
                                    placeholder="Why is this pending? (e.g. waiting on new graphic from client)"
                                    rows={2}
                                    id={`card-pending-note-${pin.id}`}
                                    className="w-full text-[11px] bg-white/[0.05] border border-amber-500/20 rounded-lg px-2.5 py-2 text-white placeholder-white/20 focus:outline-none focus:border-amber-400/40 resize-none"
                                  />
                                  <button
                                    onClick={() => {
                                      const el = document.getElementById(`card-pending-note-${pin.id}`) as HTMLTextAreaElement | null
                                      setPinPending(pin.id, el?.value ?? '')
                                    }}
                                    className="w-full py-1.5 rounded-lg text-[10px] font-bold text-amber-300 border border-amber-500/30 bg-amber-500/[0.08] transition-colors hover:bg-amber-500/[0.15]"
                                  >Save pending reason</button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* Post-submit: Comments / Resolved tabs */}
                    {isCardSubmitted && allPins.length > 0 && (
                      <div className="rounded-xl border border-white/[0.08] overflow-hidden">
                        <div className="flex border-b border-white/[0.06]">
                          <button
                            onClick={() => setCommentTab('comments')}
                            className={`flex-1 py-2 text-[11px] font-semibold transition-all ${commentTab === 'comments' ? 'bg-white/[0.06] text-white' : 'text-white/40 hover:text-white/60'}`}
                          >
                            Comments {openPins.length > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px]" style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)', color: 'white' }}>{openPins.length}</span>}
                          </button>
                          <button
                            onClick={() => setCommentTab('resolved')}
                            className={`flex-1 py-2 text-[11px] font-semibold transition-all ${commentTab === 'resolved' ? 'bg-white/[0.06] text-white' : 'text-white/40 hover:text-white/60'}`}
                          >
                            Resolved {donePins.length > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px]">{donePins.length}</span>}
                          </button>
                        </div>
                        <div className="p-3 space-y-2">
                          {viewPins.length === 0 ? (
                            <p className="text-[11px] text-white/25 italic text-center py-2">
                              {commentTab === 'comments' ? 'All comments resolved ✓' : 'No resolved comments yet'}
                            </p>
                          ) : viewPins.map(pin => {
                            const globalIdx = allPins.indexOf(pin)
                            const isResolved = resolved.includes(pin.id)
                            return (
                              <div key={pin.id} className={`rounded-xl border p-3 transition-all ${isResolved ? 'border-emerald-500/20 bg-emerald-500/[0.04]' : 'border-white/[0.08] bg-white/[0.03]'}`}>
                                <div className="flex items-start gap-2.5">
                                  <div className="flex-none w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)' }}>
                                    {reviewer.charAt(0).toUpperCase()}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5 mb-0.5">
                                      <span className="text-[11px] font-semibold text-white">{reviewer}</span>
                                      <span className="flex-none w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white" style={{ background: 'linear-gradient(135deg,#7c3aed,#06b6d4)' }}>{globalIdx + 1}</span>
                                      {slideLabel(pin.slide_id) && (
                                        <span className="text-[9px] font-semibold uppercase tracking-wider text-cyan-300/80 bg-cyan-500/10 px-1.5 py-0.5 rounded-full">{slideLabel(pin.slide_id)}</span>
                                      )}
                                      {submittedAt && <span className="text-[10px] text-white/25">{new Date(submittedAt).toLocaleDateString()}</span>}
                                    </div>
                                    <p className="text-[11px] text-white/60 leading-relaxed">
                                      {pin.note || <span className="italic text-white/25">No note</span>}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => void toggleResolvePin(cardId, pin.id)}
                                    title={isResolved ? 'Unresolve' : 'Mark as done'}
                                    className={`flex-none w-6 h-6 rounded-full border flex items-center justify-center transition-all ${isResolved ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-400' : 'border-white/15 text-white/25 hover:border-emerald-500/40 hover:text-emerald-400'}`}
                                  >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* Approved state (submitted) */}
                    {isCardSubmitted && allPins.length === 0 && (
                      <p className="text-[11px] text-emerald-400/60 italic px-1">✓ Approved by client</p>
                    )}

                    <ChangeHistorySection
                      history={selectedCampaignCard?.client_notes?.history ?? []}
                      reviewer={reviewer === 'You' ? null : reviewer}
                    />
                  </div>

                )
              })()
            )}
          </div>

          {/* Submit All Feedback — client-only. Staff (canEdit) review internally and
              just mark pins resolved; they never need to fire the client-facing
              submit/email flow, so the whole footer is hidden for them. */}
          {!canEdit && (
          <div className="flex-none px-4 py-4 border-t border-white/[0.08]">

            <div className="space-y-3">
              {savedAt !== null && (
                <p className="text-[11px] text-emerald-400/80 text-center flex items-center justify-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                  Saved
                </p>
              )}
              {sessionSubmitted && (
                <p className="text-[11px] text-emerald-400 text-center">✓ Feedback submitted — you can still add more</p>
              )}
              {!anyActioned && !sessionSubmitted && (
                <p className="text-[11px] text-white/30 text-center">
                  {scopeLocationName
                    ? 'Leave your notes here if you like, or just reply to our email — either works.'
                    : `Review at least one item to submit — ${reviewedUnitCount} of ${reviewUnits.length} done`}
                </p>
              )}
              {anyActioned && !allActioned && !sessionSubmitted && (
                <p className="text-[11px] text-white/30 text-center">
                  {reviewedUnitCount} of {reviewUnits.length} reviewed — unreviewed items stay pending, come back anytime
                </p>
              )}
              <button
                onClick={() => setShowConfirmModal(true)}
                disabled={!anyActioned || submitting === 'all'}
                className="w-full py-3.5 rounded-xl text-sm font-bold transition-all disabled:opacity-35 disabled:cursor-not-allowed shadow-lg"
                style={anyActioned
                  ? { background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)', color: 'white', boxShadow: '0 4px 24px rgba(124,58,237,0.35)' }
                  : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.25)' }}
              >
                {submitting === 'all' ? 'Submitting…' : sessionSubmitted ? 'Submit Additional Feedback' : 'Submit All Feedback'}
              </button>
            </div>
          </div>
          )}
          </div>
        </aside>
        </>)}
      </div>

      {/* Confirm-summary modal — shown before the real submit/email fires */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-md rounded-2xl border border-white/15 flex flex-col max-h-[80vh]" style={{ background: 'rgba(18,16,26,0.97)' }}>
            <div className="p-6 pb-3">
              <h2 className="text-lg font-semibold text-white mb-1">Submit your review?</h2>
              <p className="text-[13px] text-white/40">This sends your feedback to the FTE team. Here&rsquo;s what you&rsquo;re submitting:</p>
            </div>
            <div className="px-6 overflow-y-auto flex-1 space-y-1">
              {reviewUnits.filter(u => u.status !== 'pending').map(u => (
                <div key={u.key} className="flex items-center justify-between gap-3 py-1.5 border-b border-white/[0.05]">
                  <span className="text-[12px] text-white/70 truncate">{u.label}</span>
                  <span className="flex-none">
                    {u.status === 'approved'
                      ? <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full">Approved</span>
                      : <span className="text-[10px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{u.pins} pin{u.pins !== 1 ? 's' : ''}</span>}
                  </span>
                </div>
              ))}
              {reviewUnits.some(u => u.status === 'pending') && (
                <div className="pt-3 pb-1">
                  <p className="text-[11px] font-semibold text-white/40 mb-1">
                    Not included — {reviewUnits.filter(u => u.status === 'pending').length} not yet reviewed (stays pending, come back anytime)
                  </p>
                  {reviewUnits.filter(u => u.status === 'pending').map(u => (
                    <div key={u.key} className="flex items-center justify-between gap-3 py-1.5 border-b border-white/[0.05]">
                      <span className="text-[12px] text-white/35 truncate">{u.label}</span>
                      <span className="flex-none text-[10px] font-semibold text-white/30 bg-white/[0.06] px-2 py-0.5 rounded-full">Pending</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="p-6 pt-4 flex gap-2">
              <button
                onClick={() => { setShowConfirmModal(false); void handleSubmitAll() }}
                className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white transition-opacity hover:opacity-90"
                style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
              >Submit feedback</button>
              <button
                onClick={() => setShowConfirmModal(false)}
                className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors"
              >Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Identity modal — appears on first submit */}
      {showIdentityModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-sm rounded-2xl border border-white/15 p-7 flex flex-col gap-5" style={{ background: 'rgba(18,16,26,0.97)' }}>
            <div>
              <h2 className="text-lg font-semibold text-white mb-1">Please identify yourself</h2>
              <p className="text-[13px] text-white/40">In order to submit feedback, please let us know who you are.</p>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="text-[11px] text-white/40 uppercase tracking-wider font-medium block mb-1.5">Your Name</label>
                <input
                  type="text"
                  value={identityName}
                  onChange={e => setIdentityName(e.target.value)}
                  placeholder="e.g. Maria"
                  autoFocus
                  className="w-full text-sm bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60"
                />
              </div>
              <div>
                <label className="text-[11px] text-white/40 uppercase tracking-wider font-medium block mb-1.5">Your Email</label>
                <input
                  type="email"
                  value={identityEmail}
                  onChange={e => setIdentityEmail(e.target.value)}
                  placeholder="e.g. maria@company.com"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && identityName.trim()) {
                      setIdentityConfirmed(true)
                      setShowIdentityModal(false)

                      if (pendingSubmitAfterIdentity) { setPendingSubmitAfterIdentity(false); void handleSubmitAll({ identityJustConfirmed: true }) }
                    }
                  }}
                  className="w-full text-sm bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (!identityName.trim()) return
                  setIdentityConfirmed(true)
                  setShowIdentityModal(false)

                  if (pendingSubmitAfterIdentity) { setPendingSubmitAfterIdentity(false); void handleSubmitAll({ identityJustConfirmed: true }) }
                }}
                disabled={!identityName.trim()}
                className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white disabled:opacity-40 transition-opacity"
                style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
              >
                Submit
              </button>
              <button
                onClick={() => { setShowIdentityModal(false); setPendingSubmitAfterIdentity(false) }}
                className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-submit confirmation screen */}
      {thankYou && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(10px)' }}>
          <div className="w-full max-w-md rounded-2xl border border-white/15 p-8 flex flex-col items-center text-center gap-5" style={{ background: 'rgba(18,16,26,0.98)' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/fte-logo.svg" alt="Follow The Eyes" className="h-12 w-auto flex-none" />
            <div className="w-11 h-11 rounded-full flex items-center justify-center flex-none" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
              <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            {thankYou.done ? (
              <>
                <div>
                  <h2 className="text-xl font-semibold text-white mb-1.5">You&rsquo;re all set</h2>
                  <p className="text-[13px] text-white/50 leading-relaxed">You can safely close this tab now. Thanks for your time!</p>
                </div>
                <button
                  onClick={() => setThankYou(null)}
                  className="text-[13px] text-white/45 hover:text-white transition-colors"
                >
                  Review the creatives again
                </button>
              </>
            ) : (
              <>
                <div>
                  <h2 className="text-xl font-semibold text-white mb-1.5">Thank you{identityName.trim() ? `, ${identityName.trim()}` : ''}!</h2>
                  <p className="text-[13px] text-white/55 leading-relaxed">
                    {thankYou.changes > 0
                      ? 'Your feedback has been sent. Our team will review your requests and get the changes done.'
                      : 'Thanks for approving — our team will get these built.'}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-[12px] bg-white/[0.05] rounded-xl px-4 py-2.5 border border-white/10">
                  <span className="text-white/55">{thankYou.approved + thankYou.changes} {thankYou.approved + thankYou.changes === 1 ? 'creative' : 'creatives'}</span>
                  {thankYou.approved > 0 && <span className="text-emerald-400">✓ {thankYou.approved} approved</span>}
                  {thankYou.changes > 0 && <span className="text-orange-300">✎ {thankYou.changes} with changes</span>}
                </div>
                <div className="flex flex-col gap-2 w-full pt-1">
                  <button
                    onClick={() => setThankYou(null)}
                    className="w-full text-sm font-semibold py-2.5 rounded-xl text-white transition-opacity hover:opacity-90"
                    style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
                  >
                    Review all creatives
                  </button>
                  <button
                    onClick={() => setThankYou(t => (t ? { ...t, done: true } : t))}
                    className="w-full text-sm font-medium text-white/55 hover:text-white bg-white/[0.06] rounded-xl py-2.5 transition-colors"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Writer-only: edit-copy modal for a manually-uploaded creative */}
      {editingSlide && (
        <SlideEditModal
          slide={editingSlide}
          onClose={() => setEditingSlide(null)}
          onSaved={() => { setEditingSlide(null); router.refresh() }}
        />
      )}

      {editingFileId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => { if (!savingCopy) setEditingFileId(null) }}
        >
          <div
            className="w-full max-w-md rounded-xl p-5 max-h-[90vh] overflow-y-auto"
            style={{ background: '#14141b', border: '1px solid rgba(255,255,255,0.12)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-sm font-semibold text-white">Edit creative</h3>
              <button
                onClick={() => { if (!savingCopy) setEditingFileId(null) }}
                className="text-white/40 hover:text-white text-xl leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p className="text-[11px] text-white/40 mb-4">
              Update the copy and/or drop in a new graphic. If a client already reviewed this creative, saving resets its review to pending; a new graphic also clears the old pins.
            </p>
            <div className="space-y-3">
              {/* Graphic — drop a new image/video to replace the current one on Save */}
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Graphic</label>
                <label
                  onDragOver={e => { e.preventDefault(); setGraphicDragOver(true) }}
                  onDragLeave={() => setGraphicDragOver(false)}
                  onDrop={e => {
                    e.preventDefault()
                    setGraphicDragOver(false)
                    const f = e.dataTransfer.files?.[0]
                    if (f) setGraphicDraft(f)
                  }}
                  className={`flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-3 py-4 text-center cursor-pointer transition-colors ${graphicDragOver ? 'border-teal-400 bg-teal-500/10' : 'border-white/15 hover:border-white/30 bg-white/[0.03]'}`}
                >
                  <input
                    type="file"
                    accept="image/gif,image/png,image/jpeg,image/webp,video/mp4,video/quicktime,.gif,.png,.jpg,.jpeg,.webp,.mp4,.mov"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) setGraphicDraft(f)
                      e.target.value = ''
                    }}
                  />
                  {graphicDraft ? (
                    <span className="text-xs text-teal-300 font-medium break-all">New graphic: {graphicDraft.name}</span>
                  ) : (
                    <span className="text-xs text-white/50">Drop a new image/video here, or click to choose — replaces the current graphic on Save</span>
                  )}
                  {graphicDraft && (
                    <button
                      onClick={e => { e.preventDefault(); setGraphicDraft(null) }}
                      className="text-[10px] text-white/40 hover:text-white underline"
                    >
                      Keep the current graphic
                    </button>
                  )}
                </label>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Primary text</label>
                <textarea
                  value={copyDraft.fb_body_text}
                  onChange={e => setCopyDraft(d => ({ ...d, fb_body_text: e.target.value }))}
                  rows={4}
                  className="w-full rounded-md px-3 py-2 text-xs text-white bg-white/[0.04] border border-white/10 focus:border-white/30 outline-none resize-y"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Headline</label>
                <input
                  value={copyDraft.fb_headline}
                  onChange={e => setCopyDraft(d => ({ ...d, fb_headline: e.target.value }))}
                  className="w-full rounded-md px-3 py-2 text-xs text-white bg-white/[0.04] border border-white/10 focus:border-white/30 outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Description</label>
                <input
                  value={copyDraft.fb_subheadline}
                  onChange={e => setCopyDraft(d => ({ ...d, fb_subheadline: e.target.value }))}
                  className="w-full rounded-md px-3 py-2 text-xs text-white bg-white/[0.04] border border-white/10 focus:border-white/30 outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Call to action</label>
                <input
                  value={copyDraft.fb_cta}
                  onChange={e => setCopyDraft(d => ({ ...d, fb_cta: e.target.value }))}
                  className="w-full rounded-md px-3 py-2 text-xs text-white bg-white/[0.04] border border-white/10 focus:border-white/30 outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Landing page URL</label>
                <input
                  value={copyDraft.landing_page_url}
                  onChange={e => setCopyDraft(d => ({ ...d, landing_page_url: e.target.value }))}
                  className="w-full rounded-md px-3 py-2 text-xs text-white bg-white/[0.04] border border-white/10 focus:border-white/30 outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Page name</label>
                <input
                  value={copyDraft.fb_page_name}
                  onChange={e => setCopyDraft(d => ({ ...d, fb_page_name: e.target.value }))}
                  className="w-full rounded-md px-3 py-2 text-xs text-white bg-white/[0.04] border border-white/10 focus:border-white/30 outline-none"
                />
              </div>
            </div>
            {copyError && <p className="text-xs text-rose-400 mt-3">{copyError}</p>}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setEditingFileId(null)}
                disabled={savingCopy}
                className="text-xs font-medium text-white/55 hover:text-white bg-white/[0.06] rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={saveCopy}
                disabled={savingCopy}
                className="text-xs font-semibold text-white rounded-lg px-4 py-2 transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
              >
                {savingCopy ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
