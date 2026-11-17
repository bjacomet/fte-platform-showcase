'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import type { Client } from '@/types'
import { TEMPLATE_OPTIONS } from '@/types'

interface Props {
  clients: Client[]
  selectedClient: string
  selectedMediaType: string
  onClientChange: (v: string) => void
  onMediaTypeChange: (v: string) => void
  onSignOut: () => void
  onOpenMenu: () => void
  userEmail?: string
  userFullName?: string
  /** True when the signed-in user owns at least one client — only then is "My clients" offered. */
  hasMyClients?: boolean
  myClientsOnly?: boolean
  onMyClientsToggle?: () => void
}

// Icon paths reused across nav items (stroke-based, 24x24 viewBox)
const ICONS = {
  adviewer: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
  copyTracker: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  calendar: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  pacing: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
  atlas: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z',
  videos: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
  clients: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  background: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  guide: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.247m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.247',
} as const

function NavIcon({ d }: { d: string }) {
  return (
    <svg className="w-3.5 h-3.5 flex-none text-[#0075a9]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  )
}

const menuItemClass =
  'w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-[#eaf3fc] hover:bg-[#0075a9]/20 hover:text-white transition-colors font-medium'

function NavDropdown({
  label, open, onToggle, children,
}: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className="text-[13px] text-[#eaf3fc] hover:text-[#7cc9ff] transition-colors flex items-center gap-1 font-semibold"
      >
        {label}
        <svg className={`w-3 h-3 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 min-w-[190px] bg-[#0b1220] border border-[#0075a9]/30 rounded-lg shadow-2xl shadow-black/60 overflow-hidden z-50 py-1">
          {children}
        </div>
      )}
    </div>
  )
}

export default function FilterBar({
  clients,
  selectedClient,
  selectedMediaType,
  onClientChange,
  onMediaTypeChange,
  onSignOut,
  onOpenMenu,
  userEmail = '',
  userFullName = '',
  hasMyClients = false,
  myClientsOnly = false,
  onMyClientsToggle,
}: Props) {
  const displayName = userFullName
    ? userFullName.split(' ')[0]
    : (() => {
        const raw = userEmail.split('@')[0]
        const first = raw.includes('.') ? raw.split('.')[0] : raw.replace(/[^a-zA-Z]/g, '')
        return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
      })()

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  // Which group dropdown is open (null = none). Grouped "by room" to declutter
  // the bar: Review / Plan / Create / Manage.
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const navRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openMenu) return
    function onClick(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenMenu(null)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  const toggle = (key: string) => setOpenMenu((prev) => (prev === key ? null : key))
  const close = () => setOpenMenu(null)

  // Text colors chosen for WCAG contrast on the #070a12 navbar background.
  // Near-white 13px (2026-07 legibility + grouping pass).
  const selectClass =
    'bg-[#0e1524] border border-[#0075a9]/50 text-[#eaf3fc] text-[13px] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[#0075a9]/80 cursor-pointer font-semibold transition-colors'

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2.5 flex-wrap relative z-30"
      style={{ background: 'linear-gradient(135deg, #163f52 0%, #322a58 100%)', borderBottom: '1px solid rgba(150,190,230,0.35)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.20), 0 6px 20px rgba(0,0,0,0.5)' }}
    >
      {/* Left — logo + filters */}
      <div className="flex items-center gap-2.5">
        <div className="flex-none">
          <div
            className="px-2.5 py-1 rounded-md font-black text-white text-xs tracking-widest"
            style={{ background: 'linear-gradient(135deg, #0075a9 0%, #7c3aed 100%)', letterSpacing: '2px' }}
          >
            FTE
          </div>
        </div>

        <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.07)' }} />

        <select value={selectedClient} onChange={(e) => onClientChange(e.target.value)} className={selectClass}>
          <option value="">All Clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <select value={selectedMediaType} onChange={(e) => onMediaTypeChange(e.target.value)} className={selectClass}>
          <option value="">All Media Types</option>
          {TEMPLATE_OPTIONS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        {hasMyClients && (
          <button
            onClick={onMyClientsToggle}
            aria-pressed={myClientsOnly}
            title="Only show cards for clients you own (set on the Clients page)"
            className={`text-[12px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${myClientsOnly ? 'bg-[#73308a]/40 border-[#73308a] text-white' : 'border-white/15 text-[#eaf3fc] hover:border-[#73308a]/70'}`}
          >
            My clients
          </button>
        )}

        {(selectedClient || selectedMediaType || myClientsOnly) && (
          <button
            onClick={() => { onClientChange(''); onMediaTypeChange(''); if (myClientsOnly) onMyClientsToggle?.() }}
            className="text-[13px] text-[#eaf3fc] hover:text-[#7cc9ff] underline font-semibold transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Center — greeting */}
      {displayName && (
        <p className="text-[13px] font-semibold tracking-wide" style={{ color: '#eaf3fc' }}>
          {greeting}, {displayName}
        </p>
      )}

      {/* Right — Training pill + Adviewer pill + grouped dropdowns + Sign out */}
      <div ref={navRef} className="flex items-center gap-3.5">
        {/* Training — interactive guided walkthrough of the Board & Adviewer.
            Static asset in public/, so a plain <a> (not next/link) opens it in a new tab. */}
        <a
          href="/training/board-adviewer.html"
          target="_blank"
          rel="noopener noreferrer"
          title="Interactive walkthrough of the Board & Adviewer"
          className="text-[13px] font-semibold flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-opacity hover:opacity-90"
          style={{ color: '#ffffff', background: 'linear-gradient(135deg, #0075a9 0%, #7c3aed 100%)', border: '1px solid rgba(255,255,255,0.25)' }}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d={ICONS.guide} />
          </svg>
          Training
        </a>

        {/* Adviewer — standalone highlighted pill (primary client-facing entry) */}
        <Link
          href="/adviewer/login"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-semibold flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors"
          style={{ color: '#ffffff', background: '#000000', border: '1px solid rgba(255,255,255,0.25)' }}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d={ICONS.adviewer} />
          </svg>
          Adviewer
        </Link>

        {/* Review */}
        <NavDropdown label="Review" open={openMenu === 'review'} onToggle={() => toggle('review')}>
          <Link href="/adviewer/login" target="_blank" rel="noopener noreferrer" className={menuItemClass} onClick={close}>
            <NavIcon d={ICONS.adviewer} /> Adviewer
          </Link>
          <Link href="/copy-tracker" className={menuItemClass} onClick={close}>
            <NavIcon d={ICONS.copyTracker} /> Copy Tracker
          </Link>
        </NavDropdown>

        {/* Plan */}
        <NavDropdown label="Plan" open={openMenu === 'plan'} onToggle={() => toggle('plan')}>
          <Link href="/calendar" className={menuItemClass} onClick={close}>
            <NavIcon d={ICONS.calendar} /> Calendar
          </Link>
          <Link href="/pacing" className={menuItemClass} onClick={close}>
            <NavIcon d={ICONS.pacing} /> Pacing
          </Link>
        </NavDropdown>

        {/* Create */}
        <NavDropdown label="Create" open={openMenu === 'create'} onToggle={() => toggle('create')}>
          <Link href="/atlas" className={menuItemClass} onClick={close}>
            <NavIcon d={ICONS.atlas} /> Atlas Workspace
          </Link>
          <Link href="/videos" className={menuItemClass} onClick={close}>
            <NavIcon d={ICONS.videos} /> Videos
          </Link>
        </NavDropdown>

        {/* Manage */}
        <NavDropdown label="Manage" open={openMenu === 'manage'} onToggle={() => toggle('manage')}>
          <a href="/clients" className={menuItemClass}>
            <NavIcon d={ICONS.clients} /> Clients
          </a>
          <button onClick={() => { close(); onOpenMenu() }} className={menuItemClass}>
            <NavIcon d={ICONS.background} /> Background
          </button>
          <a href="/settings" className={menuItemClass}>
            <NavIcon d={ICONS.settings} /> Settings
          </a>
        </NavDropdown>

        {/* Divider — separates nav from account action */}
        <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(255,255,255,0.1)' }} />

        <button
          onClick={onSignOut}
          className="text-[13px] font-semibold transition-colors"
          style={{ color: '#c4d8ec' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#e4f0fa' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#c4d8ec' }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
