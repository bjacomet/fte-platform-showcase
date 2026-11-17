'use client'

import { useMemo } from 'react'
import { DragDropContext, Draggable, Droppable, type DropResult } from '@hello-pangea/dnd'
import type { AtlasBoardCard, AtlasBoardColumn, AtlasCardFields } from '@/types'
import { safeColor, stageForCard } from '@/lib/atlasStages'
import AtlasCard from './AtlasCard'

interface Props {
  /** Already sorted by position. */
  columns: AtlasBoardColumn[]
  /** Cards after search + status filters. */
  cards: AtlasBoardCard[]
  locationNameFor: (card: AtlasBoardCard) => string
  fields: AtlasCardFields
  onOpen: (id: string) => void
  onMove: (cardIds: string[], columnId: string) => void
}

// Stages view of the Atlas board. Columns are the team's own (atlas_board_columns),
// cards drag between them, and each card names its location because the column
// no longer does.
//
// Order inside a stage is location, then the card's own position — the same
// order the By location view uses — rather than a hand-dragged order. A second
// per-stage position would make the two views disagree about where a card sits,
// and dragging is for changing stage, not for ranking. Same-column drops are
// therefore a no-op.
export default function AtlasStageBoard({ columns, cards, locationNameFor, fields, onOpen, onMove }: Props) {
  const byColumn = useMemo(() => {
    const map = new Map<string, AtlasBoardCard[]>()
    for (const col of columns) map.set(col.id, [])
    for (const c of cards) {
      const stage = stageForCard(c.atlas_column_id, columns)
      if (stage) map.get(stage)?.push(c)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => locationNameFor(a).localeCompare(locationNameFor(b)) || a.position - b.position)
    }
    return map
  }, [columns, cards, locationNameFor])

  // In the location view the badge only shows when a column mixes media types.
  // A stage always mixes locations, so judge it across everything on screen.
  const showMediaBadge = useMemo(() => new Set(cards.map((c) => c.media_type).filter(Boolean)).size > 1, [cards])

  function onDragEnd(result: DropResult) {
    const { destination, source, draggableId } = result
    if (!destination || destination.droppableId === source.droppableId) return
    onMove([draggableId], destination.droppableId)
  }

  if (columns.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-black/30 py-16 text-center text-gray-300">
        No stage columns yet. Open Customize board and add one.
      </div>
    )
  }

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className="flex items-start gap-3 overflow-x-auto pb-4 board-scroll">
        {columns.map((col) => {
          const colCards = byColumn.get(col.id) ?? []
          const accent = safeColor(col.color)
          return (
            <div
              key={col.id}
              className="flex-none w-[272px] flex flex-col rounded-xl overflow-hidden glass-column"
              style={{ borderTop: `3px solid ${accent}`, '--col-accent': accent } as React.CSSProperties}
            >
              <div className="px-3 py-2 flex items-center justify-between gap-2 select-none glass-column-header">
                {/* Title stays white and the colour goes on a dot: a darker accent
                    (purple, navy) used as text was unreadable on the glass header. */}
                <h3 className="flex items-center gap-2 min-w-0 text-[13px] font-extrabold tracking-wide uppercase text-white" title={col.title}>
                  <span className="w-2.5 h-2.5 rounded-full flex-none" style={{ background: accent, boxShadow: `0 0 8px ${accent}99` }} />
                  <span className="truncate">{col.title}</span>
                </h3>
                <span
                  className="flex-none text-xs font-semibold rounded-full px-2 py-0.5 min-w-[22px] text-center"
                  style={{ color: '#ffffff', textShadow: '0 1px 2px rgba(0,0,0,0.55)', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.35)' }}
                >
                  {colCards.length}
                </span>
              </div>
              <div className="glass-column-body">
                <Droppable droppableId={col.id}>
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`overflow-y-auto px-2 pt-1.5 pb-2 space-y-1.5 [scrollbar-gutter:stable] transition-colors ${snapshot.isDraggingOver ? 'is-drag-over' : ''}`}
                      style={{ minHeight: 80, maxHeight: 'calc(100vh - 300px)', background: snapshot.isDraggingOver ? `${accent}26` : undefined }}
                    >
                      {colCards.length === 0 && !snapshot.isDraggingOver && (
                        <p className="text-center text-xs py-6 text-white/30">Drop cards here</p>
                      )}
                      {colCards.map((card, index) => (
                        // disableInteractiveElementBlocking: the whole AtlasCard is a
                        // <button> (it opens the drawer), and the library refuses to
                        // start a drag on a button by default — without this no card
                        // can be dragged at all. A click without movement still opens.
                        <Draggable key={card.id} draggableId={card.id} index={index} disableInteractiveElementBlocking>
                          {(drag) => (
                            <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}>
                              <AtlasCard
                                card={card}
                                onOpen={onOpen}
                                locationName={locationNameFor(card)}
                                showMediaBadge={showMediaBadge}
                                fields={fields}
                                showLocation
                              />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>
            </div>
          )
        })}
      </div>
    </DragDropContext>
  )
}
