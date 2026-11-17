'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import type { Column } from '@/types'

interface BriefCard {
  id: string
  title: string
  column_id: string
  archived: boolean
  media_type: string | null
  first_draft_deadline: string | null
  flight_start_date: string | null
  clients?: { name: string } | null
}

const DESIGNER_EMAIL = 'designer@example.com'

const DESIGNER_CLIENTS = new Set([
  'Acme Glass',
  'Example Motors',
  'Sample Dental',
  'Demo Powersports',
  'Placeholder Construction',
])

const DONE_KEYWORDS = ['done', 'live', 'complete', 'archive', 'launched']

function isDoneColumn(title: string): boolean {
  return DONE_KEYWORDS.some((k) => title.toLowerCase().includes(k))
}

function getDeadline(card: BriefCard): string | null {
  return card.first_draft_deadline ?? card.flight_start_date ?? null
}

function daysFromNow(dateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(dateStr)
  d.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

interface PlanPriority {
  title: string
  client: string
  type: string | null
  stage: string
  urgency: 'overdue' | 'today' | 'soon' | 'queued' | string
  reason: string
}

interface Plan {
  snapshot: string
  priorities: PlanPriority[]
  flags?: string[]
  tip: string
}

const URGENCY_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  overdue: { label: 'Overdue',  color: '#ef4444', bg: 'rgba(239,68,68,0.12)'   },
  today:   { label: 'Today',    color: '#f59e0b', bg: 'rgba(245,158,11,0.12)'  },
  soon:    { label: 'Soon',     color: '#3b82f6', bg: 'rgba(59,130,246,0.12)'  },
  queued:  { label: 'Queued',   color: '#6b7280', bg: 'rgba(107,114,128,0.10)' },
}

function CookieIconSm() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9"    cy="9.5"  r="1.5" fill="currentColor" />
      <circle cx="14.5" cy="8.5"  r="1.5" fill="currentColor" />
      <circle cx="9.5"  cy="14"   r="1.5" fill="currentColor" />
      <circle cx="15"   cy="13.5" r="1.5" fill="currentColor" />
      <circle cx="12"   cy="11.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[9px] font-bold uppercase tracking-widest mb-2" style={{ color: 'rgba(255,255,255,0.3)' }}>
      {children}
    </p>
  )
}

interface Props {
  cards: BriefCard[]
  columns: Column[]
  userEmail: string
}

