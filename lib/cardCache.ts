import { createClient } from './supabase/client'
import { FULL_CARD_SELECT } from './cardQueries'
import type { Card } from '@/types'

let _supabase: ReturnType<typeof createClient> | null = null

function getSupabase() {
  if (!_supabase) _supabase = createClient()
  return _supabase
}

const cache = new Map<string, Card>()
const MAX_SIZE = 50
let inFlight = 0
const MAX_IN_FLIGHT = 2

const stats = {
  prefetchAttempts: 0,
  prefetchSkippedCap: 0,
  cacheHits: 0,
  drawerOpens: 0,
  revalidations: 0,
}

// Fetch and cache full card data. Fire-and-forget safe.
export function prefetchCard(id: string): void {
  if (cache.has(id)) return
  if (inFlight >= MAX_IN_FLIGHT) {
    stats.prefetchSkippedCap++
    return
  }
  stats.prefetchAttempts++
  inFlight++
  void (async () => {
    try {
      const { data } = await getSupabase()
        .from('cards')
        .select(FULL_CARD_SELECT)
        .eq('id', id)
        .single()
      if (data) {
        if (cache.size >= MAX_SIZE) {
          const firstKey = cache.keys().next().value as string | undefined
          if (firstKey !== undefined) cache.delete(firstKey)
        }
        cache.set(id, data as Card)
      }
    } finally {
      inFlight--
    }
  })()
}

// Returns the cached card and records a cache hit. Returns null on miss.
export function getPrefetchedCard(id: string): Card | null {
  const card = cache.get(id) ?? null
  if (card) stats.cacheHits++
  return card
}

// Call after a save so the cache stays fresh and the next open shows current data.
export function updateCachedCard(card: Card): void {
  if (cache.has(card.id)) {
    cache.set(card.id, card)
  }
}

// Call after a column move (drag-and-drop, quick move) so stale column_id
// can't silently revert a card's position on the next drawer save.
export function evictCachedCard(id: string): void {
  cache.delete(id)
}

// Call when local state may have drifted from the DB wholesale (realtime
// reconnect after a dropped socket) — every cached full card could be stale
// for an edit made by another user while we were disconnected.
export function clearCardCache(): void {
  cache.clear()
}

export function recordDrawerOpen(): void {
  stats.drawerOpens++
}

export function recordRevalidation(): void {
  stats.revalidations++
}

// Revert signals:
//   hit rate < 40% after 5+ opens → prefetch is mostly wasted, revert #1
//   skipped_cap > 20% of attempts → users scan fast, raise debounce before reverting
if (typeof window !== 'undefined') {
  const w = window as typeof window & { __ftePerf?: () => object }
  w.__ftePerf = (): object => {
    const hitRate = stats.drawerOpens > 0
      ? Math.round((stats.cacheHits / stats.drawerOpens) * 100)
      : 0
    const skipRate = stats.prefetchAttempts > 0
      ? Math.round((stats.prefetchSkippedCap / stats.prefetchAttempts) * 100)
      : 0
    const verdict = stats.drawerOpens < 5
      ? '— (not enough data yet)'
      : hitRate < 40
      ? '⚠ Hit rate low — consider reverting #1 hover prefetch'
      : skipRate > 20
      ? '⚠ High skip rate — raise card hover debounce from 200ms to 400ms'
      : '✓ Healthy'
    return {
      prefetch: {
        attempts: stats.prefetchAttempts,
        skipped_cap: stats.prefetchSkippedCap,
        cache_hits: stats.cacheHits,
        hit_rate: `${hitRate}%`,
        cache_size: cache.size,
        in_flight: inFlight,
      },
      drawer_opens: stats.drawerOpens,
      board_revalidations: stats.revalidations,
      verdict,
      revert_signals: [
        'hit_rate < 40% after 5+ opens → revert #1 (hover prefetch)',
        'skipped_cap > 20% of attempts → raise card hover debounce to 400ms',
        'board_revalidations spiking unexpectedly → check for save loops (#3)',
      ],
    }
  }
}
