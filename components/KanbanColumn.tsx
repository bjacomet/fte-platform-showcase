'use client'

import { memo, useState, useRef, useEffect } from 'react'
import { Droppable } from '@hello-pangea/dnd'
import type { DraggableProvidedDragHandleProps } from '@hello-pangea/dnd'
import type { BoardCard, Column, WorkStatus } from '@/types'
import KanbanCard from './KanbanCard'
import CardInsertGap from './CardInsertGap'

const CARD_CAP = 30  // cards shown before "show more"

// Single unified accent for all work columns — was a 6-color cycle by position,
// unified to FTE blue (2026-07) so the board reads as one system, not a rainbow.
// The Done column keeps a distinct color to mark the terminal state (see below).
const COLUMN_ACCENT = { top: '#0075a9', title: '#38b6ff', drag: 'rgba(0,117,169,0.22)' } as const

interface Props {
  column: Column
  columns: Column[]
  cards: BoardCard[]
  isDone?: boolean
  hasClientFilter: boolean
  isDragging: boolean
  dragHandleProps: DraggableProvidedDragHandleProps | null | undefined
  onInsertCard: (columnId: string, atPosition: number) => void
  onOpenCard: (card: BoardCard) => void
  onFilesDropped: (card: BoardCard, files: File[]) => void
  onOpenClient?: (clientId: string) => void
  onQuickMove: (cardId: string, destColumnId: string) => void
  onQuickCopy: (card: BoardCard) => void
  onArchive: (cardId: string) => Promise<void>
  onDelete: (cardId: string) => Promise<void>
  onTogglePending: (cardId: string) => Promise<void>
  onSetWorkStatus: (cardId: string, status: WorkStatus | null) => Promise<void>
  onRenameColumn: (columnId: string, newTitle: string) => Promise<void>
  selectedIds: Set<string>
  onToggleSelect: (cardId: string) => void
  designerFor: (card: BoardCard) => string | null
}

