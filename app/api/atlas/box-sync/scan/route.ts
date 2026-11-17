import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { getBoxToken, listFolderItems } from '@/lib/box'
import { pickNamedFolder, resolveRootFolderId } from '@/lib/boxSharedLink'
import {
  ATLAS_BOX_DISPLAY_ROOT_DEFAULT, ATLAS_BOX_DISPLAY_ROOT_KEY, ATLAS_BOX_SOCIAL_ROOT_DEFAULT,
  ATLAS_BOX_SOCIAL_ROOT_KEY, isAtlasBoxQuarter, isAtlasBoxYear,
} from '@/lib/atlasBoxRoots'
import {
  walkAtlasBuilds, walkDisplayBuilds, matchAtlasBoxTrees, type AtlasSyncCard, type AtlasSyncLocation,
} from '@/lib/atlasBoxSync'

export const maxDuration = 300

/** <root>/<year>/<quarter> → that folder's id, or null when either level is absent. */
async function findPeriodFolder(
  rootId: string,
  year: number,
  quarter: string,
  token: string,
): Promise<{ id: string | null; missing: string | null }> {
  const yearFolder = pickNamedFolder(await listFolderItems(rootId, token), String(year))
  if (!yearFolder) return { id: null, missing: String(year) }
  const quarterFolder = pickNamedFolder(await listFolderItems(yearFolder.id, token), quarter)
  if (!quarterFolder) return { id: null, missing: `${year}/${quarter}` }
  return { id: quarterFolder.id, missing: null }
}

/**
 * POST — dry run. Walks the Social Media and Banner Ads trees for one
 * year/quarter, matches every Build folder to the Atlas cards it should attach
 * to, and returns the result for the confirm screen.
 *
 * WRITES NOTHING. Applying is a separate, explicitly confirmed call
 * (app/api/atlas/box-sync/apply).
 */
export async function POST(req: Request) {
  const denied = await requireWriter()
  if (denied) return denied

  let body: { year?: number; quarter?: string }
  try {
    body = (await req.json()) as { year?: number; quarter?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!isAtlasBoxYear(body.year) || !isAtlasBoxQuarter(body.quarter)) {
    return NextResponse.json({ error: 'year (e.g. 2026) and quarter (Q1–Q4) are required' }, { status: 400 })
  }
  const { year, quarter } = body

  let token: string
  try {
    token = await getBoxToken()
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Box not connected' },
      { status: 503 },
    )
  }

  // app_settings is read with the service role: the roots are config, not
  // staff-readable keys (supabase/restrict_app_settings_reads.sql).
  const admin = createAdminClient()
  const { data: rootRows } = await admin
    .from('app_settings')
    .select('key, value')
    .in('key', [ATLAS_BOX_SOCIAL_ROOT_KEY, ATLAS_BOX_DISPLAY_ROOT_KEY])
  const setting = (key: string, fallback: string) =>
    ((rootRows ?? []) as { key: string; value: string }[]).find((r) => r.key === key)?.value?.trim() || fallback
  const socialRootUrl = setting(ATLAS_BOX_SOCIAL_ROOT_KEY, ATLAS_BOX_SOCIAL_ROOT_DEFAULT)
  const displayRootUrl = setting(ATLAS_BOX_DISPLAY_ROOT_KEY, ATLAS_BOX_DISPLAY_ROOT_DEFAULT)

  const supabase = await createClient()
  const [{ data: locationsRaw }, { data: cardsRaw }] = await Promise.all([
    supabase.from('atlas_locations').select('id, name').eq('active', true).order('name'),
    supabase
      .from('cards')
      .select('id, title, atlas_location_id, box_folder_id, build_link, display_build_link')
      .not('atlas_location_id', 'is', null)
      .eq('archived', false)
      .eq('media_type', 'Social Ad Request'),
  ])

  const locations = (locationsRaw ?? []) as AtlasSyncLocation[]
  type CardRow = AtlasSyncCard & { build_link: string | null; display_build_link: string | null }
  const cards = (cardsRaw ?? []) as CardRow[]

  try {
    const [socialRootId, displayRootId] = await Promise.all([
      resolveRootFolderId(socialRootUrl, token),
      resolveRootFolderId(displayRootUrl, token),
    ])
    const [socialPeriod, displayPeriod] = await Promise.all([
      findPeriodFolder(socialRootId, year, quarter, token),
      findPeriodFolder(displayRootId, year, quarter, token),
    ])

    // The Social tree is the one that exists today; a missing period there is a
    // wrong pick, so say so. Banner Ads is built later, so a missing period
    // there is normal and is reported per row instead.
    if (!socialPeriod.id) {
      return NextResponse.json(
        { error: `Social Media has no ${socialPeriod.missing} folder — check the year and quarter` },
        { status: 404 },
      )
    }

    const [socialBuilds, displayBuilds] = await Promise.all([
      walkAtlasBuilds(socialPeriod.id, token),
      displayPeriod.id ? walkDisplayBuilds(displayPeriod.id, token) : Promise.resolve([]),
    ])
    const displayTreeNote = displayPeriod.id ? null : `Banner Ads has no ${displayPeriod.missing} folder yet`
    const result = matchAtlasBoxTrees(socialBuilds, displayBuilds, cards, locations, displayTreeNote)

    // Full roster so the confirm screen can label and re-pick cards without a
    // second round trip. Duplicate titles are real (two "Breast" cards at MetroCare
    // Valley), so the picker shows the card id tail to tell them apart.
    const locationName = new Map(locations.map((l) => [l.id, l.name]))
    const roster = cards.map((c) => ({
      id: c.id,
      title: c.title.replace(/\s+/g, ' ').trim(),
      locationName: c.atlas_location_id ? locationName.get(c.atlas_location_id) ?? '—' : '—',
      alreadyLinked: !!c.box_folder_id,
      buildLink: c.build_link?.trim() || null,
      displayBuildLink: c.display_build_link?.trim() || null,
    }))

    return NextResponse.json({
      year,
      quarter,
      displayPeriodFound: !!displayPeriod.id,
      displayTreeNote,
      ...result,
      roster,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Box walk failed' },
      { status: 502 },
    )
  }
}
