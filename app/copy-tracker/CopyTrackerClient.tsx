'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { ArchiveEntry, ArchiveFile, Client, LineageRun } from '@/types'
import { withHttpsScheme } from '@/lib/url'

const FlightsTab = dynamic(() => import('@/components/FlightsTab'), { ssr: false })

// ── Global styles (pulse animation for Live badge) ───────────────────────────
const LIVE_PULSE_CSS = `@keyframes ct-live-pulse{0%,100%{opacity:1}50%{opacity:0.45}}.ct-live-dot{animation:ct-live-pulse 1.6s ease-in-out infinite}`

// ── Tokens (match design system exactly) ────────────────────────────────────
const T = {
  bg: '#0f1117',
  bg2: '#12151f',
  surface: '#1a1d2e',
  surface2: '#1f2338',
  surface3: '#262b44',
  border: 'rgba(255,255,255,0.08)',
  border2: 'rgba(255,255,255,0.14)',
  divider: 'rgba(255,255,255,0.06)',
  fg: '#e7e9f2',
  fgStrong: '#f6f7fb',
  fgMuted: '#9aa0b8',
  fgSubtle: '#6a6f86',
  accent: '#4f46e5',
  accentHi: '#6366f1',
  accentSoft: 'rgba(79,70,229,0.14)',
  accentRing: 'rgba(99,102,241,0.45)',
  green: '#10b981',
  greenSoft: 'rgba(16,185,129,0.14)',
  amber: '#f59e0b',
  amberSoft: 'rgba(245,158,11,0.14)',
  red: '#ef4444',
  grayBadge: '#3a4059',
  grayBadgeSoft: 'rgba(148,158,190,0.14)',
  rSm: '6px',
  rMd: '10px',
  rLg: '14px',
  rPill: '999px',
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  font: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: string | null) {
  if (!d) return '—'
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtDateShort(d: string | null) {
  if (!d) return '—'
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function nextMonthRange() {
  const today = new Date()
  const y = today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear()
  const m = (today.getMonth() + 1) % 12
  const start = new Date(y, m, 1)
  const end = new Date(y, m + 1, 0)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  return { start: fmt(start), end: fmt(end), label }
}

function flightBasedRange(entry: ArchiveEntry) {
  if (entry.flight_start_date && entry.flight_end_date) {
    const dayMs = 24 * 60 * 60 * 1000
    const origStart = new Date(entry.flight_start_date + 'T00:00:00')
    const origEnd = new Date(entry.flight_end_date + 'T00:00:00')
    const durationDays = Math.round((origEnd.getTime() - origStart.getTime()) / dayMs)
    const newStart = new Date(origEnd.getTime() + dayMs)
    const newEnd = new Date(newStart.getTime() + durationDays * dayMs)
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    const label = newStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    return { start: fmt(newStart), end: fmt(newEnd), label }
  }
  return nextMonthRange()
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── Restart channel mapping ──────────────────────────────────────────────────
// Which "Ready for Traffic" column a re-run should land in, by media type.
// Must stay in sync with CHANNEL_COLUMN_TITLES in app/api/cards/restart/route.ts.
type RestartChannel = 'display' | 'social' | 'ctv'

const CHANNEL_LABELS: Record<RestartChannel, string> = {
  display: 'Display - Ready for Traffic',
  social: 'Social - Ready for Traffic',
  ctv: 'CTV - Ready for Traffic',
}

function defaultChannelFor(mediaType: string | null): RestartChannel {
  switch (mediaType) {
    case 'Social Ad Request':
    case 'Carousel Ad':
    case 'Organic Post':
    case 'Reel Request':
    case 'Eblast':
    case 'FB Event Cover':
      return 'social'
    case 'Video Request':
    case 'Audio Request':
      return 'ctv'
    default:
      return 'display'
  }
}

function getMonthRange(date: Date): { start: string; end: string } {
  const y = date.getFullYear(), m = date.getMonth()
  const start = new Date(y, m, 1).toISOString().slice(0, 10)
  const end = new Date(y, m + 1, 0).toISOString().slice(0, 10)
  return { start, end }
}

function getQuarterRange(date: Date): { start: string; end: string } {
  const y = date.getFullYear(), q = Math.floor(date.getMonth() / 3)
  const start = new Date(y, q * 3, 1).toISOString().slice(0, 10)
  const end = new Date(y, q * 3 + 3, 0).toISOString().slice(0, 10)
  return { start, end }
}

function getYearRange(date: Date): { start: string; end: string } {
  const y = date.getFullYear()
  return { start: `${y}-01-01`, end: `${y}-12-31` }
}

type TimelineZoom = 'month' | 'quarter' | 'year'

function getMonogram(name: string | null, abbr: string | null): string {
  if (abbr) return abbr.slice(0, 2).toUpperCase()
  if (name) return name.slice(0, 2).toUpperCase()
  return '??'
}

// Deterministic hue from client id
function clientColor(clientId: string | null): string {
  if (!clientId) return '#6366f1'
  let hash = 0
  for (let i = 0; i < clientId.length; i++) hash = clientId.charCodeAt(i) + ((hash << 5) - hash)
  const h = Math.abs(hash) % 360
  return `hsl(${h}, 65%, 55%)`
}

// ── Icons ────────────────────────────────────────────────────────────────────
function Icon({ d, size = 14, stroke = 1.6, style }: { d: string | React.ReactNode; size?: number; stroke?: number; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto', ...style }}>
      {typeof d === 'string' ? <path d={d} /> : d}
    </svg>
  )
}
const IC = {
  search: 'm21 21-4.3-4.3M10 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z',
  chevron: 'm6 9 6 6 6-6',
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 10h18M9 4v16"/></>,
  timeline: <><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="7" cy="6" r="1.2" fill="currentColor"/><circle cx="13" cy="12" r="1.2" fill="currentColor"/><circle cx="17" cy="18" r="1.2" fill="currentColor"/></>,
  close: 'M18 6 6 18M6 6l12 12',
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
  reuse: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>,
  link: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></>,
  check: 'M20 6 9 17l-5-5',
  warn: <><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></>,
  sort: 'M7 3v18M7 3 3 7M7 3l4 4M17 21V3M17 21l-4-4M17 21l4-4',
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></>,
  chevLeft: 'm15 18-6-6 6-6',
  chevRight: 'm9 18 6-6-6-6',
  pencil: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z',
  external: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></>,
}

// ── Shared mini-components ───────────────────────────────────────────────────

function btn(variant: 'primary' | 'default' | 'ghost' = 'default'): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: T.font, fontSize: 12.5, fontWeight: 500, letterSpacing: '-0.005em',
    border: `1px solid ${T.border}`, background: 'transparent', color: T.fg,
    borderRadius: T.rMd, padding: '6px 11px',
    display: 'inline-flex', alignItems: 'center', gap: 6,
    cursor: 'pointer', whiteSpace: 'nowrap', lineHeight: 1,
  }
  if (variant === 'primary') return { ...base, background: T.accent, borderColor: 'transparent', color: '#fff', boxShadow: `0 1px 0 rgba(255,255,255,0.08) inset, 0 4px 14px -4px ${T.accentRing}` }
  if (variant === 'ghost') return { ...base, borderColor: 'transparent' }
  return base
}

function ClientAvatar({ clientId, name, abbr, logoUrl, size = 22 }: { clientId: string | null; name: string | null; abbr: string | null; logoUrl: string | null; size?: number }) {
  const [imgError, setImgError] = useState(false)
  const color = clientColor(clientId)
  const mono = getMonogram(name, abbr)
  if (logoUrl && !imgError) {
    return (
      <img src={logoUrl} alt={name ?? ''} width={size} height={size}
        style={{ width: size, height: size, borderRadius: 6, objectFit: 'cover', border: `1px solid ${T.border2}`, flex: '0 0 auto' }}
        onError={() => setImgError(true)} />
    )
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: 6,
      background: color + '26', color, border: `1px solid ${color}55`,
      fontSize: size < 24 ? 9.5 : 10.5, fontWeight: 700, letterSpacing: '0.03em',
      fontFamily: T.font, flex: '0 0 auto',
    }}>{mono}</span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const defs: Record<string, { label: string; color: string; bg: string; pulse?: boolean }> = {
    approved:  { label: 'Approved',          color: T.green, bg: T.greenSoft },
    changes_requested: { label: 'Changes',   color: T.amber, bg: T.amberSoft },
    rejected:  { label: 'Rejected',          color: T.red,   bg: 'rgba(239,68,68,0.14)' },
    live:      { label: 'Live',              color: T.green, bg: T.greenSoft, pulse: true },
    archived:  { label: 'Archived',          color: T.fgSubtle, bg: 'rgba(255,255,255,0.04)' },
    none:      { label: 'Awaiting Review',   color: T.fgMuted,  bg: T.grayBadgeSoft },
    pending:   { label: 'Awaiting Review',   color: T.fgMuted,  bg: T.grayBadgeSoft },
  }
  const def = defs[status] ?? defs.none
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', fontSize: 10.5, fontWeight: 500,
      color: def.color, background: def.bg,
      border: `1px solid ${def.color === T.fgSubtle ? T.border : 'transparent'}`,
      borderRadius: T.rPill, lineHeight: 1, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: def.color }} />
      {def.label}
    </span>
  )
}

