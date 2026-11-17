// Validation + payload building for the Clients page "Add / Edit client" form.
// Pure (no Supabase, no React) so the browser form and the staff-only API route
// (`app/api/clients/route.ts`) run the exact same checks, and `npm test` covers them.
//
// One save writes two rows atomically through the service-role RPC
// `public.admin_save_client` (migrations `supabase/add_client_admin_rpc.sql`, `add_client_name_aliases.sql`):
//   - `public.clients`        — the board's client record
//   - `ops.client_accounts`   — the campaign-ops record of the client's platform
//                               accounts (TTD advertiser, Meta act/page/pixel, copy tracker) and the
//                               client's ABW / TTD advertiser names the coverage check matches on

import { withHttpsScheme } from './url'
import type { Client } from '../types'

/** Every field on the form, as the strings the inputs hold. */
export interface ClientFormInput {
  name: string
  abbreviation: string
  active: boolean
  tier: string
  designer_name: string
  designer_email: string
  adpiler_campaign_code: string
  fb_page_logo_url: string
  brand_website_url: string
  brand_notes: string
  /** JSON object text, or blank for none. */
  utm_config: string
  // ops.client_accounts
  ttd_advertiser_id: string
  fb_ad_account_id: string
  fb_page_id: string
  fb_pixel_id: string
  ig_account: string
  /** Sheet id, or the whole copy-tracker URL (the id is pulled out of it). */
  copy_tracker_sheet_id: string
  tab_display: string
  tab_social: string
  tab_ctv_audio: string
  utm_rules: string
  /** Standing client rules, one per line. */
  rules: string
  notes: string
  /** The client's name(s) in the TapClicks budget feed (ABW), one per line. */
  abw_names: string
  /** TTD advertiser name(s) as Kokai prints them, one per line. */
  ttd_advertiser_names: string
}

export const BLANK_CLIENT_FORM: ClientFormInput = {
  name: '', abbreviation: '', active: true, tier: '', designer_name: '', designer_email: '',
  adpiler_campaign_code: '', fb_page_logo_url: '', brand_website_url: '', brand_notes: '', utm_config: '',
  ttd_advertiser_id: '', fb_ad_account_id: '', fb_page_id: '', fb_pixel_id: '', ig_account: '',
  copy_tracker_sheet_id: '', tab_display: '', tab_social: '', tab_ctv_audio: '', utm_rules: '', rules: '', notes: '',
  abw_names: '', ttd_advertiser_names: '',
}

/** Columns of `public.clients` this form writes. */
export interface ClientPatch {
  name: string
  abbreviation: string
  active: boolean
  tier: 'T1' | 'T2' | 'T3' | null
  designer_name: string | null
  designer_email: string | null
  adpiler_campaign_code: string | null
  fb_page_logo_url: string | null
  brand_website_url: string | null
  brand_notes: string | null
  utm_config: Record<string, unknown> | null
  /** Legacy single-account column, kept in step in `act_<digits>` form. */
  fb_ad_account_id: string | null
}

/** Columns of `ops.client_accounts` this form writes. */
export interface AccountPatch {
  ttd_advertiser_id: string | null
  /** Digits only, no `act_` (the form most ops rows already use). */
  fb_ad_account_id: string | null
  fb_page_id: string | null
  fb_pixel_id: string | null
  ig_account: string | null
  copy_tracker_sheet_id: string | null
  /** Merge patch: a null value removes that key, keys not listed (geo_log, …) are kept. */
  copy_tracker_tabs: { display: string | null; social: string | null; ctv_audio: string | null }
  utm_rules: string | null
  rules: string[]
  notes: string | null
  /** Read by command-center coverage_check.py to tie ABW + TTD names to this client. */
  abw_names: string[]
  ttd_advertiser_names: string[]
}

export type FieldErrors = Partial<Record<keyof ClientFormInput, string>>

export interface ValidationResult {
  errors: FieldErrors
  client: ClientPatch | null
  account: AccountPatch | null
}

/** Minimal shape of an existing client, for the uniqueness check. */
export interface ExistingClientRef {
  id: string
  name: string
  abbreviation: string | null
}

const TTD_ADVERTISER_RE = /^[a-z0-9]{7}$/
const DIGITS_RE = /^\d{5,20}$/
const GID_RE = /^\d{1,12}$/
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,100}$/
const ABBR_RE = /^[A-Z0-9]{2,8}$/
const IG_RE = /^[A-Za-z0-9._]{1,30}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const blank = (s: string | null | undefined) => (s ?? '').trim() === ''
const orNull = (s: string | null | undefined) => (blank(s) ? null : (s as string).trim())

/** `act_123` / ` 123 ` → `123`; null when blank. Does not validate. */
export function normalizeMetaAccountId(raw: string): string | null {
  const v = orNull(raw)
  return v === null ? null : v.replace(/^act_/i, '').trim()
}

