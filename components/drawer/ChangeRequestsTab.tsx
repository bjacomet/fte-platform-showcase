'use client'

import { useEffect, useState } from 'react'
import type { AdviewerCampaignFile, ReviewPin, ReviewRound } from '@/types'
import ExternalRef from '@/components/ExternalRef'

interface FileGroup {
  file_id: string
  file_name: string
  dimensions: string | null
  file_url: string | null
  pins: ReviewPin[]
}

interface SlideGroup {
  slide_id: string
  position: number
  image_url: string | null
  pins: ReviewPin[]
}

interface CardFeedback {
  link_id: string
  pins: ReviewPin[]
  file_groups: FileGroup[]
  slide_groups: SlideGroup[]
  resolved_pins: string[]
  note: string | null
  reviewer: string | null
  submitted_at: string | null
  preview_image_url: string | null
  history: ReviewRound[]
}

interface CampaignFeedback {
  campaign_id: string
  campaign_title: string
  campaign_token: string
  submitted_at: string | null
  reviewer: string | null
  files: AdviewerCampaignFile[]
  card_feedback: CardFeedback | null
}

interface Props {
  cardId: string
  boxFolderId?: string | null
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)/i
const EMPTY_SET: ReadonlySet<string> = new Set()

function PinRow({
  pin, idx, resolved, onToggle,
}: {
  pin: ReviewPin
  idx: number
  resolved: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={`mt-0.5 shrink-0 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center ${
          resolved ? 'bg-green-500/30 text-green-400' : 'bg-amber-500 text-gray-900'
        }`}
      >
        {resolved ? '✓' : idx + 1}
      </span>
      <span
        className={`flex-1 min-w-0 text-sm leading-snug ${
          resolved ? 'text-gray-500 line-through' : 'text-gray-200'
        }`}
      >
        {pin.note}
      </span>
      <button
        onClick={onToggle}
        className={`mt-px shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors ${
          resolved
            ? 'text-gray-500 hover:text-gray-300'
            : 'text-green-400 hover:text-green-300 hover:bg-green-500/10'
        }`}
      >
        {resolved ? 'Undo' : 'Resolve'}
      </button>
    </div>
  )
}

