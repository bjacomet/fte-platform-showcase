import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import AtlasWorkspaceClient from './AtlasWorkspaceClient'
import { ATLAS_BOARD_CARD_SELECT, ATLAS_BOARD_CARD_SELECT_NO_QUARTER } from '@/lib/cardQueries'
import type { AtlasLocation, AtlasBrandingAsset, AtlasCreativeRefresh, AtlasBoardCard, AtlasBoardColumn, AtlasBoardSettings, Client } from '@/types'

export const revalidate = 0

type ServerClient = Awaited<ReturnType<typeof createClient>>

// Never blank the board for a missing optional column: if the select fails because
// atlas_quarter / atlas_year do not exist yet, retry without them and report it so the
// board hides its Quarter filter. The original error is kept as a hint banner.
async function loadAtlasCards(supabase: ServerClient) {
  const query = (select: string) =>
    supabase
      .from('cards')
      .select(select)
      .not('atlas_location_id', 'is', null)
      .eq('archived', false)
      .order('position', { ascending: true })
  const first = await query(ATLAS_BOARD_CARD_SELECT)
  if (first.error && /atlas_quarter|atlas_year/.test(first.error.message)) {
    const retry = await query(ATLAS_BOARD_CARD_SELECT_NO_QUARTER)
    if (!retry.error) return { data: retry.data, error: first.error, quarterColumnsMissing: true }
    return { data: retry.data, error: retry.error, quarterColumnsMissing: false }
  }
  return { data: first.data, error: first.error, quarterColumnsMissing: false }
}

export default async function AtlasWorkspacePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    { data: locationsRaw },
    { data: assetsRaw },
    { data: refreshRaw },
    { data: cardsRaw, error: cardsError, quarterColumnsMissing },
    { data: clientsRaw },
    { data: bgRow },
    { data: stageColumnsRaw, error: stagesError },
    { data: atlasSettingsRow },
  ] = await Promise.all([
    supabase
      .from('atlas_locations')
      .select('*')
      .eq('active', true)
      .order('name'),
    supabase
      .from('atlas_branding_assets')
      .select('*')
      .order('label'),
    supabase
      .from('atlas_creative_refresh')
      .select('*')
      .order('year', { ascending: false })
      .order('quarter')
      .order('focus_type'),
    loadAtlasCards(supabase),
    supabase
      .from('clients')
      .select('*')
      .eq('active', true)
      .order('name', { ascending: true }),
    // Same board-background setting the main FTE board uses, so the Atlas board
    // canvas matches it (see app/board/page.tsx).
    supabase.from('app_settings').select('value').eq('key', 'board_background_url').maybeSingle(),
    // Atlas board stages + its own settings. atlas_column_id now rides on
    // ATLAS_BOARD_CARD_SELECT — add_atlas_board_stages.sql is live (#110). Settings
    // are read with '*' so a column added by a later migration (the auto-move
    // stage ids) can be missing without failing the read and losing the
    // board's own background.
    supabase.from('atlas_board_columns').select('id, title, position, color, created_at').order('position'),
    supabase.from('atlas_board_settings').select('*').maybeSingle(),
  ])

  const locations = (locationsRaw ?? []) as AtlasLocation[]
  const assets = (assetsRaw ?? []) as AtlasBrandingAsset[]
  const refreshRows = (refreshRaw ?? []) as AtlasCreativeRefresh[]
  const cards = (cardsRaw ?? []) as unknown as AtlasBoardCard[]
  const stageColumns = (stageColumnsRaw ?? []) as AtlasBoardColumn[]
  const atlasSettings = (atlasSettingsRow ?? null) as AtlasBoardSettings | null
  // Every query here destructures `data` only, so a failure lands as `null` and
  // falls through to an empty array — and an empty Atlas board is indistinguishable
  // from a real one with no creatives. That is not hypothetical: until
  // supabase/add_display_build_link.sql is applied, ATLAS_BOARD_CARD_SELECT names a
  // column that does not exist, PostgREST returns 42703, and the board renders
  // "0 cards across N locations" with nothing anywhere saying why. Surfacing it
  // is the difference between "run the migration" and "Atlas lost its creatives".
  if (cardsError) console.error('[atlas] board card query failed:', cardsError.message)
  const clients = (clientsRaw ?? []) as Client[]
  // Use || (not ??) so an empty-string value also falls through to the default — mirrors app/board/page.tsx
  const fteBackgroundUrl = bgRow?.value || 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1600&q=80&fit=crop'
  // The Atlas board's own background wins; unset falls back to the FTE board's.
  const backgroundUrl = atlasSettings?.background_url || fteBackgroundUrl

  return (
    <AtlasWorkspaceClient
      initialLocations={locations}
      initialAssets={assets}
      initialRefreshRows={refreshRows}
      initialCards={cards}
      cardsError={cardsError?.message ?? null}
      quarterColumnsMissing={quarterColumnsMissing}
      clients={clients}
      backgroundUrl={backgroundUrl}
      stageColumns={stageColumns}
      stagesError={stagesError?.message ?? null}
      atlasSettings={atlasSettings}
      userEmail={user.email ?? 'unknown'}
    />
  )
}
