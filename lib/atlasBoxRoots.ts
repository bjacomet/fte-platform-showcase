/**
 * The two Box roots the Atlas sync walks, plus the year/quarter descent.
 *
 *   Social Media/<Year>/<Quarter>/<Location>/<Focus>/Build   (MP4s + PNG)
 *   Banner Ads/<Year>/<Quarter>/<Location>/<Focus>/Build     (six HTML5 zips)
 *
 * Stored in app_settings so a root can move without a deploy. The defaults are
 * labels only: set the real external Box folder links in app_settings.
 */

export const ATLAS_BOX_SOCIAL_ROOT_KEY = 'atlas_box_social_root'
export const ATLAS_BOX_DISPLAY_ROOT_KEY = 'atlas_box_display_root'

export const ATLAS_BOX_SOCIAL_ROOT_DEFAULT = 'External Box folder (social root)'
export const ATLAS_BOX_DISPLAY_ROOT_DEFAULT = 'External Box folder (display root)'

export const ATLAS_BOX_QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const
export type AtlasBoxQuarter = (typeof ATLAS_BOX_QUARTERS)[number]

export function isAtlasBoxQuarter(v: unknown): v is AtlasBoxQuarter {
  return typeof v === 'string' && (ATLAS_BOX_QUARTERS as readonly string[]).includes(v)
}

/** A plausible 4-digit year; the folders are plain "2026". */
export function isAtlasBoxYear(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 2020 && v <= 2100
}

/** The current quarter, for the picker's default. */
export function currentAtlasBoxPeriod(d: Date): { year: number; quarter: AtlasBoxQuarter } {
  return { year: d.getFullYear(), quarter: ATLAS_BOX_QUARTERS[Math.floor(d.getMonth() / 3)] }
}
