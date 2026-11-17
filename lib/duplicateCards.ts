import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Duplicate existing cards onto OTHER clients' boards — "make the ACM cards for
 * BTA and GMA too". Shared by the board's multi-select "Duplicate to…" menu
 * (POST /api/cards/duplicate) and Brenda's `duplicate_cards` tool, so the two
 * can never disagree about what a duplicate carries.
 *
 * What carries over is the creative idea: copy, brief, media type, tier, dates.
 * What does NOT is anything that belongs to the source client — landing page,
 * Facebook page, files and creatives, Box/build links, UTM campaign, TTD ids,
 * Adviewer links, approval state. A copied landing page or graphic is the
 * dangerous kind of wrong: it looks finished and ships the wrong client's link.
 * So those start blank and the card lands in Queue for the team to fill in.
 */

// Keys inside messenger_welcome / instant_experience that point at the source
// client's destination or its uploaded files (types/index.ts).
const CLIENT_LINK_KEYS = new Set(['url', 'media_url', 'link_url', 'image_url', 'file_name'])

/** Deep copy of a JSON blob with every CLIENT_LINK_KEYS value replaced by `blank`. */
function stripClientLinks<T>(value: T, blank: '' | null): T {
  if (Array.isArray(value)) return value.map((v) => stripClientLinks(v, blank)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, CLIENT_LINK_KEYS.has(k) ? blank : stripClientLinks(v, blank)]),
    ) as T
  }
  return value
}

export interface DuplicateClient {
  id: string
  name: string
  abbreviation: string | null
}

export interface DuplicatePlanItem {
  sourceCardId: string
  sourceTitle: string
  sourceClientName: string | null
  targetClientId: string
  targetClientName: string
  newTitle: string
  /** Set when this pair will not be created, with the reason shown to the user. */
  skipReason: string | null
}

export interface DuplicateResult {
  plan: DuplicatePlanItem[]
  created: Array<{ id: string; title: string; clientName: string }>
  errors: string[]
}

interface SourceCard {
  id: string
  title: string
  client_id: string | null
  column_id: string | null
  atlas_location_id: string | null
  archived: boolean
  media_type: string | null
  description: string | null
  creative_brief: string | null
  tier: string | null
  first_draft_deadline: string | null
  flight_month: number | null
  flight_start_date: string | null
  flight_end_date: string | null
  utm_channel: string | null
  creative_name: string | null
  fb_body_text: string | null
  fb_headline: string | null
  fb_subheadline: string | null
  fb_link_description: string | null
  fb_cta: string | null
  heading: string | null
  subheading: string | null
  button_text: string | null
  caption: string | null
  boost_budget: string | null
  event_description: string | null
  messenger_welcome: unknown
  instant_experience: unknown
  adviewer_standalone: boolean
  clients: DuplicateClient | DuplicateClient[] | null
}

const SOURCE_SELECT =
  'id, title, client_id, column_id, atlas_location_id, archived, media_type, description, creative_brief, tier, ' +
  'first_draft_deadline, flight_month, flight_start_date, flight_end_date, utm_channel, creative_name, ' +
  'fb_body_text, fb_headline, fb_subheadline, fb_link_description, fb_cta, heading, subheading, button_text, ' +
  'caption, boost_budget, event_description, messenger_welcome, instant_experience, adviewer_standalone, ' +
  'clients(id, name, abbreviation)'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// \b treats "&" as a boundary, so "R&D" would match inside other words. Use
