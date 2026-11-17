import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLANK_CLIENT_FORM,
  formFromClient,
  normalizeMetaAccountId,
  parseNameList,
  parseSheetRef,
  validateClientForm,
  type ClientFormInput,
} from './clientAdmin'

const EXISTING = [
  { id: 'a', name: "Example Motors", abbreviation: 'EXM' },
  { id: 'b', name: 'Sample Ford', abbreviation: 'SMP' },
  { id: 'c', name: 'Old Client', abbreviation: null },
]

const form = (over: Partial<ClientFormInput>): ClientFormInput => ({ ...BLANK_CLIENT_FORM, name: 'Community Fund', abbreviation: 'cfnd', ...over })

test('a minimal new client validates and normalizes', () => {
  const r = validateClientForm(form({ name: '  Community   Fund ' }), EXISTING, null)
  assert.deepEqual(r.errors, {})
  assert.equal(r.client?.name, 'Community Fund')
  assert.equal(r.client?.abbreviation, 'CFND')
  assert.equal(r.client?.active, true)
  assert.equal(r.client?.tier, null)
  assert.equal(r.account?.ttd_advertiser_id, null)
  assert.deepEqual(r.account?.rules, [])
  assert.deepEqual(r.account?.abw_names, [])
  assert.deepEqual(r.account?.ttd_advertiser_names, [])
  assert.deepEqual(r.account?.copy_tracker_tabs, { display: null, social: null, ctv_audio: null })
})

test('name and abbreviation are required', () => {
  const r = validateClientForm(form({ name: ' ', abbreviation: '' }), EXISTING, null)
  assert.ok(r.errors.name)
  assert.ok(r.errors.abbreviation)
  assert.equal(r.client, null)
  assert.equal(r.account, null)
})

test('duplicate name / abbreviation are caught case-insensitively, but not against the client being edited', () => {
  const dup = validateClientForm(form({ name: "example motors", abbreviation: 'smp' }), EXISTING, null)
  assert.ok(dup.errors.name)
  assert.ok(dup.errors.abbreviation)
  const self = validateClientForm(form({ name: "Example Motors", abbreviation: 'EXM' }), EXISTING, 'a')
  assert.deepEqual(self.errors, {})
})

test('abbreviation format', () => {
  assert.ok(validateClientForm(form({ abbreviation: 'U' }), EXISTING, null).errors.abbreviation)
  assert.ok(validateClientForm(form({ abbreviation: 'U WAY' }), EXISTING, null).errors.abbreviation)
  assert.equal(validateClientForm(form({ abbreviation: 'FTETEST' }), EXISTING, null).errors.abbreviation, undefined)
})

test('TTD advertiser id must be 7 lowercase alphanumerics (input is lowercased first)', () => {
  assert.equal(validateClientForm(form({ ttd_advertiser_id: '9ZZZZ9Z' }), EXISTING, null).account?.ttd_advertiser_id, '9zzzz9z')
  assert.ok(validateClientForm(form({ ttd_advertiser_id: '9zzzz9' }), EXISTING, null).errors.ttd_advertiser_id)
  assert.ok(validateClientForm(form({ ttd_advertiser_id: '9zzzz9z!' }), EXISTING, null).errors.ttd_advertiser_id)
})

test('Meta ad account: act_ optional, digits stored in ops, act_ form on clients', () => {
  const r = validateClientForm(form({ fb_ad_account_id: 'act_1234567890123456' }), EXISTING, null)
  assert.equal(r.account?.fb_ad_account_id, '1234567890123456')
  assert.equal(r.client?.fb_ad_account_id, 'act_1234567890123456')
  assert.ok(validateClientForm(form({ fb_ad_account_id: 'act_12ab' }), EXISTING, null).errors.fb_ad_account_id)
  assert.equal(normalizeMetaAccountId(' ACT_123456 '), '123456')
  assert.equal(normalizeMetaAccountId('  '), null)
})

test('page, pixel and IG handle', () => {
  const r = validateClientForm(form({ fb_page_id: '123456789', fb_pixel_id: '111111111111111', ig_account: '@placeholder7420' }), EXISTING, null)
  assert.equal(r.account?.ig_account, 'placeholder7420')
  assert.ok(validateClientForm(form({ fb_page_id: 'page' }), EXISTING, null).errors.fb_page_id)
  assert.ok(validateClientForm(form({ ig_account: 'has space' }), EXISTING, null).errors.ig_account)
})

