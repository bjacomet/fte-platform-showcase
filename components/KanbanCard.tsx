import { memo, useState, useRef, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { Draggable } from '@hello-pangea/dnd'
import type { BoardCard, Column, WorkStatus } from '@/types'
import { WORK_STATUSES, WORK_STATUS_LABELS } from '@/types'
import { isSupabaseImageHost } from '@/lib/imageHost'
import MediaTypeBadge from './MediaTypeBadge'
import { prefetchCard } from '@/lib/cardCache'

// Per-session set of card IDs whose /card/[id] route has been prefetched
const prefetchedRoutes = new Set<string>()

// Pill colors for the internal work-status badge (kept distinct from the
// approval-status dot so the two aren't confused at a glance).
const WORK_STATUS_PILL: Record<WorkStatus, string> = {
  in_design: 'text-sky-300 bg-sky-500/15 border-sky-400/40',
  internal_review: 'text-violet-300 bg-violet-500/15 border-violet-400/40',
  pending_approval: 'text-amber-300 bg-amber-500/15 border-amber-400/40',
  complete: 'text-emerald-300 bg-emerald-500/15 border-emerald-400/40',
}

// Predict the most logical next column for a card based on its state.
// Uses position order + approval_status signals — no column names hardcoded.
function predictNextColumn(card: BoardCard, columns: Column[]): Column | null {
  if (columns.length === 0) return null
  const sorted = [...columns].sort((a, b) => a.position - b.position)
  const currentIdx = sorted.findIndex((c) => c.id === card.column_id)
  if (currentIdx === -1) return null

  // changes_requested → step back (return for revisions)
  if (card.approval_status === 'changes_requested' && currentIdx > 0) {
    return sorted[currentIdx - 1]
  }
  // approved → skip forward two columns (past the review stage)
  if (card.approval_status === 'approved') {
    return sorted[currentIdx + 2] ?? sorted[currentIdx + 1] ?? null
  }
  // deadline passed and not in last column → nudge forward
  if (
    card.first_draft_deadline &&
    new Date(card.first_draft_deadline) < new Date() &&
    currentIdx < sorted.length - 1
  ) {
    return sorted[currentIdx + 1]
  }
  // default: next column in sequence
  return currentIdx < sorted.length - 1 ? sorted[currentIdx + 1] : null
}

interface Props {
  card: BoardCard
  index: number
  columns: Column[]
  onOpen: (card: BoardCard) => void
  onFilesDropped: (card: BoardCard, files: File[]) => void
  onOpenClient?: (clientId: string) => void
  onQuickMove: (cardId: string, destColumnId: string) => void
  onQuickCopy: (card: BoardCard) => void
  onArchive: (cardId: string) => Promise<void>
  onDelete: (cardId: string) => Promise<void>
  onTogglePending: (cardId: string) => Promise<void>
  onSetWorkStatus: (cardId: string, status: WorkStatus | null) => Promise<void>
  selected: boolean
  onToggleSelect: (cardId: string) => void
  /** The card's client's designer (clients.designer_name), looked up by the board. */
  designerName?: string | null
}

export default memo(function KanbanCard({ card, index, columns, onOpen, onFilesDropped, onOpenClient, onQuickMove, onQuickCopy, onArchive, onDelete, onTogglePending, onSetWorkStatus, selected, onToggleSelect, designerName }: Props) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [fileDragOver, setFileDragOver] = useState(false)
  const [mode, setMode] = useState<'main' | 'move' | 'confirmDelete'>('main')
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [copyLinkLabel, setCopyLinkLabel] = useState<'Copy link' | 'Copied!'>('Copy link')
  const [workMenuOpen, setWorkMenuOpen] = useState(false)
  const [workMenuPos, setWorkMenuPos] = useState<{ top: number; left: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const workBtnRef = useRef<HTMLButtonElement>(null)
  const workMenuRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  // Debounce timers for hover prefetch (#1 card data, #5 route)
  const cardHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const iconHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [approving, setApproving] = useState(false)
  const [approveConfirm, setApproveConfirm] = useState<{ title: string; unapprovedFiles?: number }[] | null>(null)
  const [approveMsg, setApproveMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const amApprove = async (confirm = false) => {
    setApproving(true)
    try {
      const res = await fetch('/api/adviewer/card-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: card.id, confirm }),
      })
      const data = await res.json()
      if (!res.ok) {
        setApproveMsg({ text: data?.error ?? 'Approve failed', kind: 'err' })
        setTimeout(() => setApproveMsg(null), 6000)
        return
      }
      if (data.needsConfirm) { setApproveConfirm(data.campaignsToArchive ?? []); return }
      setApproveConfirm(null)
      const archived = (data.archivedCampaignIds ?? []).length
      if (archived > 0) {
        setApproveMsg({ text: `Approved — sent ${archived} campaign${archived > 1 ? 's' : ''} to the Lookbook`, kind: 'ok' })
        setTimeout(() => setApproveMsg(null), 6000)
      }
      router.refresh()
    } finally { setApproving(false) }
  }

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return
    function handler(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false)
        setMode('main')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // Close on Escape
  useEffect(() => {
    if (!menuOpen) return
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') { setMenuOpen(false); setMode('main') }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [menuOpen])

  // Work-status mini-menu: close on outside click (ignores clicks on the pill
  // button itself, which toggles). Rendered position:fixed to escape column clip.
  useEffect(() => {
    if (!workMenuOpen) return
    function handler(e: MouseEvent) {
      if (
        workMenuRef.current && !workMenuRef.current.contains(e.target as Node) &&
        workBtnRef.current && !workBtnRef.current.contains(e.target as Node)
      ) {
        setWorkMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [workMenuOpen])

  const toggleWorkMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = workBtnRef.current?.getBoundingClientRect()
    if (rect) setWorkMenuPos({ top: rect.bottom + 4, left: rect.left })
    setWorkMenuOpen((v) => !v)
  }, [])

  const chooseWorkStatus = useCallback((status: WorkStatus | null) => {
    setWorkMenuOpen(false)
    void onSetWorkStatus(card.id, status)
  }, [card.id, onSetWorkStatus])

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    const rect = cardRef.current?.getBoundingClientRect()
    if (rect) {
      const MENU_W = 256  // w-64
      const MENU_H = 420  // conservative max (move list is capped at max-h-48)
      const GAP = 8
      // Open beside the card (Trello-style) so the card stays visible; flip to the
      // card's left if opening right would overflow the viewport edge.
      let left = rect.right + GAP
      if (left + MENU_W > window.innerWidth - GAP) {
        left = Math.max(GAP, rect.left - MENU_W - GAP)
      }
      const top = Math.max(GAP, Math.min(rect.top, window.innerHeight - MENU_H - GAP))
      setMenuPos({ top, left })
    }
    setMode('main')
    setMenuOpen((v) => !v)
  }, [])

  const closeMenu = useCallback(() => { setMenuOpen(false); setMode('main') }, [])

  // Archive: close menu immediately then fire (card disappears optimistically)
  const handleArchive = useCallback(() => { closeMenu(); onArchive(card.id) }, [card.id, onArchive, closeMenu])
  // Delete: await the result so the confirm UI stays visible; rollback in Board.tsx restores the card here
  const handleDelete = useCallback(async () => { await onDelete(card.id); closeMenu() }, [card.id, onDelete, closeMenu])

  const handleCopyLink = useCallback(() => {
    const url = `${window.location.origin}/card/${card.id}`
    navigator.clipboard.writeText(url).then(() => {
      setCopyLinkLabel('Copied!')
      setTimeout(() => setCopyLinkLabel('Copy link'), 2000)
    })
  }, [card.id])

  const otherColumns = columns.filter((c) => c.id !== card.column_id)
  const suggested = predictNextColumn(card, columns)

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={(node) => { provided.innerRef(node); cardRef.current = node }}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={(e) => {
            if (snapshot.isDragging) return
            // Shift/Cmd/Ctrl-click toggles multi-select instead of opening the card.
            if (e.shiftKey || e.metaKey || e.ctrlKey) { e.preventDefault(); onToggleSelect(card.id); return }
            onOpen(card)
          }}
          onMouseEnter={() => {
            cardHoverTimer.current = setTimeout(() => prefetchCard(card.id), 200)
          }}
          onMouseLeave={() => {
            if (cardHoverTimer.current) { clearTimeout(cardHoverTimer.current); cardHoverTimer.current = null }
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            if (!fileDragOver) setFileDragOver(true)
          }}
          onDragLeave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setFileDragOver(false)
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            e.stopPropagation()
            setFileDragOver(false)
            const files = Array.from(e.dataTransfer.files)
            if (files.length) onFilesDropped(card, files)
          }}
          className={`
            group relative border rounded-lg cursor-grab active:cursor-grabbing
            transition-[color,background-color,border-color,box-shadow] select-none overflow-hidden
            ${fileDragOver ? 'ring-2 ring-[#38b6ff] ring-offset-2 ring-offset-[#001428] border-[#38b6ff]' : ''}
            ${selected ? 'ring-2 ring-blue-400 ring-offset-2 ring-offset-[#001428]' : ''}
            ${snapshot.isDragging
              ? 'border-[#0075a9] shadow-2xl shadow-black/50 rotate-3 scale-[1.03] bg-[#002a4a]'
              : 'bg-[#00152a] border-[#0075a9]/45 shadow-lg shadow-black/45 hover:border-[#0075a9]/70 hover:bg-[#002a4a]'}
          `}
          style={(() => {
            const dndStyle = provided.draggableProps.style ?? {}
            let base: React.CSSProperties = dndStyle
            if (card.first_draft_deadline) {
              const days = Math.ceil((new Date(card.first_draft_deadline).getTime() - Date.now()) / 86400000)
              const color = days >= 3 ? '#22c55e' : days >= 1 ? '#f97316' : '#ef4444'
              base = { ...dndStyle, borderLeft: `3px solid ${color}` }
            }
            // Speed up the drop: the library's default drop duration (~0.33s) reads
            // as a slow snap. A very short eased-out glide lands the card promptly.
            if (snapshot.isDropAnimating && snapshot.dropAnimation) {
              return { ...base, transition: `transform 0.09s cubic-bezier(0.2, 0, 0, 1)` }
            }
            return base
          })()}
        >
          {/* Cover image — shown when a preview image is set */}
          {card.preview_image_url && (
            <div className="relative w-full bg-gray-900 flex-none" style={{ height: '160px' }}>
              <Image
                src={card.preview_image_url}
                alt=""
                fill
                sizes="280px"
                className="object-cover"
                unoptimized={!isSupabaseImageHost(card.preview_image_url)}
              />
            </div>
          )}

          <div className="p-3">
          {/* Quick-action button — visible on hover */}
          {!snapshot.isDragging && (
            <>
              <a
                href={`/card/${card.id}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                onMouseEnter={() => {
                  iconHoverTimer.current = setTimeout(() => {
                    if (!prefetchedRoutes.has(card.id)) {
                      router.prefetch(`/card/${card.id}`)
                      prefetchedRoutes.add(card.id)
                    }
                  }, 300)
                }}
                onMouseLeave={() => {
                  if (iconHoverTimer.current) { clearTimeout(iconHoverTimer.current); iconHoverTimer.current = null }
                }}
                title="Open in new tab"
                className="absolute top-1.5 right-9 opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded bg-[#003057]/90 hover:bg-[#0075a9] text-[#c8c8c8] hover:text-white transition-all z-10"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              <button
                ref={buttonRef}
                onClick={openMenu}
                className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded bg-[#003057]/90 hover:bg-[#0075a9] text-[#c8c8c8] hover:text-white transition-all z-10"
                title="Quick actions"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
            </>
          )}

          {card.clients?.name && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); if (card.client_id) onOpenClient?.(card.client_id) }}
                className="block max-w-full truncate pr-14 text-[10px] font-semibold tracking-wide text-[#38b6ff] hover:text-[#7cc9ff] transition-colors"
              >
                {card.clients.name}
              </button>
              {designerName && (
                <span
                  className="mt-1 inline-block text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-[#73308a]/25 text-[#e9c6f5] border border-[#73308a]/50"
                  title={`${card.clients.name} belongs to ${designerName}`}
                >
                  {designerName}
                </span>
              )}
              <div className="mt-1.5 mb-2 border-t border-[#38b6ff]/25" />
            </>
          )}

          <p className="text-sm text-[#e2e8f0] font-semibold leading-snug line-clamp-2 pr-14 tracking-wide">
            {card.title}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {card.media_type && <MediaTypeBadge type={card.media_type} />}

            {/* Work status — internal production state (In Design → … → Complete).
               Distinct from the client approval dot. Click the pill to set/change;
               when unset a ghost "+ Status" appears on hover. */}
            {card.work_status ? (
              <button
                ref={workBtnRef}
                onClick={toggleWorkMenu}
                title="Work status — click to change"
                className={`text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase border transition-colors ${WORK_STATUS_PILL[card.work_status]}`}
              >
                {WORK_STATUS_LABELS[card.work_status]}
              </button>
            ) : (
              <button
                ref={workBtnRef}
                onClick={toggleWorkMenu}
                title="Set work status"
                className="text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase opacity-0 group-hover:opacity-100 transition-all text-[#c8c8c8]/45 border border-[#c8c8c8]/20 hover:text-[#38b6ff] hover:border-[#38b6ff]/40"
              >
                + Status
              </button>
            )}
            {workMenuOpen && workMenuPos && (
              <div
                ref={workMenuRef}
                onClick={(e) => e.stopPropagation()}
                style={{ position: 'fixed', top: workMenuPos.top, left: workMenuPos.left }}
                className="z-50 w-44 rounded-lg border border-[#38b6ff]/25 bg-[#0d1b2a] shadow-2xl overflow-hidden py-1"
              >
                {WORK_STATUSES.map((s) => (
                  <button
                    key={s}
                    onClick={(e) => { e.stopPropagation(); chooseWorkStatus(s) }}
                    className={`w-full text-left text-[11px] px-3 py-1.5 hover:bg-white/5 transition-colors ${card.work_status === s ? 'text-white font-semibold' : 'text-[#c8c8c8]'}`}
                  >
                    {WORK_STATUS_LABELS[s]}
                  </button>
                ))}
                {card.work_status && (
                  <button
                    onClick={(e) => { e.stopPropagation(); chooseWorkStatus(null) }}
                    className="w-full text-left text-[11px] px-3 py-1.5 mt-1 border-t border-white/10 text-[#c8c8c8]/60 hover:bg-white/5 hover:text-white transition-colors"
                  >
                    Clear status
                  </button>
                )}
              </div>
            )}

            {/* Re-run flag — set by the Copy Tracker restart flow, cleared when
               the card re-enters Done. Restart the existing campaign; don't rebuild. */}
            {card.restart_requested_at && (
              <span
                title="Adjustment to an existing campaign — restart, don't rebuild"
                className="text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase"
                style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)' }}
              >
                ↻ Re-run
              </span>
            )}

            {/* Pending toggle — synced with the card-menu "Mark/Remove Pending".
               ON: orange pill, click sends the card to Queue for rework.
               OFF: ghost pill, appears on hover to mark the card Pending. */}
            {card.is_pending ? (
              <button
                onClick={(e) => { e.stopPropagation(); onTogglePending(card.id) }}
                title="Pending — click to send to Queue for rework"
                className="text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase transition-colors"
                style={{ color: '#f97316', background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.3)' }}
              >
                Pending
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); onTogglePending(card.id) }}
                title="Mark as Pending"
                className="text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase opacity-0 group-hover:opacity-100 transition-all text-[#c8c8c8]/45 border border-[#c8c8c8]/20 hover:text-[#f97316] hover:border-[#f97316]/40"
              >
                + Pending
              </button>
            )}

            {card.adpiler_preview_url && card.approval_status !== 'approved' && (
              <button
                onClick={(e) => { e.stopPropagation(); void amApprove(false) }}
                disabled={approving}
                title="Approve (client sign-off) — resolve pins & mark approved"
                className="text-[9px] font-bold px-1.5 py-0.5 rounded tracking-widest uppercase opacity-0 group-hover:opacity-100 transition-all text-emerald-300/70 border border-emerald-400/25 hover:text-emerald-300 hover:border-emerald-400/50 disabled:opacity-40"
              >
                {approving ? '…' : '✓ Approve'}
              </button>
            )}

            {card.approval_status === 'changes_requested' ? (
              <span
                className="flex-shrink-0 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-orange-400/20 text-orange-300 border border-orange-400/40"
                title="Client requested changes"
              >
                <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M3 3a1 1 0 011-1h12l-2.5 3.5L16 9H4v8a1 1 0 11-2 0V3z" />
                </svg>
                Changes
              </span>
            ) : card.approval_status && card.approval_status !== 'none' && (
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${{
                  approved: 'bg-green-400',
                  pending: 'bg-yellow-400',
                  rejected: 'bg-red-400',
                }[card.approval_status] ?? ''}`}
                title={card.approval_status.replace('_', ' ')}
              />
            )}

          </div>

          {card.assignee_id && (
            <div className="mt-2 flex items-center gap-1">
              <div className="w-5 h-5 rounded-full bg-[#0075a9] flex items-center justify-center text-[9px] text-white font-bold">
                {card.assignee_id.charAt(0).toUpperCase()}
              </div>
            </div>
          )}

          {card.adpiler_preview_url && (
            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
              <a
                href={card.adpiler_preview_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 rounded-full text-white leading-none transition-opacity hover:opacity-90"
                style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)', boxShadow: '0 2px 8px rgba(124,58,237,0.35)' }}
              >
                <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-white/25 text-[8px] leading-none">→</span> View in Adviewer
              </a>
            </div>
          )}

          </div>{/* end p-3 */}

          {/* Fixed-position popup — not clipped by column overflow */}
          {menuOpen && menuPos && (
            <div
              ref={menuRef}
              style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, zIndex: 9999 }}
              className="w-64 bg-[#001428] border border-[#0075a9]/30 rounded-lg shadow-2xl shadow-black/60 overflow-hidden backdrop-blur-md"
              onClick={(e) => e.stopPropagation()}
            >
              {mode === 'main' ? (
                <>
                  <div className="px-3 py-2 border-b border-[#0075a9]/20">
                    <p className="text-[10px] font-bold text-[#0075a9]/70 uppercase tracking-widest">Card actions</p>
                  </div>

                  {/* Open card */}
                  <button
                    onClick={() => { onOpen(card); closeMenu() }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-[#c8c8c8] hover:bg-[#003057]/60 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-[#0075a9]/70 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    Open card
                  </button>

                  <div className="border-t border-[#0075a9]/10 my-0.5" />

                  {/* Move */}
                  <button
                    onClick={() => setMode('move')}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-[#c8c8c8] hover:bg-[#003057]/60 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-[#0075a9]/70 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    Move
                    <svg className="w-3 h-3 text-[#0075a9]/40 ml-auto flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>

                  {/* Copy card */}
                  <button
                    onClick={() => { onQuickCopy(card); closeMenu() }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-[#c8c8c8] hover:bg-[#003057]/60 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-[#0075a9]/70 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy card
                  </button>

                  {/* Copy link */}
                  <button
                    onClick={handleCopyLink}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-[#c8c8c8] hover:bg-[#003057]/60 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-[#0075a9]/70 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    {copyLinkLabel}
                  </button>

                  {/* Pending toggle */}
                  <button
                    onClick={() => { onTogglePending(card.id); closeMenu() }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-[#003057]/60 transition-colors"
                    style={{ color: card.is_pending ? '#f97316' : '#c8c8c8' }}
                  >
                    <svg className="w-3.5 h-3.5 flex-none" style={{ color: card.is_pending ? '#f97316' : 'rgba(0,117,169,0.7)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {card.is_pending ? 'Remove from Pending (→ Queue)' : 'Mark as Pending'}
                  </button>

                  <div className="border-t border-[#0075a9]/10 my-0.5" />

                  {/* Archive */}
                  <button
                    onClick={handleArchive}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-[#c8c8c8] hover:bg-[#003057]/60 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 text-[#0075a9]/70 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                    </svg>
                    Archive
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => setMode('confirmDelete')}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-red-400 hover:bg-red-900/30 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Delete
                  </button>
                </>
              ) : mode === 'confirmDelete' ? (
                <>
                  <div className="px-3 py-2 border-b border-red-900/40">
                    <p className="text-[10px] font-bold text-red-400/80 uppercase tracking-widest">Confirm delete</p>
                  </div>
                  <div className="px-3 py-3 space-y-2">
                    <p className="text-xs text-[#c8c8c8]/70 leading-snug">This permanently removes the card. Cannot be undone.</p>
                    <button
                      onClick={handleDelete}
                      className="w-full py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-semibold transition-colors"
                    >
                      Yes, delete
                    </button>
                    <button
                      onClick={() => setMode('main')}
                      className="w-full py-1.5 rounded bg-[#003057]/60 hover:bg-[#003057] text-[#c8c8c8] text-xs transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="px-3 py-2 border-b border-[#0075a9]/20 flex items-center gap-1.5">
                    <button
                      onClick={() => setMode('main')}
                      className="text-[#c8c8c8]/50 hover:text-[#0075a9] transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <p className="text-[10px] font-bold text-[#0075a9]/70 uppercase tracking-widest">Move to</p>
                  </div>

                  {/* Suggested section */}
                  {suggested && (
                    <>
                      <div className="px-3 pt-2 pb-1">
                        <p className="text-[9px] font-bold text-[#0075a9]/50 uppercase tracking-widest">Suggested</p>
                      </div>
                      <button
                        onClick={() => { onQuickMove(card.id, suggested.id); closeMenu() }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[#e2e8f0] hover:bg-[#003057]/60 transition-colors"
                      >
                        <svg
                          className={`w-3.5 h-3.5 flex-none ${card.approval_status === 'changes_requested' ? 'text-orange-400' : 'text-[#0075a9]'}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                        >
                          {card.approval_status === 'changes_requested'
                            ? <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                            : <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                          }
                        </svg>
                        <span className="font-medium leading-snug text-left break-words">{suggested.title}</span>
                      </button>
                      <div className="border-t border-[#0075a9]/10 mx-3 my-1" />
                      <div className="px-3 pb-1">
                        <p className="text-[9px] font-bold text-[#0075a9]/50 uppercase tracking-widest">All columns</p>
                      </div>
                    </>
                  )}

                  {/* Full column list */}
                  <div className="max-h-48 overflow-y-auto pb-1">
                    {otherColumns.map((col) => (
                      <button
                        key={col.id}
                        onClick={() => { onQuickMove(card.id, col.id); closeMenu() }}
                        className="w-full text-left px-3 py-2 text-sm text-[#c8c8c8] hover:bg-[#003057]/60 transition-colors whitespace-normal break-words leading-snug"
                      >
                        {col.title}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {approveMsg && (
            <div
              onClick={(e) => { e.stopPropagation(); setApproveMsg(null) }}
              className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[80] max-w-sm px-4 py-2.5 rounded-xl text-sm font-medium shadow-lg cursor-pointer ${approveMsg.kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`}
            >
              {approveMsg.text}
            </div>
          )}

          {approveConfirm && (
            <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70" onClick={(e) => { e.stopPropagation(); setApproveConfirm(null) }}>
              <div className="w-full max-w-sm rounded-2xl border border-emerald-600/30 bg-[#12101a] p-6 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-base font-semibold text-white">Last creative — send to Lookbook?</h2>
                <p className="text-sm text-white/50">Approving this is the final creative in {approveConfirm.map((c) => `“${c.title}”`).join(', ')}. It’ll be marked approved and moved to the Lookbook.</p>
                {approveConfirm.some((c) => (c.unapprovedFiles ?? 0) > 0) && (
                  <p className="text-xs text-amber-300/90">This campaign still has unapproved uploaded file(s), which aren’t counted toward completion — it’ll go to the Lookbook anyway.</p>
                )}
                <div className="flex gap-2">
                  <button onClick={(e) => { e.stopPropagation(); setApproveConfirm(null) }} className="flex-1 text-sm font-medium text-white/60 hover:text-white bg-white/[0.06] py-2.5 rounded-xl">Cancel</button>
                  <button onClick={(e) => { e.stopPropagation(); void amApprove(true) }} disabled={approving} className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40">Approve &amp; send</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </Draggable>
  )
})