function ViewCommentsLink({ token, only, hash }: { token: string; only: string; hash?: string }) {
  return (
    <a
      href={`/adviewer/c/${token}?only=${encodeURIComponent(only)}${hash ?? ''}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 transition-colors"
    >
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
      </svg>
      View Comments
    </a>
  )
}

export default function ChangeRequestsTab({ cardId, boxFolderId }: Props) {
  const [campaigns, setCampaigns] = useState<CampaignFeedback[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Resolved pin IDs keyed by campaign link id (adviewer_campaign_cards.id).
  // Seeded from the fetched resolved_pins, then mutated optimistically on toggle.
  const [resolved, setResolved] = useState<Record<string, Set<string>>>({})
  async function toggleResolve(linkId: string, pinId: string) {
    const nowResolved = !(resolved[linkId]?.has(pinId) ?? false)
    setResolved((prev) => {
      const next = new Set(prev[linkId] ?? [])
      if (nowResolved) next.add(pinId)
      else next.delete(pinId)
      return { ...prev, [linkId]: next }
    })
    try {
      const res = await fetch('/api/adviewer/card-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkId, pinId, resolved: nowResolved }),
      })
      if (!res.ok) throw new Error('save failed')
    } catch {
      // Revert on failure so the UI never lies about what was persisted.
      setResolved((prev) => {
        const next = new Set(prev[linkId] ?? [])
        if (nowResolved) next.delete(pinId)
        else next.add(pinId)
        return { ...prev, [linkId]: next }
      })
    }
  }

  useEffect(() => {
    let active = true
    fetch(`/api/adviewer/card-feedback?cardId=${cardId}`)
      .then((r) => r.json())
      .then((d: { campaigns?: CampaignFeedback[]; error?: string }) => {
        if (!active) return
        if (d.error) { setError(d.error); return }
        const list = d.campaigns ?? []
        setCampaigns(list)
        const seed: Record<string, Set<string>> = {}
        for (const c of list) {
          if (c.card_feedback) seed[c.card_feedback.link_id] = new Set(c.card_feedback.resolved_pins)
        }
        setResolved(seed)
      })
      .catch(() => { if (active) setError('Failed to load change requests') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [cardId])

  if (loading) {
    return (
      <div className="p-4 text-sm text-gray-500 animate-pulse">Loading change requests…</div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-400">{error}</div>
    )
  }

  if (campaigns.length === 0) {
    return (
      <div className="p-6 text-center space-y-1">
        <p className="text-sm text-gray-400">No change requests yet.</p>
        <p className="text-xs text-gray-600">Pin annotations from Adviewer will appear here when a client submits feedback.</p>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-6">
      {campaigns.map((c) => {
        const cf = c.card_feedback
        const totalPins =
          c.files.reduce((n, f) => n + (f.client_notes?.pins?.length ?? 0), 0) +
          (cf?.pins.length ?? 0) +
          (cf?.file_groups.reduce((n, g) => n + g.pins.length, 0) ?? 0) +
          (cf?.slide_groups.reduce((n, g) => n + g.pins.length, 0) ?? 0)
        return (
          <div key={c.campaign_id} className="space-y-3">

            {/* Campaign header */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <a
                  href={`/adviewer/c/${c.campaign_token}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-semibold text-blue-400 hover:text-blue-300 transition-colors truncate block"
                >
                  {c.campaign_title}
                </a>
                {(c.reviewer || c.submitted_at) && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    From {c.reviewer ?? 'Client'}
                    {c.submitted_at
                      ? ` · ${new Date(c.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                      : ''}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full">
                {totalPins} {totalPins === 1 ? 'pin' : 'pins'}
              </span>
            </div>

            {/* Card-level pin feedback — pins dropped on the ad preview (single-file cards) */}
            {cf && cf.pins.length > 0 && (
              <div className="bg-gray-800/60 rounded-lg border border-gray-700/50 overflow-hidden">
                {cf.preview_image_url && (
                  <div className="bg-gray-900 border-b border-gray-700/50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={cf.preview_image_url}
                      alt="Ad preview"
                      className="w-full max-h-48 object-contain"
                    />
                  </div>
                )}
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
                      Ad preview
                    </p>
                    <ViewCommentsLink token={c.campaign_token} only={cf.link_id} />
                  </div>
                  {cf.pins.map((pin, idx) => (
                    <PinRow
                      key={pin.id}
                      pin={pin}
                      idx={idx}
                      resolved={(resolved[cf.link_id] ?? EMPTY_SET).has(pin.id)}
                      onToggle={() => void toggleResolve(cf.link_id, pin.id)}
                    />
                  ))}
                  {cf.note && (
                    <p className="text-xs text-gray-400 border-t border-gray-700/50 pt-2 mt-1">
                      {cf.note}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Per-slide pin feedback — carousel cards (one block per slide, like
                file_groups per size). Deep link jumps to that slide in Adviewer. */}
            {cf?.slide_groups.map((g) => (
              <div
                key={g.slide_id}
                className="bg-gray-800/60 rounded-lg border border-gray-700/50 overflow-hidden"
              >
                {g.image_url && (
                  <div className="bg-gray-900 border-b border-gray-700/50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.image_url} alt={`Slide ${g.position + 1}`} className="w-full max-h-48 object-contain" />
                  </div>
                )}
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
                      Slide {g.position + 1}
                    </p>
                    <ViewCommentsLink token={c.campaign_token} only={cf.link_id} hash={`#slide-${g.position}`} />
                  </div>
                  {g.pins.map((pin, idx) => (
                    <PinRow
                      key={pin.id}
                      pin={pin}
                      idx={idx}
                      resolved={(resolved[cf.link_id] ?? EMPTY_SET).has(pin.id)}
                      onToggle={() => void toggleResolve(cf.link_id, pin.id)}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* Per-size pin feedback — multi-file display cards (one block per size) */}
            {cf?.file_groups.map((g) => {
              const isImage = g.file_url ? IMAGE_RE.test(g.file_url) : false
              return (
                <div
                  key={g.file_id}
                  className="bg-gray-800/60 rounded-lg border border-gray-700/50 overflow-hidden"
                >
                  {isImage && g.file_url && (
                    <div className="bg-gray-900 border-b border-gray-700/50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={g.file_url} alt={g.file_name} className="w-full max-h-48 object-contain" />
                    </div>
                  )}
                  <div className="p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide truncate">
                        {g.dimensions ?? g.file_name}
                      </p>
                      <ViewCommentsLink token={c.campaign_token} only={`${cf.link_id}::${g.file_id}`} />
                    </div>
                    {g.pins.map((pin, idx) => (
                      <PinRow
                        key={pin.id}
                        pin={pin}
                        idx={idx}
                        resolved={(resolved[cf.link_id] ?? EMPTY_SET).has(pin.id)}
                        onToggle={() => void toggleResolve(cf.link_id, pin.id)}
                      />
                    ))}
                  </div>
                </div>
              )
            })}

            {/* Files with pins (standalone uploaded files) */}
            {c.files.map((f) => {
              const pins = f.client_notes?.pins ?? []
              if (pins.length === 0) return null
              const isImage = IMAGE_RE.test(f.file_url)
              return (
                <div
                  key={f.id}
                  className="bg-gray-800/60 rounded-lg border border-gray-700/50 overflow-hidden"
                >
                  {/* File thumbnail */}
                  {isImage && (
                    <div className="bg-gray-900 border-b border-gray-700/50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={f.file_url}
                        alt={f.file_name}
                        className="w-full max-h-48 object-contain"
                      />
                    </div>
                  )}

                  <div className="p-3 space-y-2">
                    <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
                      {f.file_name}
                    </p>
                    {pins.map((pin, idx) => (
                      <div key={pin.id} className="flex items-start gap-2.5">
                        <span className="mt-0.5 shrink-0 w-5 h-5 rounded-full bg-amber-500 text-[10px] font-bold text-gray-900 flex items-center justify-center">
                          {idx + 1}
                        </span>
                        <span className="text-sm text-gray-200 leading-snug">{pin.note}</span>
                      </div>
                    ))}
                    {f.client_notes?.note && (
                      <p className="text-xs text-gray-400 border-t border-gray-700/50 pt-2 mt-1">
                        {f.client_notes.note}
                      </p>
                    )}
                    {boxFolderId && (
                      <div className="pt-1">
                        <ExternalRef kind="Box Drive file" note="working PSD" />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Resolved history — past review rounds whose file was replaced/deleted */}
            {cf && cf.history.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer text-[11px] font-medium text-gray-500 hover:text-gray-300 transition-colors select-none">
                  {cf.history.length} resolved {cf.history.length === 1 ? 'round' : 'rounds'} · history
                </summary>
                <div className="mt-2 space-y-2">
                  {cf.history.map((h, i) => (
                    <div
                      key={`${h.file_id}-${h.round}-${i}`}
                      className="bg-gray-900/40 rounded-lg border border-gray-800 overflow-hidden opacity-80"
                    >
                      {h.thumb_url && (
                        <div className="bg-gray-900 border-b border-gray-800">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={h.thumb_url} alt={h.file_name} className="w-full max-h-32 object-contain" />
                        </div>
                      )}
                      <div className="p-3 space-y-1.5">
                        <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                          Round {h.round} · {h.dimensions ?? h.file_name} · resolved
                        </p>
                        {h.pins.map((pin, idx) => (
                          <div key={pin.id} className="flex items-start gap-2.5">
                            <span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-green-500/30 text-green-400 text-[9px] font-bold flex items-center justify-center">
                              ✓
                            </span>
                            <span className="text-xs text-gray-500 line-through leading-snug">{pin.note || `Pin ${idx + 1}`}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
