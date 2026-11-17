import type { createAdminClient } from '@/lib/supabase/server'
import type { AdviewerStatus } from '@/types'

/**
 * One URL shape, two kinds of token.
 *
 * `/adviewer/c/<token>` is opened either with a CAMPAIGN token (corporate sees
 * every creative in the campaign) or with a SCOPE token (one Atlas location sees
 * only its own creatives). Every server route that a reviewer's browser can
 * reach has to be able to tell the two apart, because the authority they carry
 * is different: a campaign token speaks for the whole campaign, a scope token
 * speaks for exactly one location and must not be able to touch anything else.
 *
 * Resolving that lives here rather than being re-derived per route, because a
 * route that forgets the scope branch does not fail loudly — it silently writes
 * across all of its locations.
 */

type Admin = ReturnType<typeof createAdminClient>

export interface ReviewScope {
  id: string
  /** Never null on a usable scope — see resolveReviewToken. */
  atlasLocationId: string
  locationName: string | null
}

export interface ResolvedReviewToken {
  campaignId: string
  /** null = campaign token (corporate). Non-null = one location's slice. */
  scope: ReviewScope | null
}

/**
 * Campaign lookup first because it is the common case; only a miss costs the
 * second query.
 *
 * A scope whose `atlas_location_id` is NULL resolves to null, i.e. an invalid
 * token. The FK is `on delete set null`, so deleting or merging an Atlas location
 * leaves a live token behind; treating it as "no location filter" would fail
 * OPEN and hand that link the entire campaign. Failing closed turns a stale
 * link into a 404, which is the honest outcome.
 */
export async function resolveReviewToken(
  admin: Admin,
  token: string,
): Promise<ResolvedReviewToken | null> {
  const { data: campaign } = await admin
    .from('adviewer_campaigns')
    .select('id')
    .eq('token', token)
    .maybeSingle()
  if (campaign) return { campaignId: campaign.id as string, scope: null }

  const { data: scope } = await admin
    .from('adviewer_campaign_scopes')
    .select('id, campaign_id, atlas_location_id, atlas_location:atlas_locations(id, name)')
    .eq('token', token)
    .maybeSingle()
  if (!scope) return null

  const typed = scope as unknown as {
    id: string
    campaign_id: string
    atlas_location_id: string | null
    atlas_location: { id: string; name: string } | null
  }
  if (!typed.atlas_location_id) return null

  return {
    campaignId: typed.campaign_id,
    scope: {
      id: typed.id,
      atlasLocationId: typed.atlas_location_id,
      locationName: typed.atlas_location?.name ?? null,
    },
  }
}

/**
 * Recompute a campaign's status — and its archived flag — from its locations'
 * scopes.
 *
 * Only one outcome moves the campaign on its own:
 *   any location asked for changes  → needs_revision, un-archived
 *   anything else (incl. every location approved) → left as it is; staff file it
 * (see "STAFF FILE THE CAMPAIGN" below; `correcting` is the card-approve exception)
 *
 * The "leave it alone" branch is the important one. Location links can be
 * generated whether or not corporate has reviewed (the approval gate was removed),
 * so a campaign's own status may be corporate's verdict — approved, or a change
 * request — while its scopes are still pending. Rolling that up would overwrite
 * corporate's verdict with a partial signal from the locations.
 *
 * WHY THIS WRITES `archived` TOO. It maintains one invariant, going forward,
 * for every campaign this code path touches:
 *
 *   a campaign at `needs_revision` is never `archived`.
 *
 * Stated that way on purpose. It is NOT true of rows already in the database —
 * `Example University — July 2026` sits at archived + needs_revision today, from before
 * any of this existed. Nothing here repairs such a row, and nothing depends on
 * it having been repaired; the guarantee is only that this path stops creating
 * them. Reading the comment as a claim about all data would be wrong.
 *
 * That is what makes the second revision cycle terminate. `adviewer_am_approve`
 * ends with `update … set status='approved', archived=true where id = v_cid and
 * archived = false` — so against an archived campaign it matches zero rows and
 * silently does nothing. A campaign left at needs_revision + archived could
 * therefore never be re-approved by the AM: the designer fixes the creative, the
 * approval writes nothing, and the campaign is stuck forever. The scopes POST
 * gate then 409s for that campaign permanently, so no new location can be issued
 * a link either.
 *
 * Un-archiving on needs_revision fixes that WITHOUT touching the RPC, because it
 * makes the RPC's existing guard true rather than something to work around — the
 * guard assumes exactly this invariant. It also puts the campaign back on the
 * dashboard, which is where an AM has to see it to act on it.
 *
 * `correcting` is for one caller only: card-approve, after the RPC has archived a
 * campaign whose locations have NOT all signed off. There the mixed case cannot
 * be a no-op, because a no-op would leave the RPC's wrong archive standing. See
 * app/api/adviewer/card-approve/route.ts.
 */
export async function rollUpCampaignFromScopes(
  admin: Admin,
  campaignId: string,
  opts: { correcting?: boolean } = {},
): Promise<AdviewerStatus | null> {
  const { data: scopes } = await admin
    .from('adviewer_campaign_scopes')
    .select('status')
    .eq('campaign_id', campaignId)

  const rows = (scopes ?? []) as { status: AdviewerStatus }[]
  if (rows.length === 0) return null

  // STAFF FILE THE CAMPAIGN, NOT THE LOCATIONS (2026-10-05). An all-approved set
  // of scopes no longer approves + archives the campaign on its own. Once location
  // links could be generated before corporate signed off (no approval gate), the
  // auto-file had two bad outcomes: a campaign filed to the Lookbook with corporate
  // never having looked, and — worse — corporate's own needs_revision silently
  // overwritten to approved because every location okayed its slice. the designer's
  // call: "let our staff drive the car." Locations' answers are recorded on their
  // scopes (the Location links panel shows them); staff file the campaign with
  // Approve → Lookbook when they judge it done.
  //
  // What still moves on its own:
  //   any location asked for changes → needs_revision, un-archived. That only
  //   SURFACES work for staff (puts the campaign back on the dashboard); it never
  //   hides or files anything.
  //   `correcting` (card-approve only): the AM's approve RPC just archived the
  //   campaign; all-approved scopes let that archive stand, a mixed set undoes it.
  //   That is still a staff action being made consistent, not locations deciding.
  const allApproved = rows.every((s) => s.status === 'approved')
  const next: AdviewerStatus | null = rows.some((s) => s.status === 'needs_revision')
    ? 'needs_revision'
    : opts.correcting
      ? (allApproved ? 'approved' : 'pending')
      : null
  if (!next) return null

  await admin
    .from('adviewer_campaigns')
    .update({
      status: next,
      // Filed only when every location is done with it.
      archived: next === 'approved',
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId)
  return next
}