export default memo(function KanbanColumn({
  column, columns, cards, isDone, hasClientFilter, isDragging,
  dragHandleProps, onInsertCard, onOpenCard, onFilesDropped, onOpenClient,
  onQuickMove, onQuickCopy, onArchive, onDelete, onTogglePending, onSetWorkStatus, onRenameColumn,
  selectedIds, onToggleSelect, designerFor,
}: Props) {
  const [expanded, setExpanded] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(column.title)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) renameInputRef.current?.select()
  }, [renaming])

  function startRename(e: React.MouseEvent) {
    e.stopPropagation()
    setRenameValue(column.title)
    setRenaming(true)
  }

  async function commitRename() {
    setRenaming(false)
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== column.title) {
      await onRenameColumn(column.id, trimmed)
    }
  }

  function handleRenameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') void commitRename()
    if (e.key === 'Escape') setRenaming(false)
  }

  // Accent color — Done column uses fixed purple, all others share the unified accent
  const accent = isDone
    ? { top: '#73308a', title: '#c084fc', drag: 'rgba(115,48,138,0.22)' }
    : COLUMN_ACCENT

  // Done column: hide all cards unless a client filter is active
  const showDonePlaceholder = isDone && !hasClientFilter

  // Card cap: limit visible cards unless expanded (skip cap during drag so DnD works)
  const cappedCards = isDragging || expanded || cards.length <= CARD_CAP
    ? cards
    : cards.slice(0, CARD_CAP)
  const hiddenCount = cards.length - CARD_CAP

  return (
    <div
      className="flex-none w-[272px] flex flex-col rounded-xl overflow-hidden glass-column"
      style={{ borderTop: `2px solid ${accent.top}`, '--col-accent': accent.top } as React.CSSProperties}
    >
      {/* Column header — drag handle for reordering; dark panel with accent title */}
      <div
        {...dragHandleProps}
        className="px-3 py-2 flex items-center justify-between gap-2 cursor-grab active:cursor-grabbing select-none glass-column-header"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isDone && (
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse flex-none"
              style={{ background: accent.title }}
            />
          )}
          {renaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={handleRenameKeyDown}
              onClick={e => e.stopPropagation()}
              className="flex-1 min-w-0 text-sm font-semibold tracking-wide rounded px-1.5 py-0.5 outline-none"
              style={{ background: 'rgba(0,0,0,0.4)', color: '#ffffff', border: `1px solid ${accent.top}60` }}
            />
          ) : (
            <h3
              className="text-[13px] font-extrabold truncate tracking-wide uppercase cursor-text rounded px-1 -mx-1 transition-colors"
              style={{ color: '#ffffff' }}
              title={`${column.title} — click to rename`}
              onClick={startRename}
            >
              {column.title}
            </h3>
          )}
        </div>
        <span
          className="flex-none text-xs font-semibold rounded-full px-2 py-0.5 min-w-[22px] text-center"
          style={{ color: '#ffffff', textShadow: '0 1px 2px rgba(0,0,0,0.55)', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.35)' }}
        >
          {cards.length}
        </span>
      </div>

      {/* Body — glass area below the header */}
      <div className="glass-column-body">

      {/* Card list */}
      <Droppable droppableId={column.id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex flex-col transition-colors ${snapshot.isDraggingOver ? 'is-drag-over' : ''}`}
            style={{ minHeight: 80, background: snapshot.isDraggingOver ? accent.drag : undefined }}
          >
            {showDonePlaceholder ? (
              /* Done column placeholder when no client filter */
              <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 text-center gap-2">
                <svg className="w-8 h-8" style={{ color: `${accent.title}40` }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                </svg>
                <p className="text-xs leading-snug" style={{ color: `${accent.title}50` }}>
                  Filter by client to see their live cards
                </p>
              </div>
            ) : (
              /*
               * Single render branch for card list — never switch structure mid-drag.
               * cappedCards already returns all cards when isDragging=true (line 34),
               * so DnD always sees a stable DOM from drag-start to drop.
               */
              <>
                <div
                  className="overflow-y-auto px-2 pt-1.5 pb-2 space-y-1 [scrollbar-gutter:stable]"
                  style={{ maxHeight: 'calc(100vh - 220px)' }}
                >
                  {/* Gap before first card — also the only insert affordance when the column is empty */}
                  <CardInsertGap
                    isDragging={isDragging}
                    onClick={() => onInsertCard(column.id, cappedCards[0]?.position ?? 0)}
                  />
                  {cappedCards.map((card, index) => (
                    <div key={card.id}>
                      <KanbanCard
                        card={card} index={index}
                        columns={columns}
                        onOpen={onOpenCard} onFilesDropped={onFilesDropped} onOpenClient={onOpenClient}
                        onQuickMove={onQuickMove} onQuickCopy={onQuickCopy}
                        onArchive={onArchive} onDelete={onDelete}
                        onTogglePending={onTogglePending}
                        onSetWorkStatus={onSetWorkStatus}
                        selected={selectedIds.has(card.id)} onToggleSelect={onToggleSelect}
                        designerName={designerFor(card)}
                      />
                      {/* Gap after each card */}
                      <CardInsertGap
                        isDragging={isDragging}
                        onClick={() => {
                          const nextPosition = cappedCards[index + 1]?.position ?? (card.position + 1)
                          onInsertCard(column.id, nextPosition)
                        }}
                      />
                    </div>
                  ))}
                  {provided.placeholder}
                </div>
                {/* Card cap expand/collapse — hidden during drag to avoid layout shifts */}
                {!isDragging && !expanded && hiddenCount > 0 && (
                  <button
                    onClick={() => setExpanded(true)}
                    className="mx-2 mb-2 text-xs rounded-lg py-1.5 transition-colors"
                    style={{ color: `${accent.title}80`, background: `${accent.top}12`, border: `1px solid ${accent.top}30` }}
                  >
                    Show {hiddenCount} more
                  </button>
                )}
                {!isDragging && expanded && hiddenCount > 0 && (
                  <button
                    onClick={() => setExpanded(false)}
                    className="mx-2 mb-2 text-xs transition-colors"
                    style={{ color: `${accent.title}50` }}
                  >
                    Show less
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </Droppable>

      </div>{/* end glass-column-body */}
    </div>
  )
})
