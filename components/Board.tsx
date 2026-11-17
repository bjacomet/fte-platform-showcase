'use client'

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { useRouter } from 'next/navigation'
import { FB_BUILD_MEDIA_TYPES, TTD_BUILD_MEDIA_TYPES, type BoardCard, type Card, type Client, type Column, type WorkStatus } from '@/types'
import { createClient } from '@/lib/supabase/client'
import { FULL_CARD_SELECT } from '@/lib/cardQueries'
import KanbanColumn from './KanbanColumn'
import { isVideoWork, type Designer } from '@/lib/designers'
import ColumnInsertGap from './ColumnInsertGap'
import FilterBar from './FilterBar'
import AddCardModal from './AddCardModal'
import AnimatedBackground, { type MotionPreset } from './AnimatedBackground'
import CardDrawer from './CardDrawer'
import ClientPanel from './ClientPanel'
import { useDragAutoScroll } from '@/hooks/useDragAutoScroll'
import { useRealtimeBoard } from '@/hooks/useRealtimeBoard'
import BoardMenu from './BoardMenu'
import BulkDuplicateMenu from './BulkDuplicateMenu'
import AIChatWidget from './AIChatWidget'
import CookieBriefModal from './CookieBriefModal'
import UpdateAvailableBanner from './UpdateAvailableBanner'
import { handleColumnChange } from '@/lib/flights'
import { maybeGenerateAdviewerLink } from '@/lib/adviewer'
import { copyForCopyTrackerMultiDeferred, collectLandingPages, resolveCreativeName, tokenFromAdviewerUrl, adviewerDeepLink, type CopyTrackerEntry } from '@/lib/copyTracker'
import { getPrefetchedCard, recordDrawerOpen, updateCachedCard, evictCachedCard } from '@/lib/cardCache'

interface Props {
  initialColumns: Column[]
  initialCards: BoardCard[]
  clients: Client[]
  backgroundUrl?: string
  userEmail?: string
  userFullName?: string
  /** Designer who owns all video work regardless of client (app_settings.video_designer). */
  videoDesigner?: Designer | null
}

// A full Card fetched on create/update/copy is always a main-board card, so its
// column_id is present at runtime — narrow it to the slim BoardCard shape.
const toBoardCard = (c: Card): BoardCard => ({ ...c, column_id: c.column_id ?? '' }) as BoardCard

