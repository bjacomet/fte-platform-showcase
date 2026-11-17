// Per-media-type visual treatment shared across Calendar views.
// Centralized so Grid / List / future views agree on color encoding.

import type { Card } from '@/types'

export type MediaTypeKey =
  | 'social'
  | 'carousel'
  | 'reel'
  | 'eblast'
  | 'organic'
  | 'other'

export function mediaTypeKey(mediaType: string | null | undefined): MediaTypeKey {
  switch (mediaType) {
    case 'Social Ad Request':
      return 'social'
    case 'Carousel Ad':
      return 'carousel'
    case 'Reel Request':
      return 'reel'
    case 'Eblast':
      return 'eblast'
    case 'Organic Post':
      return 'organic'
    default:
      return 'other'
  }
}

interface MediaStyle {
  /** Background colour for the post bar in Grid view. */
  barBg: string
  /** Subtle pill background for List view. */
  pillBg: string
  /** Pill text colour for List view. */
  pillText: string
  /** Short label for the pill ("Social ad" / "Carousel" / etc). */
  label: string
}

const STYLES: Record<MediaTypeKey, MediaStyle> = {
  social:   { barBg: '#1a4a7a', pillBg: 'rgba(55,134,221,0.18)', pillText: '#85b7eb', label: 'Social ad' },
  carousel: { barBg: '#854f0b', pillBg: 'rgba(239,159,39,0.18)', pillText: '#fac775', label: 'Carousel' },
  reel:     { barBg: '#993556', pillBg: 'rgba(212,83,126,0.18)', pillText: '#ed93b1', label: 'Reel' },
  eblast:   { barBg: '#185fa5', pillBg: 'rgba(24,95,165,0.22)',  pillText: '#85b7eb', label: 'Eblast' },
  organic:  { barBg: '#0f6e56', pillBg: 'rgba(29,158,117,0.18)', pillText: '#5dcaa5', label: 'Organic' },
  other:    { barBg: '#2a2e3c', pillBg: 'rgba(95,94,90,0.3)',    pillText: '#b4b2a9', label: 'Other' },
}

export function mediaStyle(mediaType: string | null | undefined): MediaStyle {
  return STYLES[mediaTypeKey(mediaType)]
}

// ── Card status ────────────────────────────────────────────────────────────

export type CardStatus = 'approved' | 'needs_image' | 'scheduled' | 'draft'

export function deriveCardStatus(card: Card, hasImage: boolean): CardStatus {
  if (card.approval_status === 'approved') return 'approved'
  if (!hasImage && card.media_type !== 'Carousel Ad') return 'needs_image'
  if (card.flight_start_date) return 'scheduled'
  return 'draft'
}

interface StatusStyle {
  dot: string
  label: string
  pillBg: string
  pillText: string
}

const STATUS: Record<CardStatus, StatusStyle> = {
  approved:    { dot: '#5dcaa5', label: 'Approved',    pillBg: 'rgba(15,110,86,0.25)', pillText: '#5dcaa5' },
  needs_image: { dot: '#fac775', label: 'Needs image', pillBg: 'rgba(133,79,11,0.3)',  pillText: '#fac775' },
  scheduled:   { dot: '#85b7eb', label: 'Scheduled',   pillBg: 'rgba(24,95,165,0.3)',  pillText: '#85b7eb' },
  draft:       { dot: '#b4b2a9', label: 'Draft',       pillBg: 'rgba(95,94,90,0.3)',   pillText: '#b4b2a9' },
}

export function statusStyle(status: CardStatus): StatusStyle {
  return STATUS[status]
}