/** Pulls `{ id, gid }` out of a Google Sheets URL, or returns the input as the id. */
export function parseSheetRef(raw: string): { id: string | null; gid: string | null } {
  const v = orNull(raw)
  if (v === null) return { id: null, gid: null }
  const m = v.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)
  if (!m) return { id: v, gid: null }
  const gid = v.match(/[#&?]gid=(\d+)/)
  return { id: m[1], gid: gid ? gid[1] : null }
}

/**
 * One name per line → trimmed, inner spaces collapsed, blanks and case-insensitive duplicates dropped
 * (first spelling wins). Punctuation is kept as typed: the feeds print "BurgerCo's" and "BurgerCos" differently.
 */
export function parseNameList(raw: string | null | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of (raw ?? '').split('\n')) {
    const v = line.trim().replace(/\s+/g, ' ')
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    out.push(v)
  }
  return out
}

const MAX_ALIASES = 20
const MAX_ALIAS_LEN = 120

function nameListError(names: string[]): string | null {
  if (names.length > MAX_ALIASES) return `Keep it to ${MAX_ALIASES} names or fewer.`
  if (names.some((n) => n.length > MAX_ALIAS_LEN)) return `Each name must be under ${MAX_ALIAS_LEN} characters.`
  return null
}

/** Case/space-insensitive key used for the duplicate checks (matches the DB unique indexes). */
export const nameKey = (s: string) => s.trim().toLowerCase()
export const abbrKey = (s: string) => s.trim().toUpperCase()

/**
 * Validate the whole form and build both row payloads. `existing` is every
 * client (active or not); `editingId` is the client being edited, if any.
 * The DB enforces name/abbreviation uniqueness too — this is the friendly copy.
 */
export function validateClientForm(
  input: ClientFormInput,
  existing: ExistingClientRef[],
  editingId: string | null,
): ValidationResult {
  const errors: FieldErrors = {}
  const others = existing.filter((c) => c.id !== editingId)

  const name = (input.name ?? '').trim().replace(/\s+/g, ' ')
  if (!name) errors.name = 'Name is required.'
  else if (name.length > 120) errors.name = 'Keep the name under 120 characters.'
  else if (others.some((c) => nameKey(c.name) === nameKey(name))) errors.name = 'A client with this name already exists (check inactive clients too).'

  const abbreviation = abbrKey(input.abbreviation ?? '')
  if (!abbreviation) errors.abbreviation = 'Abbreviation is required.'
  else if (!ABBR_RE.test(abbreviation)) errors.abbreviation = '2–8 letters or digits, no spaces (e.g. ACME).'
  else if (others.some((c) => c.abbreviation && abbrKey(c.abbreviation) === abbreviation)) errors.abbreviation = 'Another client already uses this abbreviation.'

  const tier = orNull(input.tier)
  if (tier !== null && !['T1', 'T2', 'T3'].includes(tier)) errors.tier = 'Tier must be T1, T2 or T3.'

  const designer_name = orNull(input.designer_name)
  const designer_email = orNull(input.designer_email)?.toLowerCase() ?? null
  if ((designer_name === null) !== (designer_email === null)) errors.designer_email = 'A designer needs both a name and their login email.'
  else if (designer_email !== null && !EMAIL_RE.test(designer_email)) errors.designer_email = 'That email doesn\'t look right.'

  let brand_website_url: string | null = null
  if (!blank(input.brand_website_url)) {
    const candidate = withHttpsScheme(input.brand_website_url.trim())
    try {
      const u = new URL(candidate)
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new Error('bad')
      brand_website_url = candidate
    } catch {
      errors.brand_website_url = 'Enter a website like https://example.com.'
    }
  }

  let fb_page_logo_url: string | null = null
  if (!blank(input.fb_page_logo_url)) {
    try {
      const u = new URL(input.fb_page_logo_url.trim())
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad')
      fb_page_logo_url = input.fb_page_logo_url.trim()
    } catch {
      errors.fb_page_logo_url = 'Logo URL must start with https://.'
    }
  }

  let utm_config: Record<string, unknown> | null = null
  if (!blank(input.utm_config)) {
    try {
      const parsed: unknown = JSON.parse(input.utm_config)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      utm_config = parsed as Record<string, unknown>
    } catch {
      errors.utm_config = 'UTM config must be a JSON object, e.g. {"campaign_presets": ["used"]}, or blank.'
    }
  }

  const ttd = orNull(input.ttd_advertiser_id)?.toLowerCase() ?? null
  if (ttd !== null && !TTD_ADVERTISER_RE.test(ttd)) errors.ttd_advertiser_id = 'TTD advertiser ids are 7 lowercase letters/digits (e.g. 9zzzz9z).'

  const metaAct = normalizeMetaAccountId(input.fb_ad_account_id ?? '')
  if (metaAct !== null && !DIGITS_RE.test(metaAct)) errors.fb_ad_account_id = 'Meta ad account ids are digits (act_ prefix optional).'

  const fb_page_id = orNull(input.fb_page_id)
  if (fb_page_id !== null && !DIGITS_RE.test(fb_page_id)) errors.fb_page_id = 'Facebook Page ids are digits.'

  const fb_pixel_id = orNull(input.fb_pixel_id)
  if (fb_pixel_id !== null && !DIGITS_RE.test(fb_pixel_id)) errors.fb_pixel_id = 'Pixel / dataset ids are digits.'

  const ig_account = orNull(input.ig_account)?.replace(/^@/, '') ?? null
  if (ig_account !== null && !IG_RE.test(ig_account)) errors.ig_account = 'Instagram handle: letters, digits, . and _ only.'

  const sheet = parseSheetRef(input.copy_tracker_sheet_id ?? '')
  if (sheet.id !== null && !SHEET_ID_RE.test(sheet.id)) errors.copy_tracker_sheet_id = 'Paste the copy tracker\'s URL or its sheet id.'

  const tabs = { display: orNull(input.tab_display), social: orNull(input.tab_social), ctv_audio: orNull(input.tab_ctv_audio) }
  for (const [k, field] of [['display', 'tab_display'], ['social', 'tab_social'], ['ctv_audio', 'tab_ctv_audio']] as const) {
    const v = tabs[k]
    if (v !== null && !GID_RE.test(v)) errors[field] = 'Tab ids are the digits after gid= in the tab\'s URL.'
  }

  const rules = (input.rules ?? '').split('\n').map((r) => r.trim()).filter(Boolean)

  const abw_names = parseNameList(input.abw_names)
  const abwErr = nameListError(abw_names)
  if (abwErr) errors.abw_names = abwErr
  const ttd_advertiser_names = parseNameList(input.ttd_advertiser_names)
  const ttdErr = nameListError(ttd_advertiser_names)
  if (ttdErr) errors.ttd_advertiser_names = ttdErr

  if (Object.keys(errors).length > 0) return { errors, client: null, account: null }

  return {
    errors,
    client: {
      name,
      abbreviation,
      active: input.active !== false,
      tier: tier as ClientPatch['tier'],
      designer_name,
      designer_email,
      adpiler_campaign_code: orNull(input.adpiler_campaign_code),
      fb_page_logo_url,
      brand_website_url,
      brand_notes: orNull(input.brand_notes),
      utm_config,
      fb_ad_account_id: metaAct === null ? null : `act_${metaAct}`,
    },
    account: {
      ttd_advertiser_id: ttd,
      fb_ad_account_id: metaAct,
      fb_page_id,
      fb_pixel_id,
      ig_account,
      copy_tracker_sheet_id: sheet.id,
      copy_tracker_tabs: tabs,
      utm_rules: orNull(input.utm_rules),
      rules,
      notes: orNull(input.notes),
      abw_names,
      ttd_advertiser_names,
    },
  }
}

