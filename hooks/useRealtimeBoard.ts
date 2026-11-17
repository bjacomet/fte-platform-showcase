'use client'

import { useEffect } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BoardCard, Column } from '@/types'
import { BOARD_CARD_SELECT } from '@/lib/cardQueries'
import { clearCardCache, evictCachedCard } from '@/lib/cardCache'

interface Options {
  supabase: SupabaseClient
  setCards: React.Dispatch<React.SetStateAction<BoardCard[]>>
  setLocalColumns: React.Dispatch<React.SetStateAction<Column[]>>
  isOwnEcho: (type: 'card' | 'column', id: string) => boolean
}

/**
 * Subscribes to Supabase Realtime changes on `cards` and `columns`.
 * When another user mutates a row the board updates instantly.
 *
 * Own-echo suppression: Board.tsx marks every row it mutates in a
 * short-lived ref. Events arriving within that window are skipped so
 * optimistic updates don't flicker.
 *
 * Requires `supabase/add_realtime.sql` to have been run (adds both
 * tables to the supabase_realtime publication).
 */
export function useRealtimeBoard({ supabase, setCards, setLocalColumns, isOwnEcho }: Options) {
  useEffect(() => {
    // `postgres_changes` does not replay missed events after a dropped
    // websocket — a board tab left open for days (normal usage) can silently
    // drift from DB truth if the socket ever reconnects (sleep, wifi blip).
    // A stale `cards` snapshot isn't just cosmetic: handleDragEnd in Board.tsx
    // persists whatever column_id local state believes for every card in the
    // source/destination columns, so a drift can get *written back* to the DB
    // as a real, undetected data-corrupting drag the next time anyone drags a
    // card through an affected column (root cause of the 2026-07-07 incident
    // where 3 Done-column cards were silently overwritten back to Queue).
    // Refetching on reconnect and on tab-refocus keeps local state honest.
    let reconciling = false
    const reconcile = async () => {
      if (reconciling) return
      reconciling = true
      // The board's slim state is about to be fully replaced, but the module-level
      // full-card cache (lib/cardCache) isn't — and it may hold cards edited by
      // others while our socket was down. Drop it so the next drawer open refetches.
      clearCardCache()
      try {
        const [{ data: cards }, { data: columns }] = await Promise.all([
          supabase
            .from('cards')
            .select(BOARD_CARD_SELECT)
            .eq('archived', false)
            .eq('calendar_only', false)
            // Atlas cards live on the Atlas-only board, never the main board — mirror
            // the same filter as app/board/page.tsx's initial query.
            .is('atlas_location_id', null)
            .order('position', { ascending: true }),
          supabase.from('columns').select('*').order('position', { ascending: true }),
        ])
        if (cards) setCards(cards as unknown as BoardCard[])
        if (columns) setLocalColumns(columns as Column[])
      } finally {
        reconciling = false
      }
    }

    let hasSubscribedOnce = false
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void reconcile()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    const channel = supabase
      .channel('board-realtime')

      // ── Cards ─────────────────────────────────────────────────────────────

      // New card from another user — fetch with clients join so it renders correctly
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cards' }, async (payload) => {
        const id = (payload.new as { id: string }).id
        if (isOwnEcho('card', id)) return
        // Atlas cards belong to the Atlas-only board — never append them to the main
        // board (the realtime payload carries the full row incl. atlas_location_id,
        // even though BOARD_CARD_SELECT omits it).
        if ((payload.new as { atlas_location_id: string | null }).atlas_location_id) return
        const { data } = await supabase
          .from('cards')
          .select(BOARD_CARD_SELECT)
          .eq('id', id)
          .eq('archived', false)
          .maybeSingle()
        if (!data) return
        setCards((prev) => {
          if (prev.some((c) => c.id === id)) return prev
          return [...prev, data as unknown as BoardCard]
        })
      })

      // Card updated by another user — merge changed fields into local state.
      // Archived cards are removed from the board; archived=false cards are kept.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cards' }, async (payload) => {
        const updated = payload.new as Record<string, unknown>
        const id = updated.id as string
        if (isOwnEcho('card', id)) return
        // Another user edited this card — drop any stale full-card cache entry so the
        // next drawer open refetches. Board state only carries BOARD_CARD_SELECT's slim
        // fields, so full-card-only fields (build_link, description, creative_brief,
        // fb_* copy) would otherwise keep showing the pre-edit value from the cache.
        evictCachedCard(id)
        // A card that gained an atlas_location_id now lives on the Atlas-only board —
        // drop it from the main board (same as an archive) and never re-fetch it.
        if (updated.atlas_location_id) {
          setCards((prev) => prev.filter((c) => c.id !== id))
          return
        }
        let missing = false
        setCards((prev) => {
          if ((updated.archived as boolean)) return prev.filter((c) => c.id !== id)
          const existing = prev.find((c) => c.id === id)
          if (!existing) {
            missing = true
            return prev
          }
          // Preserve the clients relation — it isn't in the realtime payload
          return prev.map((c) =>
            c.id === id ? { ...c, ...(updated as Partial<BoardCard>), clients: c.clients } : c
          )
        })
        // An UPDATE for a card not in local state can be an un-archive (e.g. a
        // Copy Tracker restart) — fetch it with the clients join and append,
        // mirroring the INSERT handler, so open board tabs pick it up live.
        if (missing && !(updated.archived as boolean) && !(updated.calendar_only as boolean)) {
          const { data } = await supabase
            .from('cards')
            .select(BOARD_CARD_SELECT)
            .eq('id', id)
            .eq('archived', false)
            .maybeSingle()
          if (!data) return
          setCards((prev) => {
            if (prev.some((c) => c.id === id)) return prev
            return [...prev, data as unknown as BoardCard]
          })
        }
      })

      // Card deleted by another user
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'cards' }, (payload) => {
        const id = (payload.old as { id: string }).id
        if (isOwnEcho('card', id)) return
        evictCachedCard(id)
        setCards((prev) => prev.filter((c) => c.id !== id))
      })

      // ── Columns ───────────────────────────────────────────────────────────

      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'columns' }, (payload) => {
        const col = payload.new as Column
        if (isOwnEcho('column', col.id)) return
        setLocalColumns((prev) =>
          [...prev, col].sort((a, b) => a.position - b.position)
        )
      })

      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'columns' }, (payload) => {
        const col = payload.new as Column
        if (isOwnEcho('column', col.id)) return
        setLocalColumns((prev) =>
          prev.map((c) => (c.id === col.id ? col : c)).sort((a, b) => a.position - b.position)
        )
      })

      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'columns' }, (payload) => {
        const id = (payload.old as { id: string }).id
        if (isOwnEcho('column', id)) return
        setLocalColumns((prev) => prev.filter((c) => c.id !== id))
      })

      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return
        // The first SUBSCRIBED is the initial mount (state is already fresh
        // from the server component). Any later one means the socket dropped
        // and rejoined — local state may have missed events while it was down.
        if (hasSubscribedOnce) void reconcile()
        hasSubscribedOnce = true
      })

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      void supabase.removeChannel(channel)
    }
  }, [supabase, setCards, setLocalColumns, isOwnEcho])
}