export default function CookieBriefModal({ cards, columns, userEmail }: Props) {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)

  const doneColumnIds = useMemo(
    () => new Set(columns.filter((c) => isDoneColumn(c.title)).map((c) => c.id)),
    [columns]
  )

  const columnMap = useMemo(
    () => new Map(columns.map((c) => [c.id, c.title])),
    [columns]
  )

  const myCards = useMemo(
    () =>
      cards.filter(
        (c) =>
          !c.archived &&
          !doneColumnIds.has(c.column_id) &&
          c.clients != null &&
          DESIGNER_CLIENTS.has(c.clients.name)
      ),
    [cards, doneColumnIds]
  )

  const overdueCount = useMemo(
    () => myCards.filter((c) => { const d = getDeadline(c); return d !== null && daysFromNow(d) < 0 }).length,
    [myCards]
  )

  const todayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  const fetchPlan = useCallback(async () => {
    if (myCards.length === 0) {
      setPlan({ snapshot: 'Nothing active right now — enjoy the quiet!', priorities: [], tip: '' })
      return
    }
    setLoading(true)
    try {
      const cardSummaries = myCards.map((c) => {
        const dl = getDeadline(c)
        return {
          title: c.title,
          client: c.clients?.name ?? 'Unknown',
          column: columnMap.get(c.column_id) ?? 'Unknown',
          mediaType: c.media_type,
          deadline: dl,
          daysUntilDeadline: dl ? daysFromNow(dl) : null,
        }
      })
      const res = await fetch('/api/cookie-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cards: cardSummaries, today: todayStr }),
      })
      const data = await res.json() as Plan & { error?: string }
      if (data.error) throw new Error(data.error)
      setPlan({ ...data, priorities: data.priorities ?? [], flags: data.flags ?? [] })
    } catch {
      setPlan({ snapshot: 'Could not load plan — check your connection.', priorities: [], tip: '' })
    } finally {
      setLoading(false)
    }
  }, [myCards, columnMap, todayStr])

  useEffect(() => {
    if (!open || plan !== null) return
    const id = setTimeout(fetchPlan, 0)
    return () => clearTimeout(id)
  }, [open, plan, fetchPlan])

  const handleToggle = useCallback(() => {
    setOpen((v) => {
      if (v) setPlan(null)
      return !v
    })
  }, [])

  if (userEmail !== DESIGNER_EMAIL) return null

  return (
    <>
      {/* Cookie trigger — small amber circle left of Brenda */}
      <div className="fixed bottom-6 z-50" style={{ right: '154px' }}>
        <button
          onClick={handleToggle}
          title="Cookie's Brief"
          aria-label="Cookie's Brief"
          className="relative w-10 h-10 rounded-full text-white flex items-center justify-center transition-all duration-200 hover:scale-110 active:scale-95"
          style={{
            background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
            boxShadow: open
              ? '0 0 0 2px #f59e0b, 0 4px 16px rgba(245,158,11,0.4)'
              : '0 2px 12px rgba(245,158,11,0.3)',
          }}
        >
          <CookieIconSm />
          {overdueCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[8px] font-bold flex items-center justify-center">
              {overdueCount}
            </span>
          )}
        </button>
      </div>

      {/* Backdrop */}
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={handleToggle} />
      )}

      {/* Panel */}
      {open && (
        <div
          className="fixed bottom-24 z-50 w-96 max-h-[74vh] rounded-2xl overflow-hidden flex flex-col"
          style={{
            right: '154px',
            background: 'rgba(11, 13, 18, 0.97)',
            border: '1px solid rgba(245,158,11,0.18)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.8), 0 0 40px rgba(245,158,11,0.06)',
            backdropFilter: 'blur(24px)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' }}>
                <CookieIconSm />
              </div>
              <div>
                <p className="text-sm font-semibold text-white leading-none">Cookie&apos;s Brief</p>
                <p className="text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>{todayStr}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); setPlan(null); fetchPlan() }}
                disabled={loading}
                title="Refresh"
                className="text-white/20 hover:text-white/50 transition-colors disabled:opacity-20"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  style={loading ? { animation: 'cookieSpin 1s linear infinite' } : {}}>
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
              </button>
              <button onClick={handleToggle} className="text-white/20 hover:text-white/50 transition-colors text-sm leading-none">✕</button>
            </div>
          </div>

          {/* Content */}
          <div className="overflow-y-auto flex-1 py-3 space-y-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <div className="flex gap-1.5">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="w-1.5 h-1.5 rounded-full"
                      style={{ background: '#f59e0b', animation: `brendaWave 0.7s ease-in-out ${i * 0.15}s infinite alternate` }} />
                  ))}
                </div>
                <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.25)' }}>Building your plan…</p>
              </div>
            ) : plan ? (
              <>
                {/* Snapshot */}
                <div className="px-4">
                  <p className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.6)' }}>
                    {plan.snapshot}
                  </p>
                </div>

                {/* Priority list */}
                {(plan.priorities ?? []).length > 0 && (
                  <div className="px-4">
                    <SectionLabel>Priority Order</SectionLabel>
                    <div className="space-y-2">
                      {(plan.priorities ?? []).map((p, i) => {
                        const urg = URGENCY_CONFIG[p.urgency] ?? URGENCY_CONFIG.queued
                        return (
                          <div key={i} className="rounded-xl p-3 flex gap-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                            {/* Number */}
                            <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold"
                              style={{ background: urg.bg, color: urg.color }}>
                              {i + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-xs font-semibold text-white leading-snug">{p.title}</p>
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                                  style={{ background: urg.bg, color: urg.color }}>
                                  {urg.label}
                                </span>
                              </div>
                              <p className="text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }}>
                                {p.client}{p.type ? ` · ${p.type}` : ''} · {p.stage}
                              </p>
                              <p className="text-[10px] mt-1.5 leading-snug" style={{ color: 'rgba(255,255,255,0.5)' }}>
                                {p.reason}
                              </p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Flags */}
                {plan.flags && plan.flags.length > 0 && (
                  <div className="px-4">
                    <SectionLabel>Heads Up</SectionLabel>
                    <div className="space-y-1.5">
                      {plan.flags.map((flag, i) => (
                        <div key={i} className="flex gap-2 items-start">
                          <span className="text-[10px] mt-0.5" style={{ color: '#f59e0b' }}>⚑</span>
                          <p className="text-[11px] leading-snug" style={{ color: 'rgba(255,255,255,0.5)' }}>{flag}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Design tip */}
                {plan.tip && (
                  <div className="mx-4 rounded-xl px-3 py-2.5" style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.15)' }}>
                    <p className="text-[9px] font-bold uppercase tracking-widest mb-1" style={{ color: '#f59e0b' }}>Design Angle</p>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>{plan.tip}</p>
                  </div>
                )}
              </>
            ) : null}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 shrink-0 text-center" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.15)' }}>
              {myCards.length} active card{myCards.length !== 1 ? 's' : ''} · just for you
            </p>
          </div>
        </div>
      )}

      <style>{`@keyframes cookieSpin { to { transform: rotate(360deg); } }`}</style>
    </>
  )
}