// explicit alphanumeric lookarounds so a tag only matches as a whole token.
function tokenPattern(token: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`, 'gi')
}

export function clientTag(client: DuplicateClient): string {
  return client.abbreviation?.trim() || client.name
}

/** Swap the source client's name/abbreviation for the target's tag wherever they appear as whole tokens. */
export function replaceClientTokens(
  text: string,
  source: DuplicateClient | null,
  target: DuplicateClient,
): { text: string; replaced: boolean } {
  if (!source) return { text, replaced: false }
  const tag = clientTag(target)
  const tokens = [source.name, source.abbreviation?.trim()]
    .filter((t): t is string => !!t)
    // Longest first, so a full name is replaced before a shorter tag inside it.
    .sort((a, b) => b.length - a.length)
  let out = text
  let replaced = false
  for (const t of tokens) {
    if (tokenPattern(t).test(out)) {
      out = out.replace(tokenPattern(t), tag)
      replaced = true
    }
  }
  return { text: out, replaced }
}

/**
 * "ACM - Spring Sale (Social)" → "BTA - Spring Sale (Social)". If the title names
 * neither the source's name nor abbreviation, the target tag is prefixed so the
 * copy is never indistinguishable from its source on the board.
 */
export function retagTitle(title: string, source: DuplicateClient | null, target: DuplicateClient): string {
  const r = replaceClientTokens(title, source, target)
  return r.replaced ? r.text : `${clientTag(target)} - ${title}`
}

function oneClient(c: SourceCard['clients']): DuplicateClient | null {
  if (!c) return null
  return Array.isArray(c) ? (c[0] ?? null) : c
}

async function loadSources(supabase: SupabaseClient, cardIds: string[]): Promise<SourceCard[]> {
  const { data, error } = await supabase.from('cards').select(SOURCE_SELECT).in('id', cardIds)
  if (error) throw new Error(`Could not load the selected cards: ${error.message}`)
  const byId = new Map((data as unknown as SourceCard[]).map((c) => [c.id, c]))
  // Preserve the caller's order, which is the order cards appear on the board.
  return cardIds.map((id) => byId.get(id)).filter((c): c is SourceCard => !!c)
}

async function loadTargets(supabase: SupabaseClient, clientIds: string[]): Promise<DuplicateClient[]> {
  const { data, error } = await supabase.from('clients').select('id, name, abbreviation').in('id', clientIds)
  if (error) throw new Error(`Could not load the target clients: ${error.message}`)
  return data as DuplicateClient[]
}

/** Read-only: what would be created. Used for Brenda's preview and the route's dry run. */
export async function planDuplicates(
  supabase: SupabaseClient,
  cardIds: string[],
  targetClientIds: string[],
): Promise<DuplicatePlanItem[]> {
  const [sources, targets] = await Promise.all([loadSources(supabase, cardIds), loadTargets(supabase, targetClientIds)])

  // Running the same duplicate twice (a double click, or Brenda confirming
  // twice) must not make a second set. A target that already has a live card
  // with the exact new title is skipped.
  const { data: existingRows, error: existingErr } = await supabase
    .from('cards').select('client_id, title')
    .in('client_id', targets.map((t) => t.id)).eq('archived', false)
  if (existingErr) throw new Error(`Could not check for existing copies: ${existingErr.message}`)
  const existing = new Set(
    ((existingRows ?? []) as Array<{ client_id: string; title: string }>).map((r) => `${r.client_id}|${r.title.trim().toLowerCase()}`),
  )

  const plan: DuplicatePlanItem[] = []
  for (const card of sources) {
    const sourceClient = oneClient(card.clients)
    for (const target of targets) {
      const newTitle = retagTitle(card.title, sourceClient, target)
      let skipReason: string | null = null
      if (card.archived) skipReason = 'source card is archived'
      else if (card.atlas_location_id) skipReason = 'Atlas cards live on the Atlas board and are not duplicated this way'
      else if (card.client_id === target.id) skipReason = 'card already belongs to this client'
      else if (existing.has(`${target.id}|${newTitle.trim().toLowerCase()}`)) skipReason = 'a card with this title already exists for this client'
      // Two sources that retag to the same title for one target: only the first is made.
      if (!skipReason) existing.add(`${target.id}|${newTitle.trim().toLowerCase()}`)
      plan.push({
        sourceCardId: card.id,
        sourceTitle: card.title,
        sourceClientName: sourceClient?.name ?? null,
        targetClientId: target.id,
        targetClientName: target.name,
        newTitle,
        skipReason,
      })
    }
  }
  return plan
}

export async function duplicateCards(
  supabase: SupabaseClient,
  cardIds: string[],
  targetClientIds: string[],
  actorEmail: string | null,
): Promise<DuplicateResult> {
  const plan = await planDuplicates(supabase, cardIds, targetClientIds)
  const toCreate = plan.filter((p) => !p.skipReason)
  const result: DuplicateResult = { plan, created: [], errors: [] }
  if (toCreate.length === 0) return result

  const [sourceRows, targetRows] = await Promise.all([
    loadSources(supabase, [...new Set(toCreate.map((p) => p.sourceCardId))]),
    loadTargets(supabase, [...new Set(toCreate.map((p) => p.targetClientId))]),
  ])
  const sources = new Map(sourceRows.map((c) => [c.id, c]))
  const targetsById = new Map(targetRows.map((c) => [c.id, c]))

  // New work starts in Queue. Looked up by TITLE: the first column by position
  // is "Templates" on the live board, so "first column" would file every copy
  // there. Falls back to the first column only if no column is named Queue.
  const { data: cols, error: colErr } = await supabase
    .from('columns').select('id, title').order('position', { ascending: true })
  const colRows = (cols ?? []) as Array<{ id: string; title: string }>
  const queueCol = colRows.find((c) => c.title.trim().toLowerCase() === 'queue') ?? colRows[0]
  if (colErr || !queueCol) {
    result.errors.push('Could not find the Queue column.')
    return result
  }
  const { count } = await supabase
    .from('cards').select('id', { count: 'exact', head: true })
    .eq('column_id', queueCol.id).eq('archived', false)
  let position = count ?? 0

  const now = new Date().toISOString()
  for (const item of toCreate) {
    const src = sources.get(item.sourceCardId)
    const target = targetsById.get(item.targetClientId)
    if (!src || !target) continue
    const sourceClient = oneClient(src.clients)

    const { data: inserted, error: insErr } = await supabase
      .from('cards')
      .insert({
        title: item.newTitle,
        client_id: item.targetClientId,
        column_id: queueCol.id,
        position: position++,
        media_type: src.media_type,
        description: src.description,
        creative_brief: src.creative_brief,
        tier: src.tier,
        first_draft_deadline: src.first_draft_deadline,
        flight_month: src.flight_month,
        flight_start_date: src.flight_start_date,
        flight_end_date: src.flight_end_date,
        utm_channel: src.utm_channel,
        // Retagged when it names the source client; a generic name carries over as-is.
        creative_name: src.creative_name ? replaceClientTokens(src.creative_name, sourceClient, target).text : null,
        fb_body_text: src.fb_body_text,
        fb_headline: src.fb_headline,
        fb_subheadline: src.fb_subheadline,
        fb_link_description: src.fb_link_description,
        fb_cta: src.fb_cta,
        heading: src.heading,
        subheading: src.subheading,
        button_text: src.button_text,
        caption: src.caption,
        boost_budget: src.boost_budget,
        event_description: src.event_description,
        // Structure and copy carry over; every link and media ref inside is blanked.
        messenger_welcome: stripClientLinks(src.messenger_welcome, ''),
        instant_experience: stripClientLinks(src.instant_experience, null),
        adviewer_standalone: src.adviewer_standalone,
        // Deliberately blank — these belong to the source client:
        landing_page_url: null,
        fb_page_name: null,
        preview_image_url: null,
        box_folder_id: null,
        build_link: null,
        display_build_link: null,
        utm_campaign: null,
        ttd_ad_group_id: null,
        ttd_ad_group_ids: null,
        adpiler_preview_url: null,
        approval_status: 'none',
        work_status: null,
        archived: false,
        calendar_only: false,
        created_at: now,
        updated_at: now,
      })
      .select('id, title')
      .single()

    if (insErr || !inserted) {
      result.errors.push(`"${item.newTitle}" for ${item.targetClientName}: ${insErr?.message ?? 'insert failed'}`)
      continue
    }
    const newId = (inserted as { id: string }).id
    result.created.push({ id: newId, title: item.newTitle, clientName: item.targetClientName })

    // Carousel slides keep their copy, lose their images and links (same rule as the card).
    if (src.media_type === 'Carousel Ad') {
      const { data: slides, error: slideReadErr } = await supabase
        .from('carousel_slides')
        .select('position, headline, subheadline, link_description, graphic_headline, graphic_subhead')
        .eq('card_id', src.id)
        .order('position', { ascending: true })
      if (slideReadErr) {
        result.errors.push(`"${item.newTitle}": card created but carousel slides could not be read (${slideReadErr.message})`)
      } else if (slides && slides.length > 0) {
        const { error: slideErr } = await supabase.from('carousel_slides').insert(
          (slides as Array<Record<string, unknown>>).map((s) => ({ ...s, card_id: newId, created_at: now, updated_at: now })),
        )
        if (slideErr) result.errors.push(`"${item.newTitle}": card created but carousel slides failed (${slideErr.message})`)
      }
    }

    const { error: actErr } = await supabase.from('card_activity').insert({
      card_id: newId,
      actor: actorEmail ?? 'Team',
      actor_email: actorEmail,
      // 'updated', not 'created': CardActivityPanel only renders the actions it knows.
      action: 'updated',
      detail: `Duplicated from "${src.title}"${item.sourceClientName ? ` (${item.sourceClientName})` : ''} — landing page, Facebook page and files left blank`,
      created_at: now,
    })
    if (actErr) console.error('[duplicateCards] activity log failed', newId, actErr.message)
  }
  return result
}