function RerunPendingPill() {
  return (
    <span
      title="Re-run requested — waiting in a Ready for Traffic column"
      style={{ fontSize: 10, color: T.amber, background: T.amberSoft, border: '1px solid rgba(245,158,11,0.3)', borderRadius: T.rPill, padding: '1px 7px', display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      <Icon d={IC.reuse} size={9} />
      Re-run pending
    </span>
  )
}

function RunPills({ lineage, activeId }: { lineage: LineageRun[]; activeId: string }) {
  return (
    <div style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      {lineage.map((r) => {
        const active = r.card_id === activeId
        return (
          <span key={r.card_id} title={`Run ${r.run_number} · ${fmtDateShort(r.flight_start_date)} → ${fmtDateShort(r.flight_end_date)}`}
            style={{
              border: `1px solid ${active ? T.accentHi : T.border}`,
              background: active ? T.accentSoft : 'transparent',
              color: active ? T.fgStrong : T.fgMuted,
              width: 18, height: 18, borderRadius: 999, fontSize: 10, fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: T.mono, padding: 0, lineHeight: 1,
            }}>{r.run_number}</span>
        )
      })}
    </div>
  )
}

function buildUtmUrl(entry: ArchiveEntry): string | null {
  const base = withHttpsScheme(entry.landing_page_url)
  if (!base) return null
  return `${base}${base.includes('?') ? '&' : '?'}utm_source=fte&utm_medium=${entry.utm_channel ?? ''}&utm_campaign=${entry.utm_campaign ?? ''}`
}

// Compact one-click UTM copy — the full URL lives in the detail drawer
function UtmCopyButton({ entry }: { entry: ArchiveEntry }) {
  const [copied, setCopied] = useState(false)
  const url = buildUtmUrl(entry)
  if (!url) return null
  const doCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 1400)
  }
  return (
    <button onClick={doCopy} title={copied ? 'Copied!' : `Copy UTM URL\n${url}`} style={{ ...btn('ghost'), padding: '3px 6px' }}>
      {copied
        ? <Icon d={IC.check} size={12} style={{ color: T.green }} />
        : <Icon d={IC.link} size={12} style={{ color: T.fgSubtle }} />}
    </button>
  )
}

// Approval badge only where it means something: active entries always show it;
// archived past ads hide the default "Awaiting Review" noise.
function showApprovalBadge(e: ArchiveEntry): boolean {
  return !e.archived || !['none', 'pending'].includes(e.approval_status)
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.fgSubtle, marginBottom: 8 }}>
      {children}
    </div>
  )
}