/** A row of `ops.client_accounts` as `public.admin_list_client_accounts()` returns it. */
export interface ClientAccountRow {
  client_id: string
  ttd_advertiser_id: string | null
  fb_ad_account_id: string | null
  fb_page_id: string | null
  fb_pixel_id: string | null
  ig_account: string | null
  copy_tracker_sheet_id: string | null
  copy_tracker_tabs: Record<string, string | number> | null
  utm_rules: string | null
  rules: string[] | null
  notes: string | null
  /** Absent until supabase/add_client_name_aliases.sql has run. */
  abw_names?: string[] | null
  ttd_advertiser_names?: string[] | null
}

/** Pre-fill the form from an existing client + its ops account row (if any). */
export function formFromClient(
  c: Pick<Client,
    'name' | 'abbreviation' | 'active' | 'tier' | 'designer_name' | 'designer_email' | 'adpiler_campaign_code'
    | 'fb_page_logo_url' | 'brand_website_url' | 'brand_notes' | 'utm_config' | 'fb_ad_account_id'>,
  a: ClientAccountRow | null,
): ClientFormInput {
  const tabs = a?.copy_tracker_tabs ?? {}
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  return {
    name: c.name,
    abbreviation: c.abbreviation ?? '',
    active: c.active,
    tier: c.tier ?? '',
    designer_name: c.designer_name ?? '',
    designer_email: c.designer_email ?? '',
    adpiler_campaign_code: c.adpiler_campaign_code ?? '',
    fb_page_logo_url: c.fb_page_logo_url ?? '',
    brand_website_url: c.brand_website_url ?? '',
    brand_notes: c.brand_notes ?? '',
    utm_config: c.utm_config ? JSON.stringify(c.utm_config, null, 2) : '',
    ttd_advertiser_id: a?.ttd_advertiser_id ?? '',
    // ops is the campaign record; fall back to the legacy clients column.
    fb_ad_account_id: normalizeMetaAccountId(a?.fb_ad_account_id ?? c.fb_ad_account_id ?? '') ?? '',
    fb_page_id: a?.fb_page_id ?? '',
    fb_pixel_id: a?.fb_pixel_id ?? '',
    ig_account: a?.ig_account ?? '',
    copy_tracker_sheet_id: a?.copy_tracker_sheet_id ?? '',
    tab_display: s(tabs.display),
    tab_social: s(tabs.social),
    tab_ctv_audio: s(tabs.ctv_audio),
    utm_rules: a?.utm_rules ?? '',
    rules: (a?.rules ?? []).join('\n'),
    notes: a?.notes ?? '',
    abw_names: (a?.abw_names ?? []).join('\n'),
    ttd_advertiser_names: (a?.ttd_advertiser_names ?? []).join('\n'),
  }
}