export default function Board({ initialColumns, initialCards, clients, backgroundUrl: initialBg = '', userEmail = '', userFullName = '', videoDesigner = null }: Props) {
  const router = useRouter()
  const [localColumns, setLocalColumns] = useState<Column[]>(() =>
    [...initialColumns].sort((a, b) => a.position - b.position)
  )
  const [cards, setCards] = useState<BoardCard[]>(initialCards)
  const [selectedClient, setSelectedClient] = useState('')
  const [selectedMediaType, setSelectedMediaType] = useState('')
  const [myClientsOnly, setMyClientsOnly] = useState(false)
  // Client ownership (clients.designer_name / designer_email). Looked up from the
  // clients prop rather than joined into the card query, so the board still loads
  // if the add_client_designer migration has not been run yet — cards just show
  // no designer pill.
  const clientById = useMemo(() => new Map(clients.map(c => [c.id, c])), [clients])
  // The designer a card belongs to: the video designer for video work (see
  // lib/designers.ts), otherwise its client's designer.
  const designerFor = useCallback((card: Pick<BoardCard, 'client_id' | 'media_type'>): { name: string; email: string | null } | null => {
    if (videoDesigner && isVideoWork(card.media_type)) return videoDesigner
    const c = card.client_id ? clientById.get(card.client_id) : undefined
    return c?.designer_name ? { name: c.designer_name, email: c.designer_email ?? null } : null
  }, [clientById, videoDesigner])
  const designerNameFor = useCallback((card: BoardCard) => designerFor(card)?.name ?? null, [designerFor])
  const me = userEmail.toLowerCase()
  const isMine = useCallback(
    (card: Pick<BoardCard, 'client_id' | 'media_type'>) => !!me && designerFor(card)?.email?.toLowerCase() === me,
    [designerFor, me],
  )
  const hasMyClients = useMemo(
    () => !!me && (clients.some(c => c.designer_email?.toLowerCase() === me) || videoDesigner?.email.toLowerCase() === me),
    [clients, videoDesigner, me],
  )
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null)
  const [insertCardAtPosition, setInsertCardAtPosition] = useState<number | undefined>(undefined)
  const [selectedCard, setSelectedCard] = useState<Card | null>(null)
  // Shift/Cmd/Ctrl-click multi-select for bulk moving cards between columns.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [bulkMoving, setBulkMoving] = useState(false)
  const [bulkDownloading, setBulkDownloading] = useState(false)
  const [bulkDownloadError, setBulkDownloadError] = useState<string | null>(null)
  const [bulkCopyingTracker, setBulkCopyingTracker] = useState(false)
  const [bulkCopyTrackerDone, setBulkCopyTrackerDone] = useState(false)
  const [pendingCardFiles, setPendingCardFiles] = useState<File[] | null>(null)
  const [clientPanelId, setClientPanelId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [background, setBackground] = useState(initialBg)
  const [brendaOpen, setBrendaOpen] = useState(false)
  const [brendaExpanded, setBrendaExpanded] = useState(false)

  // Stable supabase client — never recreated
  const supabase = useMemo(() => createClient(), [])

  // Own-echo suppression for Realtime — keys are "card:<id>" or "column:<id>".
  // Presence alone marks a recent local mutation; entries self-expire below.
  const ownMutations = useRef(new Set<string>())
  // Tracks the pending expiry timer per key so a second mutation on the same
  // row (e.g. create then delete within ~2s) resets the window instead of
  // being cut short by the first mutation's timer — an early expiry here
  // reopens a gap where a delayed Realtime echo can resurrect a deleted row.
  const ownMutationTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const markOwnMutation = useCallback((type: 'card' | 'column', id: string) => {
    const key = `${type}:${id}`
    ownMutations.current.add(key)
    const existingTimer = ownMutationTimers.current.get(key)
    if (existingTimer) clearTimeout(existingTimer)
    ownMutationTimers.current.set(key, setTimeout(() => {
      ownMutations.current.delete(key)
      ownMutationTimers.current.delete(key)
    }, 2000))
  }, [])

  const isOwnEcho = useCallback((type: 'card' | 'column', id: string): boolean => {
    return ownMutations.current.has(`${type}:${id}`)
  }, [])

  const { scrollContainerRef, onDragStart: onAutoScrollStart, onDragEnd: onAutoScrollEnd } = useDragAutoScroll()

  // Identify the Done and Pending columns by title (derived once, stable across renders)
  const doneColumnId = useMemo(
    () => localColumns.find((c) => c.title === 'Done')?.id ?? null,
    [initialColumns]
  )
  const pendingColumnId = useMemo(
    () => localColumns.find((c) => c.title === 'Pending')?.id ?? null,
    [initialColumns]
  )
  const queueColumnId = useMemo(
    () => localColumns.find((c) => c.title === 'Queue')?.id ?? null,
    [initialColumns]
  )

  useRealtimeBoard({ supabase, setCards, setLocalColumns, isOwnEcho })

  // Insert a new column after a given column ID
  const handleInsertColumn = useCallback(async (afterColumnId: string, name: string) => {
    const afterCol = localColumns.find((c) => c.id === afterColumnId)
    if (!afterCol) return
    const insertPosition = afterCol.position + 1

    // Shift all columns at insertPosition or above
    const toShift = localColumns.filter((c) => c.position >= insertPosition)
    const shifted = localColumns.map((c) => c.position >= insertPosition ? { ...c, position: c.position + 1 } : c)

    // Optimistic update with placeholder
    const tempId = `temp-${Date.now()}`
    const newCol: Column = { id: tempId, title: name, position: insertPosition }
    setLocalColumns([...shifted, newCol].sort((a, b) => a.position - b.position))

    // Persist shifts
    if (toShift.length > 0) {
      toShift.forEach((c) => markOwnMutation('column', c.id))
      await Promise.all(
        toShift.map((c) =>
          supabase.from('columns').update({ position: c.position + 1 }).eq('id', c.id)
        )
      )
    }

    // Insert new column
    const { data } = await supabase
      .from('columns')
      .insert({ title: name, position: insertPosition })
      .select()
      .single()

    if (data) {
      markOwnMutation('column', (data as Column).id)
      setLocalColumns((prev) =>
        prev.map((c) => c.id === tempId ? (data as Column) : c)
      )
    }
  }, [supabase, localColumns, markOwnMutation])

  // Insert a card at a specific position — opens the modal with position pre-set
  const handleInsertCard = useCallback((columnId: string, atPosition: number) => {
    setInsertCardAtPosition(atPosition)
    setAddingToColumn(columnId)
  }, [])

  const handleDragEnd = useCallback(async (result: DropResult) => {
    const { source, destination, draggableId, type } = result
    if (!destination) return
    if (source.droppableId === destination.droppableId && source.index === destination.index) return

    // ── Column reorder ──────────────────────────────────────────────────────
    if (type === 'COLUMN') {
      const reordered = [...localColumns]
      const [moved] = reordered.splice(source.index, 1)
      reordered.splice(destination.index, 0, moved)
      const updated = reordered.map((col, i) => ({ ...col, position: i + 1 }))
      setLocalColumns(updated)
      updated.forEach((col) => markOwnMutation('column', col.id))
      await Promise.all(
        updated.map((col) =>
          supabase.from('columns').update({ position: col.position }).eq('id', col.id)
        )
      )
      return
    }

    // ── Card move ──────────────────────────────────────────────────────────

    const sourceColumnId = source.droppableId
    const destColumnId = destination.droppableId

    // Full (unfiltered) card arrays — used for position persistence so we
    // don't drop non-visible cards from the DB order.
    const allSrcCards = cards
      .filter((c) => c.column_id === sourceColumnId)
      .sort((a, b) => a.position - b.position)
    const dragged = allSrcCards.find((c) => c.id === draggableId)
    if (!dragged) return

    // Filtered card arrays — exactly what DnD rendered, so source.index /
    // destination.index are indices into these lists, not the full lists.
    // When no filter is active this matches allSrcCards; when a filter is
    // active it prevents wrong-position drops caused by invisible cards.
    const applyFilter = (c: BoardCard) =>
      (!selectedClient || c.client_id === selectedClient) &&
      (!selectedMediaType || c.media_type === selectedMediaType) &&
      (!myClientsOnly || isMine(c))
    const filteredSrcCards = allSrcCards.filter(applyFilter)

    let reorderedCards: BoardCard[]

    if (sourceColumnId === destColumnId) {
      // Use filtered view to find where the card lands relative to visible neighbors,
      // then interleave into the full list at the matching position.
      const filteredWithout = filteredSrcCards.filter((c) => c.id !== draggableId)
      const anchorBefore = destination.index > 0 ? filteredWithout[destination.index - 1] : null
      const anchorAfter = filteredWithout[destination.index] ?? null

      const allWithout = allSrcCards.filter((c) => c.id !== draggableId)
      let insertIdx: number
      if (anchorBefore === null) {
        insertIdx = anchorAfter ? allWithout.findIndex((c) => c.id === anchorAfter.id) : 0
        if (insertIdx === -1) insertIdx = 0
      } else {
        const beforeIdx = allWithout.findIndex((c) => c.id === anchorBefore.id)
        insertIdx = beforeIdx === -1 ? allWithout.length : beforeIdx + 1
      }
      const spliced = [...allWithout]
      spliced.splice(insertIdx, 0, dragged)
      reorderedCards = spliced.map((c, i) => ({ ...c, position: i }))
    } else {
      const allDestCards = cards
        .filter((c) => c.column_id === destColumnId)
        .sort((a, b) => a.position - b.position)
      const filteredDestCards = allDestCards.filter(applyFilter)

      // Source: remove dragged, reindex remaining
      const newSrc = allSrcCards
        .filter((c) => c.id !== draggableId)
        .map((c, i) => ({ ...c, position: i }))

      // Dest: find anchor in filtered view, insert at correct spot in full list
      const anchorBefore = destination.index > 0 ? filteredDestCards[destination.index - 1] : null
      const anchorAfter = filteredDestCards[destination.index] ?? null

      let insertIdx: number
      if (anchorBefore === null) {
        insertIdx = anchorAfter ? allDestCards.findIndex((c) => c.id === anchorAfter.id) : 0
        if (insertIdx === -1) insertIdx = 0
      } else {
        const beforeIdx = allDestCards.findIndex((c) => c.id === anchorBefore.id)
        insertIdx = beforeIdx === -1 ? allDestCards.length : beforeIdx + 1
      }

      // Dragging into/out of the Pending column via plain DnD (not the
      // quick-action toggle) must keep is_pending/pre_pending_column_id in
      // sync with column_id — otherwise the PENDING badge and the toggle's
      // return-to-column logic desync from where the card actually is.
      const pendingUpdate: Partial<BoardCard> =
        pendingColumnId && destColumnId === pendingColumnId && sourceColumnId !== pendingColumnId
          ? { is_pending: true, pre_pending_column_id: sourceColumnId }
          : pendingColumnId && sourceColumnId === pendingColumnId && destColumnId !== pendingColumnId
            ? { is_pending: false, pre_pending_column_id: null }
            : {}

      const destSpliced = [...allDestCards]
      destSpliced.splice(insertIdx, 0, { ...dragged, ...pendingUpdate, column_id: destColumnId })
      const newDest = destSpliced.map((c, i) => ({ ...c, column_id: destColumnId, position: i }))

      reorderedCards = [...newSrc, ...newDest]
    }

    // Snapshot the affected cards before we change anything (needed for rollback)
    const affectedIds = new Set(reorderedCards.map((c) => c.id))
    const snapshot = cards.filter((c) => affectedIds.has(c.id))

    // Suppress realtime echoes for all cards we're about to mutate
    reorderedCards.forEach((c) => markOwnMutation('card', c.id))

    // Optimistic update — apply the fully-computed positions locally
    setCards((prev) =>
      prev.map((c) => reorderedCards.find((r) => r.id === c.id) ?? c)
    )

    // Persist every affected card's position using individual updates (safe with RLS)
    const results = await Promise.all(
      reorderedCards.map((c) => {
        const payload: Record<string, unknown> = {
          column_id: c.column_id,
          position: c.position,
          updated_at: new Date().toISOString(),
        }
        // Only the dragged card's pending status can change from this drag —
        // siblings are just being reindexed, so leave their fields alone.
        if (c.id === draggableId) {
          payload.is_pending = c.is_pending
          payload.pre_pending_column_id = c.pre_pending_column_id
        }
        return supabase.from('cards').update(payload).eq('id', c.id)
      })
    )

    const failed = results.some((r: { error: unknown }) => r.error)
    if (failed) {
      // Roll back to pre-drag state so the UI doesn't lie about where cards are
      setCards((prev) => prev.map((c) => snapshot.find((s) => s.id === c.id) ?? c))
      return
    }

    // Evict all moved cards from the prefetch cache so the next open fetches
    // fresh column_id and position, preventing a silent revert on drawer save.
    reorderedCards.forEach((c) => evictCachedCard(c.id))

    // Log card move to activity
    const srcCol = localColumns.find((c) => c.id === sourceColumnId)
    const dstCol = localColumns.find((c) => c.id === destColumnId)
    if (srcCol && dstCol && sourceColumnId !== destColumnId) {
      const { error: activityError } = await supabase.from('card_activity').insert({
        card_id: draggableId,
        actor: userEmail,
        action: 'moved',
        detail: `moved this card from "${srcCol.title}" to "${dstCol.title}"`,
        created_at: new Date().toISOString(),
      })
      // Non-fatal — the column/position writes above already succeeded and the
      // drag should still appear to work. But a failure here (e.g. the dragged
      // card was deleted a moment after the drop, orphaning this insert) means
      // the move leaves zero audit trail, so at minimum surface it for triage.
      if (activityError) {
        console.error('Failed to log card move activity:', activityError.message)
      }
    }

    // Flight logic — only if the Live column exists
    if (doneColumnId) {
      await handleColumnChange(supabase, draggableId, sourceColumnId, destColumnId, doneColumnId)
    }

    // Adviewer trigger — generate a preview token when card lands in "Ready for Adviewer"
    if (sourceColumnId !== destColumnId) {
      const previewUrl = await maybeGenerateAdviewerLink(localColumns, draggableId, destColumnId)
      if (previewUrl) {
        setCards((prev) => prev.map((c) => c.id === draggableId ? { ...c, adpiler_preview_url: previewUrl } : c))
      }
    }

    // Slack DM notifications — fire-and-forget, only on cross-column moves
    if (sourceColumnId !== destColumnId) {
      const movedCard = cards.find((c) => c.id === draggableId)
      fetch('/api/slack/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: draggableId,
          column_id: destColumnId,
          client_id: movedCard?.client_id ?? null,
        }),
      }).catch(() => {
        // Never surface Slack failures to the user
      })
    }
  }, [supabase, doneColumnId, pendingColumnId, localColumns, userEmail, cards, selectedClient, selectedMediaType, myClientsOnly, isMine, markOwnMutation])

  const onDragStart = useCallback(() => {
    setIsDragging(true)
    onAutoScrollStart()
  }, [onAutoScrollStart])

  const onDragEndAll = useCallback((result: DropResult) => {
    onAutoScrollEnd()
    handleDragEnd(result)
    // Defer isDragging reset until after the DnD drop animation (200ms) so
    // CardInsertGap expansion and card-cap restoration don't fight the animation
    setTimeout(() => setIsDragging(false), 200)
  }, [onAutoScrollEnd, handleDragEnd])

  // Open a card in the drawer. Uses hover-prefetch cache (#1) when available;
  // falls back to a fresh Supabase fetch. BoardCard is slim — full Card required.
  const openCard = useCallback(async (card: { id: string }) => {
    recordDrawerOpen()
    const cached = getPrefetchedCard(card.id)
    if (cached) {
      setSelectedCard(cached)
      return
    }
    const { data, error } = await supabase
      .from('cards')
      .select(FULL_CARD_SELECT)
      .eq('id', card.id)
      .single()
    if (error || !data) {
      console.error('Failed to load card:', error?.message)
      return
    }
    setSelectedCard(data as Card)
  }, [supabase])

  // Deep-link support: open the card named in ?card=<id> once on mount so a
  // copied board URL lands on that card instead of a bare board. Runs a single
  // time — the id is read synchronously before the URL-sync effect below can
  // strip the param.
  const deepLinkedRef = useRef(false)
  useEffect(() => {
    if (deepLinkedRef.current) return
    deepLinkedRef.current = true
    const id = new URLSearchParams(window.location.search).get('card')
    // Defer out of the effect body: openCard can set state synchronously on a
    // cache hit, and setState synchronously inside an effect trips the compiler.
    if (id) queueMicrotask(() => { void openCard({ id }) })
  }, [openCard])

  // Keep the address bar in sync with the open card so copying the URL yields a
  // link back to this exact card. replaceState (not push) avoids polluting
  // history; other query params are preserved.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (selectedCard) params.set('card', selectedCard.id)
    else params.delete('card')
    const qs = params.toString()
    window.history.replaceState(window.history.state, '', qs ? `/board?${qs}` : '/board')
  }, [selectedCard])

  // Files dropped directly onto a board card: open that card and hand the files to the
  // drawer, which fills carousel slides (by filename) or the Files tab for other cards.
  const handleFilesDroppedOnCard = useCallback((card: { id: string }, files: File[]) => {
    if (!files.length) return
    setPendingCardFiles(files)
    openCard(card)
  }, [openCard])

  const handleCardCreated = useCallback((card: Card) => {
    markOwnMutation('card', card.id)
    setCards((prev) => (prev.some((c) => c.id === card.id) ? prev : [...prev, toBoardCard(card)]))
    setAddingToColumn(null)
    // Clear filters so the new card is always visible regardless of active filters
    setSelectedClient('')
    setSelectedMediaType('')
  }, [markOwnMutation])

  const handleCardUpdated = useCallback((updated: Card) => {
    markOwnMutation('card', updated.id)
    setCards((prev) => prev.map((c) => (c.id === updated.id ? toBoardCard(updated) : c)))
    setSelectedCard(updated)
    updateCachedCard(updated)
  }, [markOwnMutation])

  const handleCardDeleted = useCallback((cardId: string) => {
    setCards((prev) => prev.filter((c) => c.id !== cardId))
    setSelectedCard(null)
  }, [])

  // Called by FlightsTab when a void snaps a card back to a previous column
  const handleCardColumnChanged = useCallback((cardId: string, columnId: string) => {
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, column_id: columnId } : c))
    setSelectedCard((prev) => prev?.id === cardId ? { ...prev, column_id: columnId } : prev)
  }, [])

  const handleQuickMove = useCallback(async (cardId: string, destColumnId: string) => {
    const card = cards.find((c) => c.id === cardId)
    if (!card || card.column_id === destColumnId) return

    const sourceColumnId = card.column_id
    const newPosition = cards.filter((c) => c.column_id === destColumnId).length

    // Moving via the Move menu / Suggested-move into or out of the Pending
    // column must keep is_pending/pre_pending_column_id in sync with
    // column_id, same as the drag-and-drop path.
    const pendingUpdate: Partial<BoardCard> =
      pendingColumnId && destColumnId === pendingColumnId && sourceColumnId !== pendingColumnId
        ? { is_pending: true, pre_pending_column_id: sourceColumnId }
        : pendingColumnId && sourceColumnId === pendingColumnId && destColumnId !== pendingColumnId
          ? { is_pending: false, pre_pending_column_id: null }
          : {}

    markOwnMutation('card', cardId)

    // Optimistic update
    setCards((prev) => prev.map((c) =>
      c.id === cardId ? { ...c, ...pendingUpdate, column_id: destColumnId, position: newPosition } : c
    ))

    const { error } = await supabase
      .from('cards')
      .update({ ...pendingUpdate, column_id: destColumnId, position: newPosition, updated_at: new Date().toISOString() })
      .eq('id', cardId)

    if (error) {
      setCards((prev) => prev.map((c) => c.id === cardId ? card : c))
      return
    }

    evictCachedCard(cardId)

    const srcCol = initialColumns.find((c) => c.id === sourceColumnId)
    const dstCol = initialColumns.find((c) => c.id === destColumnId)
    if (srcCol && dstCol) {
      await supabase.from('card_activity').insert({
        card_id: cardId, actor: userEmail, action: 'moved',
        detail: `moved this card from "${srcCol.title}" to "${dstCol.title}"`,
      })
    }

    if (doneColumnId) {
      await handleColumnChange(supabase, cardId, sourceColumnId, destColumnId, doneColumnId)
    }

    // Adviewer trigger — same as drag-and-drop, so a card moved via the Move menu
    // into "Ready for Adviewer" gets a preview link too.
    const previewUrl = await maybeGenerateAdviewerLink(localColumns, cardId, destColumnId)
    if (previewUrl) {
      setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, adpiler_preview_url: previewUrl } : c))
    }
  }, [cards, supabase, initialColumns, localColumns, userEmail, doneColumnId, pendingColumnId, markOwnMutation])

  const toggleSelect = useCallback((cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId); else next.add(cardId)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setBulkDownloadError(null)
  }, [])

  // Bulk Download Build is offered when the selection is all-Facebook or
  // all-TTD build types — each export produces one combined upload sheet
  // (facebook_upload.xlsx or ttd_upload.xlsx), so mixed selections are out.
  const fbBuildTypes = useMemo(() => new Set<string>(FB_BUILD_MEDIA_TYPES), [])
  const ttdBuildTypes = useMemo(() => new Set<string>(TTD_BUILD_MEDIA_TYPES), [])
  const selectionIsBulkDownloadable = useMemo(
    () => {
      const selected = [...selectedIds].map((id) => cards.find((k) => k.id === id))
      if (selected.length === 0 || selected.some((c) => !c)) return false
      return (
        selected.every((c) => fbBuildTypes.has(c!.media_type ?? '')) ||
        selected.every((c) => ttdBuildTypes.has(c!.media_type ?? ''))
      )
    },
    [selectedIds, cards, fbBuildTypes, ttdBuildTypes]
  )

  // One ZIP for all selected cards: combined facebook_upload.xlsx + creatives
  // grouped square/ and tall/. The API validates (one client, build links set).
  const handleBulkDownloadBuild = useCallback(async () => {
    if (selectedIds.size === 0) return
    setBulkDownloading(true)
    setBulkDownloadError(null)
    try {
      const res = await fetch('/api/box/download-build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardIds: [...selectedIds] }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(json?.error ?? `Download failed (${res.status})`)
      }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? 'build.zip'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setBulkDownloadError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setBulkDownloading(false)
    }
  }, [selectedIds])

  // Copy every selected card for the Copy Tracker sheet — one card per column
  // (row 1 = creative name linked to Adviewer + landing page(s), row 2 = end date in red).
  // Cards are ordered by their board position (the order shown on screen).
  const handleBulkCopyForCopyTracker = useCallback(() => {
    if (selectedIds.size === 0) return
    setBulkCopyingTracker(true)
    setBulkDownloadError(null)
    type FullRow = {
      id: string
      title: string
      creative_name: string | null
      media_type: string | null
      landing_page_url: string | null
      flight_end_date: string | null
      adpiler_preview_url: string | null
      carousel_slides: { landing_page_url: string | null; position: number }[] | null
      card_files: { file_name: string | null }[] | null
      adviewer_campaign_cards: { id: string; adviewer_campaigns: { token: string } | { token: string }[] | null }[] | null
    }
    const relToken = (rel: { token: string } | { token: string }[] | null | undefined): string | null =>
      Array.isArray(rel) ? rel[0]?.token ?? null : rel?.token ?? null
    // Build the entries as a promise; the clipboard write is issued synchronously below so
    // the click's user activation survives the fetch (see copyForCopyTrackerMultiDeferred).
    const entriesPromise: Promise<CopyTrackerEntry[]> = Promise.resolve(
      supabase
        .from('cards')
        .select('id, title, creative_name, media_type, landing_page_url, flight_end_date, adpiler_preview_url, carousel_slides(landing_page_url, position), card_files(file_name), adviewer_campaign_cards(id, adviewer_campaigns(token))')
        .in('id', [...selectedIds])
        .order('created_at', { referencedTable: 'card_files', ascending: true })
      ).then(({ data, error }) => {
        if (error) throw new Error(error.message)
        const byId = new Map((data as FullRow[] ?? []).map((r) => [r.id, r]))
        // Preserve on-screen order: iterate the board's card list, keep selected ones.
        return cards
          .filter((c) => selectedIds.has(c.id))
          .map((c) => byId.get(c.id))
          .filter((r): r is FullRow => !!r)
          .map((r) => {
            const slides = [...(r.carousel_slides ?? [])].sort((a, b) => a.position - b.position)
            const campaignUrl = r.adpiler_preview_url?.includes('/adviewer/c/') ? r.adpiler_preview_url : null
            const token = tokenFromAdviewerUrl(campaignUrl)
            const accRows = r.adviewer_campaign_cards ?? []
            const accId = (accRows.find((x) => relToken(x.adviewer_campaigns) === token) ?? accRows[0])?.id ?? null
            return {
              creativeName: resolveCreativeName(r.card_files, r.creative_name, r.title),
              adviewerUrl: adviewerDeepLink(campaignUrl, accId),
              cardUrl: `${window.location.origin}/card/${r.id}`,
              landingPages: collectLandingPages(r.landing_page_url, r.media_type === 'Carousel Ad' ? slides : null),
              endDate: r.flight_end_date,
            }
          })
      })
    copyForCopyTrackerMultiDeferred(entriesPromise)
      .then((ok) => {
        if (!ok) throw new Error('Clipboard copy failed')
        setBulkCopyTrackerDone(true)
        setTimeout(() => setBulkCopyTrackerDone(false), 2000)
      })
      .catch((err) => setBulkDownloadError(err instanceof Error ? err.message : 'Copy failed'))
      .finally(() => setBulkCopyingTracker(false))
  }, [selectedIds, cards, supabase])

  // Bulk-move every selected card into destColumn. Mirrors handleQuickMove's per-card logic
  // (Pending sync, activity log, flights handleColumnChange) but assigns incrementing
  // positions so the moved cards land in a stable order.
  const handleBulkMove = useCallback(async (destColumnId: string) => {
    const ids = selectedIds
    const toMove = cards.filter((c) => ids.has(c.id) && c.column_id !== destColumnId)
    if (toMove.length === 0) { setSelectedIds(new Set()); return }
    setBulkMoving(true)

    let nextPos = cards.filter((c) => c.column_id === destColumnId).length
    const moves = toMove.map((card) => {
      const sourceColumnId = card.column_id
      const pendingUpdate: Partial<BoardCard> =
        pendingColumnId && destColumnId === pendingColumnId && sourceColumnId !== pendingColumnId
          ? { is_pending: true, pre_pending_column_id: sourceColumnId }
          : pendingColumnId && sourceColumnId === pendingColumnId && destColumnId !== pendingColumnId
            ? { is_pending: false, pre_pending_column_id: null }
            : {}
      return { id: card.id, sourceColumnId, pos: nextPos++, pendingUpdate }
    })

    const moveMap = new Map(moves.map((m) => [m.id, m]))
    moves.forEach((m) => markOwnMutation('card', m.id))

    // Optimistic
    setCards((prev) => prev.map((c) => {
      const m = moveMap.get(c.id)
      return m ? { ...c, ...m.pendingUpdate, column_id: destColumnId, position: m.pos } : c
    }))

    const dstCol = initialColumns.find((c) => c.id === destColumnId)
    for (const m of moves) {
      const { error } = await supabase
        .from('cards')
        .update({ ...m.pendingUpdate, column_id: destColumnId, position: m.pos, updated_at: new Date().toISOString() })
        .eq('id', m.id)
      if (error) continue
      evictCachedCard(m.id)
      const srcCol = initialColumns.find((c) => c.id === m.sourceColumnId)
      if (srcCol && dstCol) {
        await supabase.from('card_activity').insert({
          card_id: m.id, actor: userEmail, action: 'moved',
          detail: `moved this card from "${srcCol.title}" to "${dstCol.title}"`,
        })
      }
      if (doneColumnId) {
        await handleColumnChange(supabase, m.id, m.sourceColumnId, destColumnId, doneColumnId)
      }
    }

    // Adviewer trigger — a bulk move into "Ready for Adviewer" must publish every
    // moved card, same as dragging each one in would. maybeGenerateAdviewerLink
    // no-ops when the destination isn't an Adviewer column.
    const generated: Record<string, string> = {}
    for (const m of moves) {
      const previewUrl = await maybeGenerateAdviewerLink(localColumns, m.id, destColumnId)
      if (previewUrl) generated[m.id] = previewUrl
    }
    if (Object.keys(generated).length > 0) {
      setCards((prev) => prev.map((c) => generated[c.id] ? { ...c, adpiler_preview_url: generated[c.id] } : c))
    }

    setBulkMoving(false)
    setSelectedIds(new Set())
  }, [cards, selectedIds, supabase, initialColumns, localColumns, userEmail, doneColumnId, pendingColumnId, markOwnMutation])

  const handleQuickCopy = useCallback(async (boardCard: BoardCard) => {
    const now = new Date().toISOString()
    const newId = crypto.randomUUID()
    const newPosition = cards.filter((c) => c.column_id === boardCard.column_id).length

    // Board cards are slim — fetch the full row so the copy keeps every field
    const { data: fullCard } = await supabase
      .from('cards')
      .select('*')
      .eq('id', boardCard.id)
      .single()
    if (!fullCard) return
    const card = fullCard as Card

    const { data, error } = await supabase
      .from('cards')
      .insert({
        id: newId,
        title: `Copy of ${card.title}`,
        description: card.description,
        client_id: card.client_id,
        column_id: card.column_id,
        media_type: card.media_type,
        approval_status: 'none',
        position: newPosition,
        tier: card.tier,
        creative_name: card.creative_name,
        build_link: card.build_link,
        first_draft_deadline: card.first_draft_deadline,
        flight_start_date: card.flight_start_date,
        flight_end_date: card.flight_end_date,
        landing_page_url: card.landing_page_url,
        utm_campaign: card.utm_campaign,
        utm_channel: card.utm_channel,
        heading: card.heading,
        subheading: card.subheading,
        button_text: card.button_text,
        caption: card.caption,
        boost_budget: card.boost_budget,
        companion_banner_link: card.companion_banner_link,
        event_description: card.event_description,
        revisions: card.revisions,
        fb_page_name: card.fb_page_name,
        fb_body_text: card.fb_body_text,
        fb_headline: card.fb_headline,
        fb_link_description: card.fb_link_description,
        fb_cta: card.fb_cta,
        created_at: now,
        updated_at: now,
      })
      .select('*, clients(id, name, abbreviation, adpiler_campaign_code, fb_page_logo_url, utm_config)')
      .single()

    if (!error && data) {
      const copied = data as Card
      setCards((prev) => (prev.some((c) => c.id === copied.id) ? prev : [...prev, toBoardCard(copied)]))

      // Copy carousel slides if applicable
      if (card.media_type === 'Carousel Ad') {
        const { data: slides } = await supabase
          .from('carousel_slides').select('*').eq('card_id', card.id).order('position')
        if (slides && slides.length > 0) {
          await supabase.from('carousel_slides').insert(
            (slides as Array<Record<string, unknown>>).map((s) => ({
              ...s, id: crypto.randomUUID(), card_id: newId, created_at: now, updated_at: now,
            }))
          )
        }
      }

      await supabase.from('card_activity').insert({
        card_id: newId, actor: userEmail, action: 'created',
        detail: `Copied from "${card.title}"`,
      })
    }
  }, [cards, supabase, userEmail])

  const handleQuickArchive = useCallback(async (cardId: string) => {
    const card = cards.find((c) => c.id === cardId)
    markOwnMutation('card', cardId)
    setCards((prev) => prev.filter((c) => c.id !== cardId))
    const { error } = await supabase.from('cards').update({ archived: true }).eq('id', cardId)
    if (error) {
      if (card) setCards((prev) => [...prev, card])
      return
    }
    await supabase.from('card_activity').insert({
      card_id: cardId,
      actor: userEmail,
      action: 'archived',
      detail: 'Archived from board menu',
      created_at: new Date().toISOString(),
    })
  }, [supabase, cards, userEmail, markOwnMutation])

  const handleQuickDelete = useCallback(async (cardId: string) => {
    const card = cards.find((c) => c.id === cardId)
    markOwnMutation('card', cardId)
    setCards((prev) => prev.filter((c) => c.id !== cardId))
    const { error } = await supabase.from('cards').delete().eq('id', cardId)
    if (error && card) setCards((prev) => [...prev, card])
  }, [supabase, cards, markOwnMutation])

  const handleTogglePending = useCallback(async (cardId: string) => {
    if (!pendingColumnId) return
    const card = cards.find((c) => c.id === cardId)
    if (!card) return

    markOwnMutation('card', cardId)

    if (!card.is_pending) {
      // Park in Pending — remember where it came from
      const returnColumnId = card.column_id
      const newPosition = cards.filter((c) => c.column_id === pendingColumnId).length
      setCards((prev) => prev.map((c) =>
        c.id === cardId
          ? { ...c, is_pending: true, pre_pending_column_id: returnColumnId, column_id: pendingColumnId, position: newPosition }
          : c
      ))
      const { error } = await supabase.from('cards').update({
        is_pending: true,
        pre_pending_column_id: returnColumnId,
        column_id: pendingColumnId,
        position: newPosition,
        updated_at: new Date().toISOString(),
      }).eq('id', cardId)
      if (error) setCards((prev) => prev.map((c) => c.id === cardId ? card : c))
    } else {
      // Un-pending = new info came in → send to Queue for rework (not back to the
      // pre-pending column). Fall back to the prior column, then the first column,
      // if this board has no Queue column.
      const returnColumnId = queueColumnId
        ?? card.pre_pending_column_id
        ?? [...localColumns].sort((a, b) => a.position - b.position)[0]?.id
        ?? card.column_id
      const newPosition = cards.filter((c) => c.column_id === returnColumnId).length
      setCards((prev) => prev.map((c) =>
        c.id === cardId
          ? { ...c, is_pending: false, pre_pending_column_id: null, column_id: returnColumnId, position: newPosition }
          : c
      ))
      const { error } = await supabase.from('cards').update({
        is_pending: false,
        pre_pending_column_id: null,
        column_id: returnColumnId,
        position: newPosition,
        updated_at: new Date().toISOString(),
      }).eq('id', cardId)
      if (error) setCards((prev) => prev.map((c) => c.id === cardId ? card : c))
    }
  }, [cards, supabase, pendingColumnId, queueColumnId, localColumns, markOwnMutation])

  const handleSetWorkStatus = useCallback(async (cardId: string, status: WorkStatus | null) => {
    const card = cards.find((c) => c.id === cardId)
    if (!card) return
    markOwnMutation('card', cardId)
    setCards((prev) => prev.map((c) => c.id === cardId ? { ...c, work_status: status } : c))
    const { error } = await supabase.from('cards').update({
      work_status: status,
      updated_at: new Date().toISOString(),
    }).eq('id', cardId)
    if (error) setCards((prev) => prev.map((c) => c.id === cardId ? card : c))
  }, [cards, supabase, markOwnMutation])

  const handleRenameColumn = useCallback(async (columnId: string, newTitle: string) => {
    markOwnMutation('column', columnId)
    setLocalColumns(prev => prev.map(c => c.id === columnId ? { ...c, title: newTitle } : c))
    await supabase.from('columns').update({ title: newTitle }).eq('id', columnId)
  }, [supabase, markOwnMutation])

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut()
    router.push('/login')
  }, [supabase, router])

  // Pre-compute all column→cards in a single pass — much faster than filtering per column
  const columnCardsMap = useMemo(() => {
    const map = new Map<string, BoardCard[]>()
    // Last-line-of-defense dedup: never let the same card id render twice, no matter
    // how it got into `cards`. A duplicate id would otherwise render two <div key={id}>
    // in KanbanColumn (duplicate React key) and surface as a phantom copy on the board —
    // the failure mode a stale/drifted tab could produce.
    const seen = new Set<string>()
    for (const c of cards) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      if (selectedClient && c.client_id !== selectedClient) continue
      if (selectedMediaType && c.media_type !== selectedMediaType) continue
      if (myClientsOnly && !isMine(c)) continue
      if (!map.has(c.column_id)) map.set(c.column_id, [])
      map.get(c.column_id)!.push(c)
    }
    for (const arr of map.values()) arr.sort((a, b) => a.position - b.position)
    return map
  }, [cards, selectedClient, selectedMediaType, myClientsOnly, isMine])

  const getColumnCards = useCallback(
    (columnId: string) => columnCardsMap.get(columnId) ?? [],
    [columnCardsMap]
  )

  const isMotionBackground = background.startsWith('motion:')
  const motionPreset = (isMotionBackground ? background.slice(7) : 'aurora') as MotionPreset

  return (
    <div
      className="relative flex flex-col h-screen overflow-hidden"
      style={
        isMotionBackground
          ? { backgroundColor: '#07090f' }
          : background
            ? { backgroundImage: `url(${background})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { backgroundColor: '#0f1117' }
      }
    >
      {isMotionBackground && (
        <div className="absolute inset-0 z-0 pointer-events-none">
          <AnimatedBackground preset={motionPreset} />
        </div>
      )}
      {background && !isMotionBackground && <div className="absolute inset-0 bg-black/45 pointer-events-none" />}
      {menuOpen && <BoardMenu onClose={() => setMenuOpen(false)} onBackgroundChange={setBackground} currentBackground={background} />}
      <FilterBar
        clients={clients}
        selectedClient={selectedClient}
        selectedMediaType={selectedMediaType}
        onClientChange={setSelectedClient}
        onMediaTypeChange={setSelectedMediaType}
        onSignOut={handleSignOut}
        onOpenMenu={() => setMenuOpen(true)}
        userEmail={userEmail}
        userFullName={userFullName}
        hasMyClients={hasMyClients}
        myClientsOnly={myClientsOnly}
        onMyClientsToggle={() => setMyClientsOnly(v => !v)}
      />

      <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEndAll}>
        <div
          ref={scrollContainerRef}
          className="relative z-10 flex-1 overflow-x-auto overflow-y-hidden board-scroll"
          style={{
            paddingLeft: brendaOpen ? (brendaExpanded ? '520px' : '320px') : '0px',
            transition: 'padding-left 300ms ease-in-out',
          }}
        >
          <Droppable droppableId="board-columns" type="COLUMN" direction="horizontal">
            {(droppableProvided) => (
              <div
                ref={droppableProvided.innerRef}
                {...droppableProvided.droppableProps}
                className="flex p-4 items-start"
                style={{ minWidth: 'max-content' }}
              >
                {localColumns.map((column, index) => (
                  <Draggable key={column.id} draggableId={`col-${column.id}`} index={index}>
                    {(draggableProvided) => (
                      <div
                        ref={draggableProvided.innerRef}
                        {...draggableProvided.draggableProps}
                        className="flex items-start"
                        style={{ ...draggableProvided.draggableProps.style, marginRight: 12 }}
                      >
                        <KanbanColumn
                          column={column}
                          columns={localColumns}
                          cards={getColumnCards(column.id)}
                          isDone={column.id === doneColumnId}
                          hasClientFilter={!!selectedClient}
                          isDragging={isDragging}
                          dragHandleProps={draggableProvided.dragHandleProps}
                          onInsertCard={handleInsertCard}
                          onOpenCard={openCard}
                          onFilesDropped={handleFilesDroppedOnCard}
                          onOpenClient={setClientPanelId}
                          onQuickMove={handleQuickMove}
                          onQuickCopy={handleQuickCopy}
                          onArchive={handleQuickArchive}
                          onDelete={handleQuickDelete}
                          onTogglePending={handleTogglePending}
                          onSetWorkStatus={handleSetWorkStatus}
                          onRenameColumn={handleRenameColumn}
                          selectedIds={selectedIds}
                          onToggleSelect={toggleSelect}
                          designerFor={designerNameFor}
                        />
                        <ColumnInsertGap
                          afterColumnId={column.id}
                          onInsert={handleInsertColumn}
                          isDragging={isDragging}
                        />
                      </div>
                    )}
                  </Draggable>
                ))}
                {droppableProvided.placeholder}
              </div>
            )}
          </Droppable>
        </div>
      </DragDropContext>

      {addingToColumn && (
        <AddCardModal
          defaultColumnId={addingToColumn}
          columns={localColumns}
          clients={clients}
          insertAtPosition={insertCardAtPosition}
          onClose={() => { setAddingToColumn(null); setInsertCardAtPosition(undefined) }}
          onCreated={handleCardCreated}
        />
      )}

      {selectedCard && (
        <div
          className="fixed inset-0 bg-black/55 backdrop-blur-sm z-40 animate-fade-in"
          onClick={() => setSelectedCard(null)}
        />
      )}

      {selectedCard && (
        <CardDrawer
          card={selectedCard}
            userEmail={userEmail}
          columns={localColumns}
          clients={clients}
          doneColumnId={doneColumnId}
          onClose={() => setSelectedCard(null)}
          onUpdated={handleCardUpdated}
          onDeleted={handleCardDeleted}
          onColumnChanged={handleCardColumnChanged}
          initialDropFiles={pendingCardFiles}
          onInitialDropFilesConsumed={() => setPendingCardFiles(null)}
        />
      )}

      <ClientPanel
        clientId={clientPanelId}
        clients={clients}
        onClose={() => setClientPanelId(null)}
        onOpenCard={(card) => {
          setClientPanelId(null)
          openCard(card)
        }}
      />

      <UpdateAvailableBanner />

      <CookieBriefModal
        cards={cards}
        columns={initialColumns}
        userEmail={userEmail}
      />

      <AIChatWidget
        userEmail={userEmail}
        userFullName={userFullName}
        open={brendaOpen}
        onOpenChange={setBrendaOpen}
        expanded={brendaExpanded}
        onExpandedChange={setBrendaExpanded}
        activeCard={selectedCard ? {
          title: selectedCard.title,
          mediaType: selectedCard.media_type,
          clientName: selectedCard.clients?.name ?? null,
          brandNotes: selectedCard.clients?.brand_notes ?? null,
          boxBrandFileId: selectedCard.clients?.box_brand_file_id ?? null,
          brandWebsiteUrl: selectedCard.clients?.brand_website_url ?? null,
          fbHeadline: selectedCard.fb_headline,
          fbBodyText: selectedCard.fb_body_text,
          fbLinkDescription: selectedCard.fb_link_description,
          creativeBrief: selectedCard.creative_brief,
          previewImageUrl: selectedCard.preview_image_url,
        } : null}
      />

      {/* Bulk-move bar — shows when cards are multi-selected (Shift/Cmd/Ctrl-click). */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-xl border border-[#0075a9]/60 bg-[#00152a] px-4 py-2.5 shadow-2xl shadow-black/50">
          <span className="text-sm font-semibold text-white">{selectedIds.size} selected</span>
          <div className="h-5 w-px bg-white/15" />
          <label className="text-xs text-white/60">Move to</label>
          <select
            value=""
            disabled={bulkMoving}
            onChange={(e) => { if (e.target.value) handleBulkMove(e.target.value) }}
            className="rounded-md border border-[#0075a9]/50 bg-[#002a4a] px-2 py-1 text-sm text-white focus:outline-none disabled:opacity-50"
          >
            <option value="" disabled>{bulkMoving ? 'Moving…' : 'Choose column…'}</option>
            {localColumns.map((col) => <option key={col.id} value={col.id}>{col.title}</option>)}
          </select>
          {selectionIsBulkDownloadable && (
            <>
              <div className="h-5 w-px bg-white/15" />
              <button
                onClick={handleBulkDownloadBuild}
                disabled={bulkDownloading || bulkMoving}
                className="rounded-md border border-[#0075a9]/50 bg-[#002a4a] px-2 py-1 text-sm text-white transition-colors hover:bg-[#003a63] disabled:opacity-50"
              >
                {bulkDownloading ? '⏳ Zipping…' : '⬇ Download Build'}
              </button>
            </>
          )}
          <div className="h-5 w-px bg-white/15" />
          <button
            onClick={handleBulkCopyForCopyTracker}
            disabled={bulkCopyingTracker || bulkMoving}
            title="Copy all selected cards for the Copy Tracker sheet — one card per column (name linked to Adviewer + landing page, end date in red below)"
            className="rounded-md border border-emerald-700/50 bg-[#002a4a] px-2 py-1 text-sm text-white transition-colors hover:bg-[#003a63] disabled:opacity-50"
          >
            {bulkCopyingTracker ? '⏳ Copying…' : bulkCopyTrackerDone ? '✓ Copied!' : '⧉ Copy for Copy Tracker'}
          </button>
          <div className="h-5 w-px bg-white/15" />
          <BulkDuplicateMenu selectedIds={selectedIds} clients={clients} disabled={bulkMoving} />
          {bulkDownloadError && (
            <span className="max-w-sm truncate text-xs text-red-400" title={bulkDownloadError}>{bulkDownloadError}</span>
          )}
          <button onClick={clearSelection} disabled={bulkMoving} className="text-xs text-white/60 transition-colors hover:text-white disabled:opacity-50">Clear</button>
        </div>
      )}
    </div>
  )
}