test('copy tracker URL is reduced to its id; tab gids must be digits and need a sheet', () => {
  const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=123456789'
  assert.deepEqual(parseSheetRef(url), { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', gid: '123456789' })
  const r = validateClientForm(form({ copy_tracker_sheet_id: url, tab_display: '123456789' }), EXISTING, null)
  assert.equal(r.account?.copy_tracker_sheet_id, '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
  assert.deepEqual(r.account?.copy_tracker_tabs, { display: '123456789', social: null, ctv_audio: null })
  assert.ok(validateClientForm(form({ copy_tracker_sheet_id: url, tab_social: 'abc' }), EXISTING, null).errors.tab_social)
  // Tabs without a sheet id exist in ops today (one row, 2026-11-13); editing must not be blocked by them.
  assert.deepEqual(validateClientForm(form({ tab_display: '1' }), EXISTING, null).errors, {})
})

test('website gets https://; utm_config must be a JSON object', () => {
  const r = validateClientForm(form({ brand_website_url: 'example.org', utm_config: '{"campaign_presets":["used"]}' }), EXISTING, null)
  assert.equal(r.client?.brand_website_url, 'https://example.org')
  assert.deepEqual(r.client?.utm_config, { campaign_presets: ['used'] })
  assert.ok(validateClientForm(form({ brand_website_url: 'not a url' }), EXISTING, null).errors.brand_website_url)
  assert.ok(validateClientForm(form({ utm_config: '[1,2]' }), EXISTING, null).errors.utm_config)
  assert.ok(validateClientForm(form({ utm_config: '{bad' }), EXISTING, null).errors.utm_config)
})

test('designer needs both name and email', () => {
  assert.ok(validateClientForm(form({ designer_name: 'Alex' }), EXISTING, null).errors.designer_email)
  const r = validateClientForm(form({ designer_name: 'Alex', designer_email: 'Alex@Example.com' }), EXISTING, null)
  assert.equal(r.client?.designer_email, 'alex@example.com')
})

test('rules are one per line, blanks dropped', () => {
  const r = validateClientForm(form({ rules: 'No city names\n\n  Cap lookalikes  \n' }), EXISTING, null)
  assert.deepEqual(r.account?.rules, ['No city names', 'Cap lookalikes'])
})

test('ABW / TTD advertiser names: one per line, spaces collapsed, case-insensitive duplicates dropped, punctuation kept', () => {
  assert.deepEqual(parseNameList("BurgerCo's\n  BurgerCos \n\nBURGERCO'S\nExample   Motors of Springfield"), ["BurgerCo's", 'BurgerCos', "Example Motors of Springfield"])
  assert.deepEqual(parseNameList(''), [])
  assert.deepEqual(parseNameList(undefined), [])
  const r = validateClientForm(form({ abw_names: 'Community Fund\n', ttd_advertiser_names: 'Community Fund\nCommunity Fund of Example County' }), EXISTING, null)
  assert.deepEqual(r.account?.abw_names, ['Community Fund'])
  assert.deepEqual(r.account?.ttd_advertiser_names, ['Community Fund', 'Community Fund of Example County'])
})

test('name lists reject runaway input', () => {
  const many = Array.from({ length: 21 }, (_, i) => `Name ${i}`).join('\n')
  assert.ok(validateClientForm(form({ abw_names: many }), EXISTING, null).errors.abw_names)
  assert.ok(validateClientForm(form({ ttd_advertiser_names: 'x'.repeat(121) }), EXISTING, null).errors.ttd_advertiser_names)
})

test('formFromClient round-trips an existing record through validation unchanged', () => {
  const client = {
    name: 'Placeholder Construction', abbreviation: 'PLC', active: true, tier: 'T2' as const,
    designer_name: 'Alex', designer_email: 'alex@example.com', adpiler_campaign_code: null,
    fb_page_logo_url: null, brand_website_url: 'https://placeholder.example', brand_notes: null,
    utm_config: null, fb_ad_account_id: null,
  }
  const acct = {
    client_id: 'x', ttd_advertiser_id: 'abc1234', fb_ad_account_id: '333333333333333', fb_page_id: null,
    fb_pixel_id: '222222222222222', ig_account: 'placeholder7420', copy_tracker_sheet_id: null,
    copy_tracker_tabs: { display: 123456789, geo_log: 987654321 }, utm_rules: null, rules: ['a'], notes: null,
    abw_names: ['Placeholder Construction'], ttd_advertiser_names: ['Placeholder Construction', 'PC Roofing'],
  }
  const f = formFromClient(client, acct)
  assert.equal(f.tab_display, '123456789')
  assert.equal(f.rules, 'a')
  assert.equal(f.ttd_advertiser_names, 'Placeholder Construction\nPC Roofing')
  const ok = validateClientForm(f, [], null)
  assert.deepEqual(ok.errors, {})
  assert.equal(ok.account?.ttd_advertiser_id, 'abc1234')
  assert.equal(ok.account?.copy_tracker_tabs.display, '123456789')
  assert.deepEqual(ok.account?.abw_names, ['Placeholder Construction'])
  assert.deepEqual(ok.account?.ttd_advertiser_names, ['Placeholder Construction', 'PC Roofing'])
})

test('formFromClient tolerates an ops row from before the alias columns existed', () => {
  const f = formFromClient({
    name: 'X', abbreviation: 'XX', active: true, tier: null, designer_name: null, designer_email: null,
    adpiler_campaign_code: null, fb_page_logo_url: null, brand_website_url: null, brand_notes: null,
    utm_config: null, fb_ad_account_id: null,
  }, {
    client_id: 'x', ttd_advertiser_id: null, fb_ad_account_id: null, fb_page_id: null, fb_pixel_id: null,
    ig_account: null, copy_tracker_sheet_id: null, copy_tracker_tabs: null, utm_rules: null, rules: null, notes: null,
  })
  assert.equal(f.abw_names, '')
  assert.equal(f.ttd_advertiser_names, '')
})