// ── File thumbnail strip ─────────────────────────────────────────────────────
function FilesStrip({ files, max = 4 }: { files: ArchiveFile[]; max?: number }) {
  const shown = files.slice(0, max)
  const extra = files.length - shown.length
  if (files.length === 0) {
    return (
      <div style={{ height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.bg2, borderRadius: 6, border: `1px dashed ${T.border2}` }}>
        <span style={{ fontSize: 10.5, color: T.fgSubtle }}>No files</span>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', overflow: 'hidden' }}>
      {shown.map((f) => <FileThumb key={f.id} file={f} />)}
      {extra > 0 && (
        <div style={{ width: 40, height: 50, borderRadius: 6, border: `1px dashed ${T.border2}`, color: T.fgMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10.5, fontWeight: 600, fontFamily: T.mono, flex: '0 0 auto' }}>+{extra}</div>
      )}
    </div>
  )
}

function FileThumb({ file, size = 50 }: { file: ArchiveFile; size?: number }) {
  const isImage = file.file_type?.startsWith('image/')
  const dims = file.dimensions ?? ''
  const label = (dims || file.file_name.split('.').pop()?.toUpperCase()) ?? '?'
  if (isImage && file.file_url) {
    return (
      <div style={{ width: 66, height: size, borderRadius: 6, overflow: 'hidden', border: `1px solid ${T.border}`, flex: '0 0 auto', background: T.surface }}>
        <img src={file.file_url} alt={file.file_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
    )
  }
  return (
    <div style={{ width: 66, height: size, borderRadius: 6, background: T.surface2, border: `1px solid ${T.border}`, flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
      <span style={{ fontSize: 9, fontFamily: T.mono, color: T.fgMuted, letterSpacing: '-0.01em' }}>{label}</span>
    </div>
  )
}

// Hero preview — fixed-height media area for uniform card rhythm.
// preview_image_url first, filmstrip centered as fallback; media type overlays the corner.
function HeroPreview({ entry }: { entry: ArchiveEntry }) {
  const [imgError, setImgError] = useState(false)
  const showImg = !!entry.preview_image_url && !imgError
  return (
    <div style={{ height: 130, borderRadius: 8, overflow: 'hidden', border: `1px solid ${T.border}`, background: T.surface, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {showImg ? (
        <img
          src={entry.preview_image_url!}
          alt={entry.title}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgError(true)}
        />
      ) : (
        <FilesStrip files={entry.files} max={4} />
      )}
      {entry.media_type && (
        <span style={{ position: 'absolute', top: 8, left: 8, fontSize: 10, color: T.fg, background: 'rgba(15,17,23,0.85)', border: `1px solid ${T.border2}`, borderRadius: T.rPill, padding: '2px 8px', whiteSpace: 'nowrap' }}>
          {entry.media_type}
        </span>
      )}
    </div>
  )
}

// Latest date this entry actually ran, from flight history. Today when live.
function lastRanDate(e: ArchiveEntry): string | null {
  if (e.flights.length === 0) return null
  let latest: string | null = null
  for (const s of e.flights) {
    if (s.end === null) return todayISO()
    if (!latest || s.end > latest) latest = s.end
  }
  return latest
}

// ── Grid Card ────────────────────────────────────────────────────────────────
function GridCard({ entry, onOpen, onReuse }: { entry: ArchiveEntry; onOpen: (e: ArchiveEntry) => void; onReuse: (e: ArchiveEntry) => void }) {
  return (
    <div
      onClick={() => onOpen(entry)}
      style={{
        position: 'relative',
        background: T.surface,
        border: `1px solid ${entry.is_live ? 'rgba(16,185,129,0.4)' : T.border}`,
        borderRadius: T.rLg,
        cursor: 'pointer',
        opacity: entry.archived ? 0.78 : 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: !entry.is_live && !entry.archived ? `inset 3px 0 0 ${T.accent}` : 'none',
      }}
    >
      {/* hero preview (falls back to file filmstrip) */}
      <div style={{ padding: '10px 10px 8px', background: `linear-gradient(180deg, ${T.bg2} 0%, ${T.surface} 100%)`, borderBottom: `1px solid ${T.divider}` }}>
        <HeroPreview entry={entry} />
      </div>

      {/* body */}
      <div style={{ padding: '10px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 0 }}>
        {/* client */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <ClientAvatar clientId={entry.client_id} name={entry.client_name} abbr={entry.client_abbreviation} logoUrl={entry.client_logo_url} size={18} />
          <span style={{ fontSize: 11, color: T.fgMuted, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.client_name ?? '—'}</span>
        </div>

        {/* title */}
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: T.fgStrong, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {entry.title}
        </h3>

        {/* flight + run pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, color: T.fgSubtle, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon d={IC.calendar} size={10} />
            {fmtDateShort(entry.flight_start_date)} – {fmtDateShort(entry.flight_end_date)}
          </span>
          <RunPills lineage={entry.lineage} activeId={entry.id} />
        </div>
      </div>

      {/* bottom action strip — always visible, no hover overlay */}
      <div style={{ padding: '8px 12px', borderTop: `1px solid ${T.divider}`, background: T.surface, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {showApprovalBadge(entry) && <StatusBadge status={entry.approval_status} />}
          {entry.is_live ? (
            <span style={{ fontSize: 10, color: T.green, background: T.greenSoft, border: `1px solid rgba(16,185,129,0.25)`, borderRadius: T.rPill, padding: '1px 7px', display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
              <span className="ct-live-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: T.green, display: 'inline-block', flex: '0 0 auto' }} />
              Live
            </span>
          ) : entry.archived ? (
            <span style={{ fontSize: 10, color: T.fgSubtle, background: 'rgba(255,255,255,0.04)', border: `1px solid ${T.border}`, borderRadius: T.rPill, padding: '1px 6px' }}>Archived</span>
          ) : (
            <span style={{ fontSize: 10, color: T.accentHi, background: T.accentSoft, border: `1px solid rgba(99,102,241,0.3)`, borderRadius: T.rPill, padding: '1px 6px', fontWeight: 600 }}>Active</span>
          )}
          {entry.restart_requested_at && !entry.is_live && <RerunPendingPill />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <UtmCopyButton entry={entry} />
          <button
            onClick={(e) => { e.stopPropagation(); onReuse(entry) }}
            style={{ ...btn('primary'), padding: '5px 10px', fontSize: 11.5 }}
          >
            <Icon d={IC.reuse} size={11} />
            Run again
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Table View ────────────────────────────────────────────────────────────────
type TableSortKey = 'client' | 'title' | 'type' | 'flight' | 'lastRan' | 'runs' | 'status'

// Quiet status: one colored state word, approval condensed to a dot
function TableStatus({ e }: { e: ArchiveEntry }) {
  const state = e.is_live ? { label: 'Live', color: T.green, dot: true }
    : e.restart_requested_at ? { label: '↻ Re-run pending', color: T.amber, dot: false }
    : e.archived ? { label: 'Archived', color: T.fgSubtle, dot: false }
    : { label: 'Active', color: T.accentHi, dot: false }
  const approvalMeaningful = showApprovalBadge(e) && ['approved', 'changes_requested', 'rejected'].includes(e.approval_status)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, color: state.color, whiteSpace: 'nowrap' }}>
      {state.dot && <span className="ct-live-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: state.color, display: 'inline-block', flex: '0 0 auto' }} />}
      {state.label}
      {approvalMeaningful && (
        <span
          title={e.approval_status === 'approved' ? 'Approved' : e.approval_status === 'changes_requested' ? 'Changes requested' : 'Rejected'}
          style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor(e.approval_status), flex: '0 0 auto' }}
        />
      )}
    </span>
  )
}

function TableView({ entries, onOpen, onReuse }: { entries: ArchiveEntry[]; onOpen: (e: ArchiveEntry) => void; onReuse: (e: ArchiveEntry) => void }) {
  const [sortKey, setSortKey] = useState<TableSortKey>('lastRan')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const cols: { k: TableSortKey | 'actions'; label: string; w: string }[] = [
    { k: 'client', label: 'Client', w: '140px' },
    { k: 'title', label: 'Title', w: '1fr' },
    { k: 'type', label: 'Type', w: '110px' },
    { k: 'flight', label: 'Flight', w: '140px' },
    { k: 'lastRan', label: 'Last ran', w: '80px' },
    { k: 'runs', label: 'Runs', w: '70px' },
    { k: 'status', label: 'Status', w: '120px' },
    { k: 'actions', label: '', w: '95px' },
  ]
  const grid = cols.map((c) => c.w).join(' ')

  function handleSort(k: TableSortKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(k)
      // dates read best newest-first; text columns A→Z
      setSortDir(k === 'flight' || k === 'lastRan' || k === 'runs' ? 'desc' : 'asc')
    }
  }

  const sorted = useMemo(() => {
    const val = (e: ArchiveEntry): string | number => {
      switch (sortKey) {
        case 'client': return (e.client_name ?? '').toLowerCase()
        case 'title': return e.title.toLowerCase()
        case 'type': return e.media_type ?? ''
        case 'flight': return e.flight_start_date ?? ''
        case 'lastRan': return lastRanDate(e) ?? ''
        case 'runs': return e.lineage.length
        case 'status': return (e.is_live ? 0 : e.restart_requested_at ? 1 : e.archived ? 3 : 2)
      }
    }
    const arr = [...entries]
    arr.sort((a, b) => {
      const av = val(a), bv = val(b)
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [entries, sortKey, sortDir])

  return (
    <div style={{ padding: '18px 20px 24px' }}>
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rLg, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: grid, gap: 10, padding: '10px 16px', borderBottom: `1px solid ${T.border}`, background: T.bg2, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>
          {cols.map((c) => (
            c.k === 'actions' ? <span key={c.k} /> : (
              <button
                key={c.k}
                onClick={() => handleSort(c.k as TableSortKey)}
                style={{
                  appearance: 'none', border: 'none', background: 'transparent', padding: 0,
                  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                  font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit',
                  color: sortKey === c.k ? T.accentHi : T.fgSubtle,
                }}
              >
                {c.label}
                {sortKey === c.k && (
                  <Icon d={sortDir === 'asc' ? 'M12 19V5M12 5l-5 5M12 5l5 5' : 'M12 5v14M12 19l-5-5M12 19l5-5'} size={10} stroke={2} />
                )}
              </button>
            )
          ))}
        </div>
        {sorted.length === 0 && (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: T.fgMuted, fontSize: 13 }}>No creatives match your filters.</div>
        )}
        {sorted.map((e, i) => {
          const last = lastRanDate(e)
          return (
          <div key={e.id} onClick={() => onOpen(e)} style={{
            display: 'grid', gridTemplateColumns: grid, gap: 10, alignItems: 'center',
            padding: '10px 16px', fontSize: 12.5,
            borderTop: i === 0 ? 'none' : `1px solid ${T.divider}`,
            cursor: 'pointer', opacity: e.archived && !e.restart_requested_at ? 0.78 : 1,
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <ClientAvatar clientId={e.client_id} name={e.client_name} abbr={e.client_abbreviation} logoUrl={e.client_logo_url} size={18} />
              <span style={{ color: T.fgMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.client_name ?? '—'}</span>
            </span>
            <span style={{ color: T.fgStrong, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title}</span>
            <span style={{ color: T.fgMuted, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.media_type ?? '—'}</span>
            <span style={{ color: T.fgMuted, fontSize: 11.5, fontFamily: T.mono }}>
              {fmtDateShort(e.flight_start_date)} → {fmtDateShort(e.flight_end_date)}
            </span>
            <span style={{ fontSize: 11.5, fontFamily: T.mono, color: e.is_live ? T.green : T.fgMuted }}>
              {e.is_live ? 'Live now' : last ? fmtDateShort(last) : '—'}
            </span>
            <RunPills lineage={e.lineage} activeId={e.id} />
            <TableStatus e={e} />
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={(ev) => { ev.stopPropagation(); onReuse(e) }} style={{ ...btn('primary'), padding: '4px 9px', fontSize: 11 }}>
                <Icon d={IC.reuse} size={11} />Run again
              </button>
            </span>
          </div>
        )})}
      </div>
    </div>
  )
}

// ── Timeline View ─────────────────────────────────────────────────────────────
// One row per creative lineage; one bar per run. Solid = ran, green = live now,
// dashed = scheduled, dashed amber ↻ = re-run pending restart by the trafficker.
type BarKind = 'ran' | 'live' | 'scheduled' | 'restart' | 'manual'

interface RunBar {
  key: string
  start: string
  end: string
  kind: BarKind
  runNumber: number
  status: string
}

interface LineageRow {
  rootId: string
  title: string
  latest: ArchiveEntry
  bars: RunBar[]
}

// Flights (actual run history) win; the card's own manual dates only draw when
// they describe a future/pending run, or when there's no flight record at all.
function barsForEntry(e: ArchiveEntry, today: string): RunBar[] {
  const bars: RunBar[] = e.flights.map((span, i) => ({
    key: `${e.id}-f${i}`,
    start: span.start,
    end: span.end ?? today,
    kind: span.end === null ? 'live' as const : 'ran' as const,
    runNumber: e.run_number,
    status: e.approval_status,
  }))
  const hasOpenFlight = e.flights.some((s) => s.end === null)
  if (e.flight_start_date && e.flight_end_date && !hasOpenFlight) {
    const kind: BarKind | null = e.restart_requested_at ? 'restart'
      : e.flight_start_date > today ? 'scheduled'
      : e.flights.length === 0 ? 'manual'
      : null
    if (kind) {
      bars.push({ key: `${e.id}-m`, start: e.flight_start_date, end: e.flight_end_date, kind, runNumber: e.run_number, status: e.approval_status })
    }
  }
  return bars
}

const BAR_LABELS: Record<BarKind, string> = {
  ran: 'Ran',
  live: 'Live now',
  scheduled: 'Scheduled',
  restart: 'Re-run pending',
  manual: 'Manual dates (no recorded flight)',
}

function statusColor(status: string): string {
  return status === 'approved' ? T.green
    : status === 'changes_requested' ? T.amber
    : status === 'rejected' ? T.red
    : 'rgba(255,255,255,0.3)'
}

interface TimelineViewProps {
  entries: ArchiveEntry[]
  onOpen: (e: ArchiveEntry) => void
  onRunAgain: (e: ArchiveEntry) => void
  rangeStart: string
  rangeEnd: string
  zoom: TimelineZoom
  onZoomChange: (z: TimelineZoom) => void
  onPrev: () => void
  onNext: () => void
  onRangeChange: (start: string, end: string) => void
}

function TimelineView({ entries, onOpen, onRunAgain, rangeStart, rangeEnd, zoom, onZoomChange, onPrev, onNext, onRangeChange }: TimelineViewProps) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [customMode, setCustomMode] = useState(false)
  const [customStart, setCustomStart] = useState(rangeStart)
  const [customEnd, setCustomEnd] = useState(rangeEnd)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<'edit' | 'extend'>('edit')
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  // The pencil forks by run state: past ads funnel into the Run-again flow
  // (that's the kick-back-to-trafficker trigger), live ads can only be extended,
  // already-scheduled runs keep plain inline date editing.
  function handlePencil(row: LineageRow) {
    const e = row.latest
    if (editingId === row.rootId) { setEditingId(null); return }
    if (e.is_live) {
      setEditMode('extend')
      setEditingId(row.rootId)
      setEditStart(e.effective_flight_start ?? '')
      setEditEnd(e.effective_flight_end ?? '')
    } else if (e.restart_requested_at || (e.flight_start_date && e.flight_start_date > todayStr)) {
      setEditMode('edit')
      setEditingId(row.rootId)
      setEditStart(e.flight_start_date ?? '')
      setEditEnd(e.flight_end_date ?? '')
    } else {
      onRunAgain(e)
    }
  }

  async function handleSaveDates(cardId: string) {
    if (!editEnd || (editMode === 'edit' && (!editStart || editStart > editEnd))) return
    setEditSaving(true)
    const updates = editMode === 'extend'
      ? { flight_end_date: editEnd }
      : { flight_start_date: editStart, flight_end_date: editEnd }
    await supabase.from('cards').update(updates).eq('id', cardId)
    setEditSaving(false)
    setEditingId(null)
    router.refresh()
  }

  function handleToggleCustom() {
    if (!customMode) { setCustomStart(rangeStart); setCustomEnd(rangeEnd) }
    setCustomMode(v => !v)
  }

  const rangeStartMs = new Date(rangeStart + 'T00:00:00').getTime()
  const rangeEndMs = new Date(rangeEnd + 'T23:59:59').getTime()
  const totalMs = rangeEndMs - rangeStartMs || 1

  function pct(d: string): number {
    return Math.max(0, Math.min(100, ((new Date(d + 'T00:00:00').getTime() - rangeStartMs) / totalMs) * 100))
  }

  const todayStr = new Date().toISOString().slice(0, 10)
  const todayPct = pct(todayStr)
  const showToday = todayStr >= rangeStart && todayStr <= rangeEnd

  const byClient = useMemo(() => {
    // client → lineage root → runs, keeping only rows with a bar in range
    const clientMap = new Map<string, { name: string | null; logoUrl: string | null; abbr: string | null; lineages: Map<string, ArchiveEntry[]> }>()
    for (const e of entries) {
      const ck = e.client_id ?? '__unknown__'
      if (!clientMap.has(ck)) clientMap.set(ck, { name: e.client_name, logoUrl: e.client_logo_url, abbr: e.client_abbreviation, lineages: new Map() })
      const lineages = clientMap.get(ck)!.lineages
      const rootId = e.source_card_id ?? e.id
      if (!lineages.has(rootId)) lineages.set(rootId, [])
      lineages.get(rootId)!.push(e)
    }
    const groups: { clientId: string; name: string | null; logoUrl: string | null; abbr: string | null; rows: LineageRow[] }[] = []
    for (const [clientId, g] of clientMap) {
      const rows: LineageRow[] = []
      for (const [rootId, runs] of g.lineages) {
        runs.sort((a, b) => a.run_number - b.run_number)
        const latest = runs[runs.length - 1]
        const bars = runs
          .flatMap((r) => barsForEntry(r, todayStr))
          .filter((b) => b.start <= rangeEnd && b.end >= rangeStart)
        if (bars.length === 0) continue
        rows.push({ rootId, title: latest.lineage[0]?.title ?? runs[0].title, latest, bars })
      }
      if (rows.length > 0) groups.push({ clientId, name: g.name, logoUrl: g.logoUrl, abbr: g.abbr, rows })
    }
    return groups
  }, [entries, rangeStart, rangeEnd, todayStr])

  const ticks = useMemo(() => {
    const rsMs = new Date(rangeStart + 'T00:00:00').getTime()
    const reMs = new Date(rangeEnd + 'T23:59:59').getTime()
    const tMs = reMs - rsMs || 1
    const calcPct = (d: Date) => Math.max(0, Math.min(100, ((d.getTime() - rsMs) / tMs) * 100))
    const result: { label: string; p: number }[] = []
    const startDate = new Date(rangeStart + 'T00:00:00')
    const endDate = new Date(rangeEnd + 'T00:00:00')
    const seen = new Set<string>()

    // Tick density follows range length so year view isn't a wall of numbers
    const spanDays = tMs / 86400000
    const dayList = spanDays > 130 ? [1] : spanDays > 45 ? [1, 15] : [1, 8, 15, 22]

    function addTick(date: Date) {
      if (date < startDate || date > endDate) return
      const str = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      if (seen.has(str)) return
      seen.add(str)
      const label = spanDays > 130
        ? date.toLocaleDateString('en-US', { month: 'short' })
        : (str === rangeStart || date.getDate() === 1)
          ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : date.getDate().toString()
      result.push({ label, p: calcPct(date) })
    }

    if (spanDays <= 130) addTick(startDate)
    const y0 = startDate.getFullYear(), m0 = startDate.getMonth()
    const y1 = endDate.getFullYear(), m1 = endDate.getMonth()
    for (let y = y0; y <= y1; y++) {
      for (let m = (y === y0 ? m0 : 0); m <= (y === y1 ? m1 : 11); m++) {
        for (const d of dayList) addTick(new Date(y, m, d))
      }
    }
    result.sort((a, b) => a.p - b.p)
    return result
  }, [rangeStart, rangeEnd])

  const rangeLabel = useMemo(() => {
    const s = new Date(rangeStart + 'T00:00:00')
    const e = new Date(rangeEnd + 'T00:00:00')
    if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
      return s.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    }
    return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
  }, [rangeStart, rangeEnd])

  return (
    <div style={{ padding: '0 0 24px' }}>
      {/* Range controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, padding: 2 }}>
          {(['month', 'quarter', 'year'] as const).map((z) => (
            <button
              key={z}
              onClick={() => onZoomChange(z)}
              style={{
                appearance: 'none', border: 'none', cursor: 'pointer', fontFamily: T.font,
                background: zoom === z ? T.surface3 : 'transparent',
                color: zoom === z ? T.fgStrong : T.fgMuted,
                padding: '4px 10px', fontSize: 11.5, fontWeight: 500, borderRadius: 6,
              }}
            >
              {z === 'month' ? 'Month' : z === 'quarter' ? 'Quarter' : 'Year'}
            </button>
          ))}
        </div>
        <div style={{ width: 1, height: 16, background: T.border, margin: '0 2px' }} />
        <button onClick={onPrev} style={{ ...btn('ghost'), padding: '5px 8px' }}>
          <Icon d={IC.chevLeft} size={13} />
        </button>
        <span style={{ fontSize: 13, fontWeight: 600, color: T.fgStrong, minWidth: 150, textAlign: 'center' }}>{rangeLabel}</span>
        <button onClick={onNext} style={{ ...btn('ghost'), padding: '5px 8px' }}>
          <Icon d={IC.chevRight} size={13} />
        </button>
        <div style={{ width: 1, height: 16, background: T.border, margin: '0 2px' }} />
        <button onClick={handleToggleCustom} style={{ ...btn('ghost'), fontSize: 11.5, color: customMode ? T.accentHi : T.fgMuted, padding: '5px 8px' }}>
          {customMode ? 'Close' : 'Custom range'}
        </button>
        {customMode && (
          <>
            <input type="date" value={customStart} onChange={ev => setCustomStart(ev.target.value)}
              style={{ fontFamily: T.font, fontSize: 12, color: T.fg, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, padding: '4px 8px', outline: 'none', colorScheme: 'dark' }} />
            <span style={{ color: T.fgSubtle, fontSize: 11 }}>→</span>
            <input type="date" value={customEnd} onChange={ev => setCustomEnd(ev.target.value)}
              style={{ fontFamily: T.font, fontSize: 12, color: T.fg, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, padding: '4px 8px', outline: 'none', colorScheme: 'dark' }} />
            <button
              disabled={!customStart || !customEnd || customStart > customEnd}
              onClick={() => { onRangeChange(customStart, customEnd); setCustomMode(false) }}
              style={{ ...btn('primary'), padding: '4px 10px', fontSize: 12, opacity: (!customStart || !customEnd || customStart > customEnd) ? 0.5 : 1 }}
            >Apply</button>
          </>
        )}
        <div style={{ flex: 1 }} />
        {showToday && <span style={{ fontSize: 11, color: T.green, fontFamily: T.mono }}>● today</span>}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '9px 20px 0', flexWrap: 'wrap' }}>
        {([
          ['Ran', { background: T.accent, opacity: 0.85 }],
          ['Live now', { background: T.green }],
          ['Scheduled', { background: 'rgba(99,102,241,0.10)', border: `1.5px dashed ${T.accentHi}` }],
          ['Re-run pending ↻', { background: 'rgba(245,158,11,0.10)', border: `1.5px dashed ${T.amber}` }],
          ['Manual dates', { background: T.amber, opacity: 0.5 }],
        ] as [string, React.CSSProperties][]).map(([label, style]) => (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: T.fgMuted }}>
            <span style={{ width: 18, height: 8, borderRadius: 3, boxSizing: 'border-box', display: 'inline-block', ...style }} />
            {label}
          </span>
        ))}
      </div>

      {/* Axis + rows */}
      <div style={{ padding: '12px 20px 0' }}>
        {/* Date axis */}
        <div style={{ position: 'relative', height: 20, marginLeft: 214, marginBottom: 4 }}>
          {ticks.map((t, i) => (
            <div key={i} style={{
              position: 'absolute', left: `${t.p}%`, transform: 'translateX(-50%)',
              fontSize: 10, color: T.fgSubtle, fontFamily: T.mono, whiteSpace: 'nowrap', userSelect: 'none',
            }}>{t.label}</div>
          ))}
        </div>

        {byClient.length === 0 ? (
          <NoTimelineData />
        ) : byClient.map((group) => (
          <div key={group.clientId} style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <ClientAvatar clientId={null} name={group.name} abbr={group.abbr} logoUrl={group.logoUrl} size={20} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: T.fgStrong }}>{group.name}</span>
            </div>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rLg, overflow: 'hidden' }}>
              {group.rows.map((row, i) => {
                const e = row.latest
                const pencilTitle = e.is_live
                  ? 'Extend end date'
                  : (e.restart_requested_at || (e.flight_start_date && e.flight_start_date > todayStr))
                    ? 'Edit scheduled dates'
                    : 'Run again — kicks the card back to the trafficker'
                return (
                <div key={row.rootId}>
                  {/* Lineage row — one bar per run */}
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '9px 14px',
                    borderTop: i === 0 ? 'none' : `1px solid ${T.divider}`,
                    opacity: e.archived && !e.restart_requested_at ? 0.78 : 1,
                  }}>
                    <div
                      onClick={() => onOpen(e)}
                      style={{ width: 200, flex: '0 0 200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: T.fg, cursor: 'pointer' }}
                    >{row.title}</div>
                    <div onClick={() => onOpen(e)} style={{ flex: 1, position: 'relative', height: 28, cursor: 'pointer' }}>
                      <div style={{ position: 'absolute', inset: '8px 0', background: T.surface2, borderRadius: 4 }} />
                      {showToday && (
                        <div style={{ position: 'absolute', left: `${todayPct}%`, top: 0, bottom: 0, width: 2, background: T.green, opacity: 0.65, borderRadius: 2, zIndex: 2 }} />
                      )}
                      {row.bars.map((b) => (
                        <div
                          key={b.key}
                          title={`Run ${b.runNumber} · ${fmtDateShort(b.start)} – ${fmtDateShort(b.end)} · ${BAR_LABELS[b.kind]}`}
                          style={{
                            position: 'absolute',
                            left: `${pct(b.start)}%`,
                            width: `${Math.max(pct(b.end) - pct(b.start), 0.5)}%`,
                            top: 4, bottom: 4, borderRadius: 4, minWidth: 4, zIndex: 1, boxSizing: 'border-box',
                            ...(b.kind === 'ran' ? { background: T.accent, opacity: 0.85 }
                              : b.kind === 'live' ? { background: T.green, opacity: 0.9 }
                              : b.kind === 'scheduled' ? { background: 'rgba(99,102,241,0.10)', border: `1.5px dashed ${T.accentHi}` }
                              : b.kind === 'restart' ? { background: 'rgba(245,158,11,0.10)', border: `1.5px dashed ${T.amber}` }
                              : { background: T.amber, opacity: 0.5 }),
                          }}
                        >
                          <span style={{
                            position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)',
                            width: 5, height: 5, borderRadius: '50%',
                            background: statusColor(b.status), boxShadow: '0 0 0 1px rgba(0,0,0,0.25)',
                          }} />
                          {b.kind === 'live' && (
                            <span className="ct-live-dot" style={{ position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)', width: 5, height: 5, borderRadius: '50%', background: '#fff' }} />
                          )}
                          {b.kind === 'restart' && (
                            <span style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', fontSize: 10, color: T.amber, lineHeight: 1, fontWeight: 700 }}>↻</span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ width: 50, flex: '0 0 50px' }}>
                      <RunPills lineage={e.lineage} activeId={e.id} />
                    </div>
                    {/* Pencil — forks by run state (see handlePencil) */}
                    <button
                      onClick={ev => { ev.stopPropagation(); handlePencil(row) }}
                      title={pencilTitle}
                      style={{
                        ...btn('ghost'), padding: '3px 6px', flex: '0 0 auto',
                        color: e.restart_requested_at ? T.amber : T.fgSubtle,
                        opacity: editingId === row.rootId ? 1 : 0.6,
                      }}
                    >
                      <Icon d={IC.pencil} size={12} />
                    </button>
                  </div>

                  {/* Inline edit form — extend-only for live ads */}
                  {editingId === row.rootId && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 10px',
                      background: T.surface2, borderTop: `1px solid ${T.border}`,
                    }}>
                      <span style={{ fontSize: 11, color: T.fgMuted, flex: '0 0 auto' }}>{editMode === 'extend' ? 'Extend end date:' : 'Scheduled dates:'}</span>
                      {editMode === 'edit' && (
                        <>
                          <input type="date" value={editStart} onChange={ev => setEditStart(ev.target.value)}
                            style={{ fontFamily: T.font, fontSize: 12, color: T.fg, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: T.rMd, padding: '4px 8px', outline: 'none', colorScheme: 'dark' }} />
                          <span style={{ color: T.fgSubtle, fontSize: 11 }}>→</span>
                        </>
                      )}
                      <input type="date" value={editEnd} onChange={ev => setEditEnd(ev.target.value)}
                        style={{ fontFamily: T.font, fontSize: 12, color: T.fg, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: T.rMd, padding: '4px 8px', outline: 'none', colorScheme: 'dark' }} />
                      <button
                        disabled={editSaving || !editEnd || (editMode === 'edit' && (!editStart || editStart > editEnd))}
                        onClick={() => handleSaveDates(e.id)}
                        style={{ ...btn('primary'), padding: '4px 10px', fontSize: 12, opacity: (editSaving || !editEnd || (editMode === 'edit' && (!editStart || editStart > editEnd))) ? 0.5 : 1 }}
                      >{editSaving ? 'Saving…' : 'Save'}</button>
                      <button onClick={() => setEditingId(null)} style={{ ...btn('ghost'), padding: '4px 8px', fontSize: 12 }}>Cancel</button>
                      {editMode === 'extend' && (
                        <span style={{ fontSize: 10.5, color: T.fgMuted, marginLeft: 4 }}>Ad is live — only the end date can change here</span>
                      )}
                    </div>
                  )}
                </div>
              )})}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Empty / no-results states ─────────────────────────────────────────────────
function EmptyArchive() {
  return (
    <div style={{ padding: '60px 20px', textAlign: 'center' }}>
      <svg width="120" height="96" viewBox="0 0 120 96" fill="none" style={{ marginBottom: 16 }}>
        <rect x="10" y="14" width="100" height="2" fill={T.border2} />
        <rect x="10" y="44" width="100" height="2" fill={T.border2} />
        <rect x="18" y="18" width="20" height="24" rx="2" fill={T.surface} stroke={T.border} />
        <rect x="82" y="48" width="18" height="24" rx="2" fill={T.surface} stroke={T.border} />
        <rect x="44" y="22" width="14" height="20" rx="2" fill="none" stroke={T.border} strokeDasharray="2 2" />
      </svg>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.fgStrong, marginBottom: 4 }}>No creatives archived yet.</div>
      <div style={{ fontSize: 12.5, color: T.fgMuted }}>When cards are archived from the board, they&apos;ll appear here after the next export.</div>
    </div>
  )
}

function NoResults() {
  return (
    <div style={{ padding: '60px 20px', textAlign: 'center' }}>
      <div style={{ fontSize: 13.5, fontWeight: 500, color: T.fgStrong, marginBottom: 4 }}>No creatives match your search.</div>
      <div style={{ fontSize: 12, color: T.fgMuted }}>Try a different client or search term.</div>
    </div>
  )
}

function NoTimelineData() {
  return (
    <div style={{ padding: '48px 20px', textAlign: 'center' }}>
      <svg width="90" height="56" viewBox="0 0 90 56" fill="none" style={{ display: 'block', margin: '0 auto 14px' }}>
        <rect x="0" y="14" width="90" height="1.5" rx="0.75" fill={T.border} />
        <rect x="0" y="28" width="90" height="1.5" rx="0.75" fill={T.border} />
        <rect x="0" y="42" width="90" height="1.5" rx="0.75" fill={T.border} />
        <rect x="12" y="18" width="28" height="8" rx="3" fill="none" stroke={T.border2} strokeDasharray="3 2" />
        <rect x="48" y="32" width="20" height="8" rx="3" fill="none" stroke={T.border2} strokeDasharray="3 2" />
        <rect x="24" y="46" width="36" height="8" rx="3" fill="none" stroke={T.border2} strokeDasharray="3 2" />
      </svg>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: T.fgStrong, marginBottom: 4 }}>No creatives with flight dates in this range.</div>
      <div style={{ fontSize: 12, color: T.fgMuted }}>Try a different month or adjust your filters.</div>
    </div>
  )
}

// ── Detail Drawer ─────────────────────────────────────────────────────────────
function AdCopyRow({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const doCopy = () => {
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(true); setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ fontSize: 10.5, color: T.fgSubtle, width: 60, flex: '0 0 60px', paddingTop: 1 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: T.fg, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{text}</span>
      <button onClick={doCopy} style={{ ...btn('ghost'), padding: '2px 5px' }}>
        {copied ? <Icon d={IC.check} size={11} style={{ color: T.green }} /> : <Icon d={IC.copy} size={11} />}
      </button>
    </div>
  )
}

function DetailDrawer({ entry, onClose, onReuse, onDuplicate }: { entry: ArchiveEntry; onClose: () => void; onReuse: (e: ArchiveEntry) => void; onDuplicate: (e: ArchiveEntry) => void }) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const utmUrl = buildUtmUrl(entry)
  const [utmCopied, setUtmCopied] = useState(false)
  const copyUtm = () => {
    if (utmUrl) navigator.clipboard?.writeText(utmUrl).catch(() => {})
    setUtmCopied(true); setTimeout(() => setUtmCopied(false), 1400)
  }

  // Portal status toggles — mutually exclusive
  const [portalStatus, setPortalStatus] = useState<'running' | 'archive_review' | null>(
    entry.client_portal_status === 'running' || entry.client_portal_status === 'archive_review'
      ? entry.client_portal_status
      : null
  )
  const [portalSaving, setPortalSaving] = useState(false)

  async function handlePortalToggle(target: 'running' | 'archive_review') {
    const next = portalStatus === target ? null : target
    setPortalSaving(true)
    const { error } = await supabase.from('cards').update({ client_portal_status: next }).eq('id', entry.id)
    if (!error) setPortalStatus(next)
    setPortalSaving(false)
  }

  return (
    <div style={{ width: 440, flex: '0 0 440px', height: '100%', display: 'flex', flexDirection: 'column', background: T.bg2, borderLeft: `1px solid ${T.border2}`, boxShadow: '-12px 0 32px rgba(0,0,0,0.3)' }}>
      {/* header */}
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <ClientAvatar clientId={entry.client_id} name={entry.client_name} abbr={entry.client_abbreviation} logoUrl={entry.client_logo_url} size={20} />
            <span style={{ fontSize: 11.5, color: T.fgMuted }}>{entry.client_name}</span>
            {entry.media_type && <><span style={{ color: T.fgSubtle, fontSize: 10 }}>·</span><span style={{ fontSize: 10.5, color: T.fgSubtle }}>{entry.media_type}</span></>}
          </div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: T.fgStrong, letterSpacing: '-0.01em', lineHeight: 1.3 }}>{entry.title}</h2>
        </div>
        <a
          href={`/card/${entry.id}`}
          target="_blank"
          rel="noopener noreferrer"
          title="Open the full card — every field, files, flight history, comments"
          style={{ ...btn('default'), textDecoration: 'none', padding: '5px 9px', fontSize: 11.5, flex: '0 0 auto' }}
        >
          <Icon d={IC.external} size={11} />
          Full card
        </a>
        <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }}>
          <Icon d={IC.close} size={14} />
        </button>
      </div>

      {/* scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 20px' }}>
        {/* clone lineage nodes — only when this creative actually has multiple cloned runs */}
        {entry.lineage.length > 1 && (
          <>
            <SectionLabel>Run lineage</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 18 }}>
              {entry.lineage.map((r, i) => (
                <div key={r.card_id} style={{ display: 'flex', alignItems: 'center', flex: i < entry.lineage.length - 1 ? '1' : '0 0 auto' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 56 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 999,
                      background: r.card_id === entry.id ? T.accent : T.surface3,
                      color: r.card_id === entry.id ? '#fff' : T.fgMuted,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 700, fontFamily: T.mono,
                      border: `1px solid ${r.card_id === entry.id ? 'transparent' : T.border2}`,
                      boxShadow: r.card_id === entry.id ? `0 0 0 3px ${T.accentRing}` : 'none',
                    }}>{r.run_number}</div>
                    <span style={{ fontSize: 9.5, color: T.fgSubtle, fontFamily: T.mono }}>{r.flight_start_date ? new Date(r.flight_start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) : '—'}</span>
                  </div>
                  {i < entry.lineage.length - 1 && <div style={{ flex: 1, height: 1.5, background: T.border2, marginBottom: 14 }} />}
                </div>
              ))}
            </div>
          </>
        )}

        {/* files */}
        <SectionLabel>Creative files <span style={{ fontWeight: 400, color: T.fgSubtle, marginLeft: 4, textTransform: 'none', letterSpacing: 'normal', fontSize: 12 }}>{entry.files.length}</span></SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 18 }}>
          {entry.files.map((f) => <FileThumb key={f.id} file={f} size={60} />)}
          {entry.files.length === 0 && <span style={{ color: T.fgSubtle, fontSize: 11.5, gridColumn: '1/-1' }}>No files attached</span>}
        </div>

        {/* description */}
        {entry.description && (
          <>
            <SectionLabel>Description</SectionLabel>
            <p style={{ margin: '0 0 18px', fontSize: 12.5, color: T.fgMuted, lineHeight: 1.55 }}>{entry.description}</p>
          </>
        )}

        {/* ad copy — for AMs reviewing past ads */}
        {(entry.fb_headline || entry.fb_body_text || entry.fb_cta) && (
          <>
            <SectionLabel>Ad copy</SectionLabel>
            <div style={{ border: `1px solid ${T.border}`, borderRadius: T.rMd, background: T.bg, padding: '10px 12px', marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {entry.fb_headline && <AdCopyRow label="Headline" text={entry.fb_headline} />}
              {entry.fb_body_text && <AdCopyRow label="Body" text={entry.fb_body_text} />}
              {entry.fb_cta && <AdCopyRow label="CTA" text={entry.fb_cta} />}
            </div>
          </>
        )}

        {/* details */}
        <SectionLabel>Details</SectionLabel>
        <dl style={{ margin: '0 0 18px', display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: 8, columnGap: 12, fontSize: 12 }}>
          {entry.media_type && <><dt style={{ color: T.fgSubtle }}>Media type</dt><dd style={{ margin: 0, color: T.fg }}>{entry.media_type}</dd></>}
          {(entry.flight_start_date || entry.flight_end_date) && <><dt style={{ color: T.fgSubtle }}>Flight</dt><dd style={{ margin: 0, color: T.fg }}>{fmtDate(entry.flight_start_date)} → {fmtDate(entry.flight_end_date)}</dd></>}
          <><dt style={{ color: T.fgSubtle }}>Run</dt><dd style={{ margin: 0, color: T.fg, fontFamily: T.mono }}>#{entry.run_number} of {entry.lineage.length}</dd></>
          <><dt style={{ color: T.fgSubtle }}>Status</dt><dd style={{ margin: 0, display: 'flex', gap: 5, flexWrap: 'wrap' }}><StatusBadge status={entry.approval_status} />{entry.restart_requested_at && !entry.is_live && <RerunPendingPill />}</dd></>
          {entry.creative_name && <><dt style={{ color: T.fgSubtle }}>Creative name</dt><dd style={{ margin: 0, color: T.fg, fontFamily: T.mono }}>{entry.creative_name}</dd></>}
        </dl>

        {/* UTM */}
        {utmUrl && (
          <>
            <SectionLabel>UTM / tracking URL</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: T.bg, border: `1px solid ${T.border}`, borderRadius: T.rMd, padding: '6px 8px 6px 10px', marginBottom: 18 }}>
              <Icon d={IC.link} size={12} style={{ color: T.fgSubtle }} />
              <code style={{ flex: 1, minWidth: 0, fontSize: 10.5, fontFamily: T.mono, color: T.fgMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{utmUrl}</code>
              <button onClick={copyUtm} style={{ ...btn('ghost'), padding: '3px 6px', fontSize: 10.5 }}>
                {utmCopied ? <Icon d={IC.check} size={12} style={{ color: T.green }} /> : <Icon d={IC.copy} size={12} />}
              </button>
            </div>
          </>
        )}

        {/* flight history — every start/stop from card_flights, editable in place */}
        <SectionLabel>Flight history</SectionLabel>
        <div style={{ fontSize: 11, color: T.fgSubtle, marginBottom: 8 }}>
          Every time this ad started and stopped. Edits and voids here update the timeline immediately.
        </div>
        <div style={{ border: `1px solid ${T.border}`, borderRadius: T.rMd, overflow: 'hidden', background: T.bg, marginBottom: 18 }}>
          <FlightsTab
            cardId={entry.id}
            doneColumnId={null}
            onColumnChanged={() => router.refresh()}
            onFlightsChanged={() => router.refresh()}
          />
        </div>

        {/* clone lineage table — only for multi-run creatives */}
        {entry.lineage.length > 1 && (
          <>
            <SectionLabel>Clone lineage</SectionLabel>
            <div style={{ border: `1px solid ${T.border}`, borderRadius: T.rMd, overflow: 'hidden', background: T.bg, marginBottom: 4 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 110px', fontSize: 10.5, color: T.fgSubtle, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '8px 12px', borderBottom: `1px solid ${T.border}`, fontWeight: 600 }}>
                <span>Run</span><span>Flight</span><span>Status</span>
              </div>
              {entry.lineage.map((r, i) => (
                <div key={r.card_id} style={{ display: 'grid', gridTemplateColumns: '44px 1fr 110px', padding: '9px 12px', fontSize: 12, alignItems: 'center', borderTop: i === 0 ? 'none' : `1px solid ${T.divider}` }}>
                  <span style={{ fontFamily: T.mono, color: T.fgMuted }}>#{r.run_number}</span>
                  <span style={{ color: T.fg }}>{fmtDateShort(r.flight_start_date)} → {fmtDateShort(r.flight_end_date)}</span>
                  {r.card_id === entry.id ? <StatusBadge status={entry.approval_status} /> : <span style={{ fontSize: 10.5, color: T.fgSubtle }}>Archived</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* footer — portal toggles + re-use */}
      <div style={{ padding: '12px 18px', borderTop: `1px solid ${T.border}`, background: T.bg2, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Portal section label */}
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.fgSubtle }}>Client Portal</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => handlePortalToggle('running')}
            disabled={portalSaving}
            style={{
              flex: 1, fontFamily: T.font, fontSize: 11.5, fontWeight: 500, borderRadius: 8,
              padding: '6px 10px', cursor: portalSaving ? 'not-allowed' : 'pointer', border: '1px solid',
              background: portalStatus === 'running' ? 'rgba(16,185,129,0.14)' : 'transparent',
              borderColor: portalStatus === 'running' ? 'rgba(16,185,129,0.4)' : T.border,
              color: portalStatus === 'running' ? T.green : T.fgMuted,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            }}
          >
            {portalStatus === 'running' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.green, display: 'inline-block', flex: '0 0 auto' }} />}
            {portalStatus === 'running' ? 'Showing as Running' : 'Show as Running'}
          </button>
          <button
            onClick={() => handlePortalToggle('archive_review')}
            disabled={portalSaving}
            style={{
              flex: 1, fontFamily: T.font, fontSize: 11.5, fontWeight: 500, borderRadius: 8,
              padding: '6px 10px', cursor: portalSaving ? 'not-allowed' : 'pointer', border: '1px solid',
              background: portalStatus === 'archive_review' ? 'rgba(139,92,246,0.14)' : 'transparent',
              borderColor: portalStatus === 'archive_review' ? 'rgba(139,92,246,0.4)' : T.border,
              color: portalStatus === 'archive_review' ? '#a78bfa' : T.fgMuted,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            }}
          >
            {portalStatus === 'archive_review' ? '✓ In Past Creatives' : 'Show in Past Creatives'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => onDuplicate(entry)} style={btn('ghost')} title="Creates a new card cloned from this one — use only when the new run needs different creative">
            Duplicate as new card
          </button>
          <button onClick={() => onReuse(entry)} style={btn('primary')}>
            <Icon d={IC.reuse} size={12} />
            Run again
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Run Again Modal ───────────────────────────────────────────────────────────
// Primary re-run flow: same card, no clone. Moves the card to the channel's
// "Ready for Traffic" column with new flight dates and a re-run flag.
// If the ad is currently live, offers extending the end date instead.
function RunAgainModal({ entry, onClose, onDone }: { entry: ArchiveEntry; onClose: () => void; onDone: (message: string) => void }) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  // Past-anchored math can produce past starts — clamp to tomorrow, keep duration
  const [initialDates] = useState(() => {
    const today = todayISO()
    const next = flightBasedRange(entry)
    const dayMs = 24 * 60 * 60 * 1000
    const tomorrow = new Date(Date.now() + dayMs).toISOString().slice(0, 10)
    const start = next.start > today ? next.start : tomorrow
    const durationMs = Math.max(new Date(next.end + 'T00:00:00').getTime() - new Date(next.start + 'T00:00:00').getTime(), 0)
    const end = new Date(new Date(start + 'T00:00:00').getTime() + durationMs).toISOString().slice(0, 10)
    return { start, end }
  })

  const [startDate, setStartDate] = useState(initialDates.start)
  const [endDate, setEndDate] = useState(initialDates.end)
  const [channel, setChannel] = useState<RestartChannel>(defaultChannelFor(entry.media_type))
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [liveMode, setLiveMode] = useState(entry.is_live)
  const [extendEnd, setExtendEnd] = useState(entry.effective_flight_end ?? '')
  const [extendSaving, setExtendSaving] = useState(false)

  // Warn if first run was > 1 year ago
  const firstRun = entry.lineage[0]
  const firstYear = firstRun?.flight_start_date ? new Date(firstRun.flight_start_date).getFullYear() : null
  const filesOld = firstYear ? (new Date().getFullYear() - firstYear) >= 1 && entry.run_number <= 2 : false

  const datesInvalid = !startDate || !endDate || startDate > endDate

  async function handleRestart() {
    if (datesInvalid) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/cards/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId: entry.id,
          flightStartDate: startDate,
          flightEndDate: endDate,
          channel,
          note: note.trim() || undefined,
        }),
      })
      if (res.status === 409) {
        setLiveMode(true)
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Restart failed: ${res.status}`)
      }
      router.refresh()
      onDone(`Moved to "${CHANNEL_LABELS[channel]}" — flagged as re-run`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  async function handleExtend() {
    if (!extendEnd) return
    setExtendSaving(true)
    const { error: extErr } = await supabase.from('cards').update({ flight_end_date: extendEnd }).eq('id', entry.id)
    setExtendSaving(false)
    if (extErr) {
      setError('Failed to update end date')
      return
    }
    router.refresh()
    onDone('Flight end date extended')
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(6,7,12,0.72)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 500, background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
        {/* header */}
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10.5, color: T.fgSubtle, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
              {liveMode ? 'Currently live' : 'Re-uses the same card — no duplicate is created'}
            </div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: T.fgStrong, letterSpacing: '-0.01em' }}>
              {liveMode ? 'Extend this flight' : 'Run this ad again'}
            </h2>
          </div>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }}><Icon d={IC.close} size={14} /></button>
        </div>

        <div style={{ padding: '16px 20px 4px' }}>
          {/* source preview */}
          <div style={{ display: 'flex', gap: 10, padding: 10, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, marginBottom: 14 }}>
            <FilesStrip files={entry.files} max={3} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <ClientAvatar clientId={entry.client_id} name={entry.client_name} abbr={entry.client_abbreviation} logoUrl={entry.client_logo_url} size={16} />
                <span style={{ fontSize: 11, color: T.fgMuted }}>{entry.client_name}</span>
              </div>
              <div style={{ fontSize: 12.5, color: T.fgStrong, fontWeight: 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title}</div>
              <div style={{ fontSize: 10.5, color: T.fgSubtle }}>Run {entry.run_number} · {fmtDateShort(entry.flight_start_date)} → {fmtDateShort(entry.flight_end_date)}</div>
            </div>
          </div>

          {liveMode ? (
            <>
              <div style={{ display: 'flex', gap: 9, padding: '10px 12px', marginBottom: 12, background: T.greenSoft, border: '1px solid rgba(16,185,129,0.28)', borderRadius: T.rMd, fontSize: 11.5, color: T.fg }}>
                <span className="ct-live-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: T.green, flex: '0 0 auto', marginTop: 3 }} />
                <div>This ad is live right now. Extend its end date instead of scheduling a new run — no restart needed.</div>
              </div>
              <ModalField label="New flight end">
                <input type="date" value={extendEnd} onChange={(e) => setExtendEnd(e.target.value)} style={{ width: '100%', ...inputStyle(), fontFamily: T.mono, fontSize: 11.5 }} />
              </ModalField>
            </>
          ) : (
            <>
              {/* age warning */}
              {filesOld && (
                <div style={{ display: 'flex', gap: 9, padding: '10px 12px', marginBottom: 12, background: T.amberSoft, border: '1px solid rgba(245,158,11,0.28)', borderRadius: T.rMd, fontSize: 11.5, color: '#fcd34d' }}>
                  <Icon d={IC.warn} size={14} style={{ flex: '0 0 auto', marginTop: 1 }} />
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 2, color: '#fde68a' }}>Creative assets may be over a year old</div>
                    <div style={{ color: '#d4a24a' }}>Confirm they&apos;re still current before running again.</div>
                  </div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <ModalField label="New flight start">
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ width: '100%', ...inputStyle(), fontFamily: T.mono, fontSize: 11.5 }} />
                </ModalField>
                <ModalField label="New flight end">
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ width: '100%', ...inputStyle(), fontFamily: T.mono, fontSize: 11.5 }} />
                </ModalField>
              </div>
              <ModalField label="Send to" hint="Which queue restarts this ad">
                <select value={channel} onChange={(e) => setChannel(e.target.value as RestartChannel)} style={{ width: '100%', ...inputStyle(), cursor: 'pointer' }}>
                  {(Object.keys(CHANNEL_LABELS) as RestartChannel[]).map((c) => (
                    <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>
                  ))}
                </select>
              </ModalField>
              <ModalField label="Note for the trafficker" hint="Optional">
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything the trafficker should know?"
                  style={{ width: '100%', ...inputStyle(), resize: 'vertical', fontFamily: T.font }} />
              </ModalField>

              {/* what will happen */}
              <div style={{ padding: '10px 12px', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, fontSize: 11, color: T.fgMuted, display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.fgSubtle, marginBottom: 2 }}>What happens</div>
                <CloneRow label="Card" val="Same card is re-used — no duplicate" />
                <CloneRow label="Moves to" val={CHANNEL_LABELS[channel]} />
                <CloneRow label="Flagged" val="Re-run (adjustment, not a fresh ad)" />
                <CloneRow label="Notified" val="Trafficker, via Slack column watch" />
              </div>
            </>
          )}

          {error && <div style={{ marginTop: 10, fontSize: 11.5, color: T.red }}>{error}</div>}
        </div>

        {/* footer */}
        <div style={{ padding: '12px 20px', borderTop: `1px solid ${T.border}`, background: T.bg2, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={btn('default')}>Cancel</button>
          {liveMode ? (
            <button onClick={handleExtend} disabled={extendSaving || !extendEnd} style={{ ...btn('primary'), opacity: (extendSaving || !extendEnd) ? 0.7 : 1 }}>
              {extendSaving ? 'Saving…' : 'Extend end date'}
            </button>
          ) : (
            <button onClick={handleRestart} disabled={loading || datesInvalid} style={{ ...btn('primary'), opacity: (loading || datesInvalid) ? 0.7 : 1 }}>
              {loading ? 'Moving…' : <><Icon d={IC.reuse} size={12} />Run again</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Duplicate (clone) Modal — secondary flow for genuinely new creative ───────
function ReuseModal({ entry, onClose, onCloned }: { entry: ArchiveEntry; onClose: () => void; onCloned: () => void }) {
  const next = flightBasedRange(entry)
  const [title, setTitle] = useState(`${entry.title} — ${next.label}`)
  const [startDate, setStartDate] = useState(next.start)
  const [endDate, setEndDate] = useState(next.end)
  const [suffix, setSuffix] = useState(next.start.slice(0, 7).replace('-', ''))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Warn if first run was > 1 year ago
  const firstRun = entry.lineage[0]
  const firstYear = firstRun?.flight_start_date ? new Date(firstRun.flight_start_date).getFullYear() : null
  const filesOld = firstYear ? (new Date().getFullYear() - firstYear) >= 1 && entry.run_number <= 2 : false

  async function handleClone() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/cards/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceCardId: entry.id,
          title,
          flightStartDate: startDate,
          flightEndDate: endDate,
          utmCampaignSuffix: suffix,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Clone failed: ${res.status}`)
      }
      onCloned()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(6,7,12,0.72)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 500, background: T.surface, border: `1px solid ${T.border2}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
        {/* header */}
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10.5, color: T.fgSubtle, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Clone to Board</div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: T.fgStrong, letterSpacing: '-0.01em' }}>Duplicate as new card</h2>
          </div>
          <button onClick={onClose} style={{ ...btn('ghost'), padding: 6 }}><Icon d={IC.close} size={14} /></button>
        </div>

        <div style={{ padding: '16px 20px 4px' }}>
          {/* source preview */}
          <div style={{ display: 'flex', gap: 10, padding: 10, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, marginBottom: 14 }}>
            <FilesStrip files={entry.files} max={3} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <ClientAvatar clientId={entry.client_id} name={entry.client_name} abbr={entry.client_abbreviation} logoUrl={entry.client_logo_url} size={16} />
                <span style={{ fontSize: 11, color: T.fgMuted }}>{entry.client_name}</span>
              </div>
              <div style={{ fontSize: 12.5, color: T.fgStrong, fontWeight: 500, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title}</div>
              <div style={{ fontSize: 10.5, color: T.fgSubtle }}>Run {entry.run_number} · {fmtDateShort(entry.flight_start_date)} → {fmtDateShort(entry.flight_end_date)}</div>
            </div>
          </div>

          {/* age warning */}
          {filesOld && (
            <div style={{ display: 'flex', gap: 9, padding: '10px 12px', marginBottom: 12, background: T.amberSoft, border: '1px solid rgba(245,158,11,0.28)', borderRadius: T.rMd, fontSize: 11.5, color: '#fcd34d' }}>
              <Icon d={IC.warn} size={14} style={{ flex: '0 0 auto', marginTop: 1 }} />
              <div>
                <div style={{ fontWeight: 600, marginBottom: 2, color: '#fde68a' }}>Creative assets may be over a year old</div>
                <div style={{ color: '#d4a24a' }}>Confirm they&apos;re still current before cloning to the active board.</div>
              </div>
            </div>
          )}

          {/* form fields */}
          <ModalField label="New title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%', ...inputStyle() }} />
          </ModalField>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <ModalField label="New flight start">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ width: '100%', ...inputStyle(), fontFamily: T.mono, fontSize: 11.5 }} />
            </ModalField>
            <ModalField label="New flight end">
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ width: '100%', ...inputStyle(), fontFamily: T.mono, fontSize: 11.5 }} />
            </ModalField>
          </div>
          <ModalField label="Campaign suffix" hint="Appends to utm_campaign">
            <input value={suffix} onChange={(e) => setSuffix(e.target.value)} style={{ width: '100%', ...inputStyle(), fontFamily: T.mono }} />
          </ModalField>

          {/* what will be cloned */}
          <div style={{ padding: '10px 12px', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, fontSize: 11, color: T.fgMuted, display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.fgSubtle, marginBottom: 2 }}>Will be cloned</div>
            <CloneRow label="UTM fields" val={`source, medium, campaign + _${suffix || '…'}`} />
            <CloneRow label="File references" val={`${entry.files.length} file${entry.files.length !== 1 ? 's' : ''} (linked, no storage cost)`} />
            <CloneRow label="Approval" val="Reset to Awaiting Review" />
            <CloneRow label="Column" val="Placed in Queue" />
          </div>

          {error && <div style={{ marginTop: 10, fontSize: 11.5, color: T.red }}>{error}</div>}
        </div>

        {/* footer */}
        <div style={{ padding: '12px 20px', borderTop: `1px solid ${T.border}`, background: T.bg2, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={btn('default')}>Cancel</button>
          <button onClick={handleClone} disabled={loading || !title.trim()} style={{ ...btn('primary'), opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Cloning…' : <><Icon d={IC.reuse} size={12} />Clone to Board</>}
          </button>
        </div>
      </div>
    </div>
  )
}

function inputStyle(): React.CSSProperties {
  return { fontFamily: T.font, fontSize: 12.5, color: T.fg, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, padding: '7px 10px', outline: 'none' }
}
function ModalField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: T.fgMuted, fontWeight: 500 }}>{label}</span>
        {hint && <span style={{ fontSize: 10, color: T.fgSubtle }}>{hint}</span>}
      </div>
      {children}
    </label>
  )
}
function CloneRow({ label, val }: { label: string; val: string }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ fontSize: 10.5, color: T.fgSubtle, width: 110, flex: '0 0 110px' }}>{label}</span>
      <span style={{ fontSize: 11, color: T.fg }}>{val}</span>
    </div>
  )
}

// ── Success toast ─────────────────────────────────────────────────────────────
function SuccessToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 200, background: T.surface, border: `1px solid ${T.border2}`, borderRadius: T.rLg, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.4)' }}>
      <span style={{ width: 20, height: 20, borderRadius: 999, background: T.greenSoft, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon d={IC.check} size={12} style={{ color: T.green }} />
      </span>
      <span style={{ fontSize: 12.5, color: T.fgStrong }}>{message}</span>
      <button onClick={onDismiss} style={{ ...btn('ghost'), padding: 4, marginLeft: 4 }}><Icon d={IC.close} size={12} /></button>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
interface Props {
  archive: ArchiveEntry[]
  clients: Client[]
}

export default function CopyTrackerClient({ archive, clients }: Props) {
  const [view, setView] = useState<'grid' | 'table' | 'timeline'>('grid')
  const [selectedClient, setSelectedClient] = useState('all')
  const [selectedType, setSelectedType] = useState('all')
  const [selectedStatus, setSelectedStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [openEntry, setOpenEntry] = useState<ArchiveEntry | null>(null)
  const [runAgainEntry, setRunAgainEntry] = useState<ArchiveEntry | null>(null)
  const [dupEntry, setDupEntry] = useState<ArchiveEntry | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [timelineRange, setTimelineRange] = useState(() => getMonthRange(new Date()))
  const [timelineZoom, setTimelineZoom] = useState<TimelineZoom>('month')

  const mediaTypes = useMemo(() => {
    const types = new Set(archive.map((e) => e.media_type).filter(Boolean) as string[])
    return Array.from(types).sort()
  }, [archive])

  const filtered = useMemo(() => {
    let out = archive
    if (selectedClient !== 'all') out = out.filter((e) => e.client_id === selectedClient)
    if (selectedType !== 'all') out = out.filter((e) => e.media_type === selectedType)
    if (selectedStatus !== 'all') {
      if (selectedStatus === 'pending') {
        out = out.filter((e) => e.approval_status === 'pending' || e.approval_status === 'none')
      } else {
        out = out.filter((e) => e.approval_status === selectedStatus)
      }
    }
    if (query.trim()) {
      const q = query.toLowerCase()
      out = out.filter((e) =>
        e.title.toLowerCase().includes(q) ||
        (e.client_name ?? '').toLowerCase().includes(q) ||
        (e.utm_campaign ?? '').toLowerCase().includes(q) ||
        (e.utm_channel ?? '').toLowerCase().includes(q) ||
        (e.creative_name ?? '').toLowerCase().includes(q)
      )
    }
    return out
  }, [archive, selectedClient, selectedType, selectedStatus, query])

  function showToast(message: string) {
    setToast(message)
    setTimeout(() => setToast(null), 5000)
  }

  function handleRunAgain(entry: ArchiveEntry) {
    setOpenEntry(null)
    setRunAgainEntry(entry)
  }

  function handleDuplicate(entry: ArchiveEntry) {
    setOpenEntry(null)
    setDupEntry(entry)
  }

  function handleRestartDone(message: string) {
    setRunAgainEntry(null)
    showToast(message)
  }

  function handleCloned() {
    setDupEntry(null)
    showToast('Card cloned and placed in Queue.')
  }

  function handleZoomChange(z: TimelineZoom) {
    setTimelineZoom(z)
    const [y, m] = timelineRange.start.split('-').map(Number)
    const anchor = new Date(y, m - 1, 1)
    setTimelineRange(z === 'month' ? getMonthRange(anchor) : z === 'quarter' ? getQuarterRange(anchor) : getYearRange(anchor))
  }

  function shiftTimelineRange(dir: 1 | -1) {
    const [y, m] = timelineRange.start.split('-').map(Number)
    if (timelineZoom === 'month') setTimelineRange(getMonthRange(new Date(y, m - 1 + dir, 1)))
    else if (timelineZoom === 'quarter') setTimelineRange(getQuarterRange(new Date(y, m - 1 + 3 * dir, 1)))
    else setTimelineRange(getYearRange(new Date(y + dir, 0, 1)))
  }

  const selectClass: React.CSSProperties = {
    fontFamily: T.font, fontSize: 12.5, color: T.fg, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, padding: '6px 10px', outline: 'none', cursor: 'pointer', appearance: 'none' as const,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: T.bg, color: T.fg, fontFamily: T.font, fontSize: 13, lineHeight: 1.5, WebkitFontSmoothing: 'antialiased' }}>
      <style>{LIVE_PULSE_CSS}</style>
      {/* ─ Nav ─ */}
      <header style={{ height: 52, display: 'flex', alignItems: 'center', gap: 22, padding: '0 20px', borderBottom: `1px solid ${T.border}`, background: T.bg2, flex: '0 0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: `linear-gradient(135deg, ${T.accent} 0%, #0891b2 100%)`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, letterSpacing: '0.02em', color: '#fff', boxShadow: `0 2px 8px -2px ${T.accentRing}, inset 0 1px 0 rgba(255,255,255,0.2)` }}>FTE</div>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: T.fgStrong, letterSpacing: '-0.005em' }}>Follow The Eyes</span>
        </div>
        <nav style={{ display: 'flex', gap: 2, marginLeft: 6 }}>
          {[
            { label: 'Board', href: '/board' },
            { label: 'Calendar', href: '/calendar' },
            { label: 'Copy Tracker', href: '/copy-tracker' },
            { label: 'Clients', href: '/clients' },
          ].map(({ label, href }) => (
            <Link key={label} href={href} style={{
              padding: '6px 11px', fontSize: 12.5, fontWeight: 500, borderRadius: 8, textDecoration: 'none',
              color: label === 'Copy Tracker' ? T.fgStrong : T.fgMuted,
              background: label === 'Copy Tracker' ? T.surface2 : 'transparent',
            }}>{label}</Link>
          ))}
        </nav>
      </header>

      {/* ─ Filter bar ─ */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: `1px solid ${T.border}`, background: T.bg, flex: '0 0 auto', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: '0 0 1px', fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em', color: T.fgStrong }}>Copy Tracker</h1>
          <span style={{ fontSize: 11.5, color: T.fgSubtle }}>{archive.length} creatives</span>
        </div>
        <div style={{ flex: 1 }} />

        {/* search */}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, padding: '6px 10px', width: 240 }}>
          <Icon d={IC.search} size={13} style={{ color: T.fgSubtle }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, UTM, client…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.fg, fontSize: 12, fontFamily: T.font }} />
          {query && <button onClick={() => setQuery('')} style={{ ...btn('ghost'), padding: 2, border: 'none' }}><Icon d={IC.close} size={11} /></button>}
        </label>

        {/* client */}
        <select value={selectedClient} onChange={(e) => setSelectedClient(e.target.value)} style={selectClass}>
          <option value="all">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {/* media type */}
        <select value={selectedType} onChange={(e) => setSelectedType(e.target.value)} style={selectClass}>
          <option value="all">All types</option>
          {mediaTypes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>

        {/* approval status */}
        <select value={selectedStatus} onChange={(e) => setSelectedStatus(e.target.value)} style={selectClass}>
          <option value="all">All statuses</option>
          <option value="approved">Approved</option>
          <option value="pending">Awaiting Review</option>
          <option value="changes_requested">Changes Requested</option>
        </select>

        {/* view toggle */}
        <div style={{ display: 'inline-flex', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: T.rMd, padding: 2 }}>
          {([['grid', IC.grid, 'Grid'], ['table', IC.table, 'Table'], ['timeline', IC.timeline, 'Timeline']] as const).map(([id, icon, label]) => (
            <button key={id} onClick={() => setView(id)} title={label} style={{ appearance: 'none', border: 'none', background: view === id ? T.surface3 : 'transparent', color: view === id ? T.fgStrong : T.fgMuted, padding: '4px 9px', fontSize: 11.5, fontWeight: 500, borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: T.font }}>
              <Icon d={icon} size={13} />{label}
            </button>
          ))}
        </div>
      </div>

      {/* ─ Content area ─ */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {/* scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {archive.length === 0 ? <EmptyArchive /> :
           filtered.length === 0 ? <NoResults /> :
           view === 'grid' ? (
            <div style={{ padding: '18px 20px 24px' }}>
              {/* auto-fill lets the column count follow available width — including when the drawer opens */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 14 }}>
                {filtered.map((e) => (
                  <GridCard key={e.id} entry={e} onOpen={setOpenEntry} onReuse={handleRunAgain} />
                ))}
              </div>
            </div>
           ) : view === 'table' ? (
            <TableView entries={filtered} onOpen={setOpenEntry} onReuse={handleRunAgain} />
           ) : (
            <TimelineView
              entries={filtered}
              onOpen={setOpenEntry}
              onRunAgain={handleRunAgain}
              rangeStart={timelineRange.start}
              rangeEnd={timelineRange.end}
              zoom={timelineZoom}
              onZoomChange={handleZoomChange}
              onPrev={() => shiftTimelineRange(-1)}
              onNext={() => shiftTimelineRange(1)}
              onRangeChange={(start, end) => setTimelineRange({ start, end })}
            />
           )}
        </div>

        {/* detail drawer */}
        {openEntry && (
          <DetailDrawer entry={openEntry} onClose={() => setOpenEntry(null)} onReuse={handleRunAgain} onDuplicate={handleDuplicate} />
        )}
      </div>

      {/* run-again modal (same-card restart) */}
      {runAgainEntry && (
        <RunAgainModal entry={runAgainEntry} onClose={() => setRunAgainEntry(null)} onDone={handleRestartDone} />
      )}

      {/* duplicate (clone) modal */}
      {dupEntry && (
        <ReuseModal entry={dupEntry} onClose={() => setDupEntry(null)} onCloned={handleCloned} />
      )}

      {/* success toast */}
      {toast && <SuccessToast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  )
}

// React must be in scope for JSX (Next.js handles this, but make explicit for fragments)
import React from 'react'
