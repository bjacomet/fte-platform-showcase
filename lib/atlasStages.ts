import { ATLAS_CARD_FIELD_KEYS, type AtlasBoardColumn, type AtlasCardFieldKey, type AtlasCardFields } from '@/types'

export const ATLAS_CARD_FIELD_LABELS: Record<AtlasCardFieldKey, string> = {
  thumbnail: 'Thumbnail',
  location: 'Location name',
  work_status: 'Work status',
  approval: 'Client approval',
  display_build: 'Display build chip',
  badges: 'Re-run / Pending badges',
  deadline: 'Deadline colour strip',
  adviewer_link: 'View in Adviewer button',
}

// Stored settings may predate a key added later, or be an empty object on a
// fresh row. Missing keys mean ON, so a new field never silently disappears
// from everyone's cards the day it ships.
export function resolveCardFields(stored: Partial<AtlasCardFields> | null | undefined): AtlasCardFields {
  const out = {} as AtlasCardFields
  for (const key of ATLAS_CARD_FIELD_KEYS) out[key] = stored?.[key] !== false
  return out
}

export function sortColumns(columns: AtlasBoardColumn[]): AtlasBoardColumn[] {
  return [...columns].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
}

// A card with no stage — or a stage that was deleted out from under it (FK is
// ON DELETE SET NULL, but local state can hold a stale id for a moment) —
// renders in the first column rather than vanishing.
export function stageForCard(atlasColumnId: string | null | undefined, columns: AtlasBoardColumn[]): string | null {
  if (columns.length === 0) return null
  const sorted = sortColumns(columns)
  if (atlasColumnId && sorted.some((c) => c.id === atlasColumnId)) return atlasColumnId
  return sorted[0].id
}

// Positions are rewritten 0..n-1 on every reorder so they never collide or drift.
export function moveColumn(columns: AtlasBoardColumn[], id: string, delta: -1 | 1): AtlasBoardColumn[] {
  const sorted = sortColumns(columns)
  const i = sorted.findIndex((c) => c.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= sorted.length) return sorted.map((c, idx) => ({ ...c, position: idx }))
  const next = [...sorted]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next.map((c, idx) => ({ ...c, position: idx }))
}

export function nextColumnPosition(columns: AtlasBoardColumn[]): number {
  return columns.reduce((max, c) => Math.max(max, c.position), -1) + 1
}

const HEX = /^#[0-9a-f]{6}$/i
export function safeColor(color: string | null | undefined): string {
  return color && HEX.test(color) ? color : '#0075a9'
}
