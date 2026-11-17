import crypto from 'crypto'

const GRAPH_API = 'https://graph.facebook.com/v20.0'

// ─────────────────────────────────────────────────────────────
// Token encryption — AES-256-GCM, server-side only
// Key comes from META_TOKEN_ENCRYPTION_KEY (64-char hex = 32 bytes)
// ─────────────────────────────────────────────────────────────

function encKey(): Buffer {
  const k = process.env.META_TOKEN_ENCRYPTION_KEY
  if (!k) throw new Error('META_TOKEN_ENCRYPTION_KEY not set')
  return Buffer.from(k, 'hex')
}

export function encryptToken(token: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptToken(encrypted: string): string {
  const [ivB64, tagB64, ctB64] = encrypted.split('.')
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encKey(),
    Buffer.from(ivB64, 'base64url')
  )
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

// ─────────────────────────────────────────────────────────────
// OAuth helpers
// ─────────────────────────────────────────────────────────────

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? 'https://your-app.vercel.app'

export function buildOAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    redirect_uri: `${appUrl()}/api/meta/callback`,
    scope: 'ads_management,ads_read',
    response_type: 'code',
    state,
  })
  return `https://www.facebook.com/v20.0/dialog/oauth?${params}`
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID!,
    client_secret: process.env.META_APP_SECRET!,
    redirect_uri: `${appUrl()}/api/meta/callback`,
    code,
  })
  const res = await fetch(`${GRAPH_API}/oauth/access_token?${params}`)
  if (!res.ok) throw new Error(`Meta token exchange failed: ${await res.text()}`)
  const json = await res.json() as { access_token: string }
  return json.access_token
}

export async function getLongLivedToken(shortToken: string): Promise<string> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID!,
    client_secret: process.env.META_APP_SECRET!,
    fb_exchange_token: shortToken,
  })
  const res = await fetch(`${GRAPH_API}/oauth/access_token?${params}`)
  if (!res.ok) throw new Error(`Meta long-lived token exchange failed: ${await res.text()}`)
  const json = await res.json() as { access_token: string }
  return json.access_token
}

export interface MetaPage {
  fb_page_id: string
  page_name: string
  access_token: string
  ig_account_id: string | null
}

interface RawPage {
  id: string
  name: string
  access_token: string
  instagram_business_account?: { id: string }
}

export async function getManagedPages(userToken: string): Promise<MetaPage[]> {
  const params = new URLSearchParams({
    access_token: userToken,
    fields: 'id,name,access_token,instagram_business_account',
  })
  const res = await fetch(`${GRAPH_API}/me/accounts?${params}`)
  if (!res.ok) throw new Error(`Meta pages fetch failed: ${await res.text()}`)
  const json = await res.json() as { data?: RawPage[] }
  return (json.data ?? []).map((p) => ({
    fb_page_id: p.id,
    page_name: p.name,
    access_token: p.access_token,
    ig_account_id: p.instagram_business_account?.id ?? null,
  }))
}

// ─────────────────────────────────────────────────────────────
// Facebook post scheduling — native Facebook scheduler
// Facebook holds and publishes at scheduled_publish_time automatically.
// Constraint: scheduledTime must be 10+ min and ≤6 months in the future.
// For multiple media_urls, only the first is used in this MVP implementation.
// ─────────────────────────────────────────────────────────────

interface MetaApiError {
  error?: { message?: string; code?: number }
}

function throwMetaError(err: MetaApiError, fallback: string): never {
  const meta = err.error ?? {}
  throw Object.assign(new Error(meta.message ?? fallback), {
    code: String(meta.code ?? 'unknown'),
  })
}

export async function schedulePost(
  pageToken: string,
  pageId: string,
  caption: string,
  mediaUrl: string | null,
  scheduledTime: Date
): Promise<string> {
  const unixTime = Math.floor(scheduledTime.getTime() / 1000)

  if (mediaUrl) {
    const res = await fetch(`${GRAPH_API}/${pageId}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: caption,
        url: mediaUrl,
        published: false,
        scheduled_publish_time: unixTime,
        access_token: pageToken,
      }),
    })
    if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Facebook photo post failed')
    const json = await res.json() as { id: string }
    return json.id
  }

  const res = await fetch(`${GRAPH_API}/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: caption,
      published: false,
      scheduled_publish_time: unixTime,
      access_token: pageToken,
    }),
  })
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Facebook text post failed')
  const json = await res.json() as { id: string }
  return json.id
}

// ─────────────────────────────────────────────────────────────
// Instagram post — 2-step: create container → publish
// scheduledTime is optional; if provided uses instagram_scheduled_publish_time
// ─────────────────────────────────────────────────────────────

export async function createIgContainer(
  igToken: string,
  igAccountId: string,
  imageUrl: string,
  caption: string,
  scheduledTime?: Date
): Promise<string> {
  const body: Record<string, string | number> = {
    image_url: imageUrl,
    caption,
    access_token: igToken,
  }
  if (scheduledTime) {
    body.instagram_scheduled_publish_time = Math.floor(scheduledTime.getTime() / 1000)
    body.media_type = 'IMAGE'
  }
  const res = await fetch(`${GRAPH_API}/${igAccountId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Instagram container creation failed')
  const json = await res.json() as { id: string }
  return json.id
}

export async function publishIgContainer(
  igToken: string,
  igAccountId: string,
  containerId: string
): Promise<string> {
  const res = await fetch(`${GRAPH_API}/${igAccountId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: containerId, access_token: igToken }),
  })
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Instagram publish failed')
  const json = await res.json() as { id: string }
  return json.id
}

// ─────────────────────────────────────────────────────────────
// Marketing API — ad creation helpers
// All functions expect a user access token with ads_management scope.
// Ad account IDs must include the act_ prefix (normalised by callers).
// ─────────────────────────────────────────────────────────────

/** Ensures the account ID has the required act_ prefix. */
export function normalizeAdAccountId(raw: string): string {
  return raw.startsWith('act_') ? raw : `act_${raw}`
}

/**
 * Upload a video file to the ad account's media library via the
 * three-phase chunked upload protocol. Returns the video_id.
 */
export async function uploadAdVideo(
  adAccountId: string,
  videoBuffer: Buffer,
  filename: string,
  userToken: string
): Promise<string> {
  const fileSize = videoBuffer.length

  // Phase 1: start
  const startParams = new URLSearchParams({
    access_token: userToken,
    upload_phase: 'start',
    file_size: String(fileSize),
    name: filename,
  })
  const startRes = await fetch(`${GRAPH_API}/${adAccountId}/advideos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: startParams.toString(),
  })
  if (!startRes.ok) throwMetaError(await startRes.json() as MetaApiError, 'Video upload start failed')
  const startJson = await startRes.json() as {
    upload_session_id: string
    video_id: string
    start_offset: number
    end_offset: number
  }

  // Phase 2: transfer (single chunk)
  const form = new FormData()
  form.append('access_token', userToken)
  form.append('upload_phase', 'transfer')
  form.append('upload_session_id', startJson.upload_session_id)
  form.append('start_offset', String(startJson.start_offset))
  form.append('end_offset', String(startJson.end_offset))
  form.append('video_file_chunk', new Blob([new Uint8Array(videoBuffer)], { type: 'video/mp4' }), filename)

  const transferRes = await fetch(`${GRAPH_API}/${adAccountId}/advideos`, {
    method: 'POST',
    body: form,
  })
  if (!transferRes.ok) throwMetaError(await transferRes.json() as MetaApiError, 'Video upload transfer failed')

  // Phase 3: finish
  const finishParams = new URLSearchParams({
    access_token: userToken,
    upload_phase: 'finish',
    upload_session_id: startJson.upload_session_id,
  })
  const finishRes = await fetch(`${GRAPH_API}/${adAccountId}/advideos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: finishParams.toString(),
  })
  if (!finishRes.ok) throwMetaError(await finishRes.json() as MetaApiError, 'Video upload finish failed')

  return startJson.video_id
}

/**
 * Upload an image file to the ad account's media library.
 * Returns the image hash used in creative specs.
 */
export async function uploadAdImage(
  adAccountId: string,
  imageBuffer: Buffer,
  filename: string,
  userToken: string
): Promise<string> {
  const form = new FormData()
  form.append('access_token', userToken)
  form.append(filename, new Blob([new Uint8Array(imageBuffer)], { type: 'image/jpeg' }), filename)

  const res = await fetch(`${GRAPH_API}/${adAccountId}/adimages`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Image upload failed')
  const json = await res.json() as { images: Record<string, { hash: string }> }
  const image = Object.values(json.images ?? {})[0]
  if (!image?.hash) throw new Error('Image upload did not return a hash')
  return image.hash
}

/** Create a campaign. Returns the campaign_id. */
export async function createFbCampaign(
  adAccountId: string,
  name: string,
  userToken: string
): Promise<string> {
  const body = new URLSearchParams({
    access_token: userToken,
    name,
    objective: 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: '[]',
  })
  const res = await fetch(`${GRAPH_API}/${adAccountId}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Campaign creation failed')
  const json = await res.json() as { id: string }
  return json.id
}

export interface FbAdSetParams {
  name: string
  campaignId: string
  startDate: string | null
  endDate: string | null
  dailyBudgetCents?: number
}

/** Create an ad set targeting US, ages 18-65. Returns the adset_id. */
export async function createFbAdSet(
  adAccountId: string,
  params: FbAdSetParams,
  userToken: string
): Promise<string> {
  const targeting = {
    geo_locations: { countries: ['US'] },
    age_min: 18,
    age_max: 65,
  }
  const body: Record<string, string> = {
    access_token: userToken,
    name: params.name,
    campaign_id: params.campaignId,
    daily_budget: String(params.dailyBudgetCents ?? 100),
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    status: 'PAUSED',
    targeting: JSON.stringify(targeting),
  }
  if (params.startDate) body.start_time = new Date(params.startDate + 'T00:00:00Z').toISOString()
  if (params.endDate) body.end_time = new Date(params.endDate + 'T23:59:59Z').toISOString()

  const res = await fetch(`${GRAPH_API}/${adAccountId}/adsets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Ad set creation failed')
  const json = await res.json() as { id: string }
  return json.id
}

export interface AssetCustomizationRule {
  customization_spec: {
    publisher_platforms: string[]
    facebook_positions?: string[]
    instagram_positions?: string[]
    messenger_positions?: string[]
  }
  video_label?: { type: 'index'; value: number }
  image_label?: { type: 'index'; value: number }
}

export interface AssetFeedSpec {
  bodies: Array<{ text: string }>
  titles: Array<{ text: string }>
  link_urls: Array<{ website_url: string; display_url: string }>
  call_to_action_types: string[]
  videos?: Array<{ video_id: string }>
  images?: Array<{ hash: string }>
  asset_customization_rules?: AssetCustomizationRule[]
}

export interface FbCreativeParams {
  name: string
  pageId: string
  assetFeedSpec: AssetFeedSpec
}

/** Create an ad creative with placement asset customization. Returns the creative_id. */
export async function createFbAdCreative(
  adAccountId: string,
  params: FbCreativeParams,
  userToken: string
): Promise<string> {
  const body = new URLSearchParams({
    access_token: userToken,
    name: params.name,
    object_story_spec: JSON.stringify({ page_id: params.pageId }),
    asset_feed_spec: JSON.stringify(params.assetFeedSpec),
  })
  const res = await fetch(`${GRAPH_API}/${adAccountId}/adcreatives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Ad creative creation failed')
  const json = await res.json() as { id: string }
  return json.id
}

// ─────────────────────────────────────────────────────────────
// Marketing API — read helpers (campaigns + ad sets)
// ─────────────────────────────────────────────────────────────

export interface FbCampaign {
  id: string
  name: string
  status: string
}

export interface FbAdSet {
  id: string
  name: string
  status: string
}

export async function listFbCampaigns(
  adAccountId: string,
  userToken: string
): Promise<FbCampaign[]> {
  const params = new URLSearchParams({
    access_token: userToken,
    fields: 'id,name,status',
    limit: '100',
  })
  const res = await fetch(`${GRAPH_API}/${adAccountId}/campaigns?${params}`)
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Campaigns fetch failed')
  const json = await res.json() as { data?: FbCampaign[] }
  return json.data ?? []
}

export async function listFbAdSets(
  campaignId: string,
  userToken: string
): Promise<FbAdSet[]> {
  const params = new URLSearchParams({
    access_token: userToken,
    fields: 'id,name,status',
    limit: '100',
  })
  const res = await fetch(`${GRAPH_API}/${campaignId}/adsets?${params}`)
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Ad sets fetch failed')
  const json = await res.json() as { data?: FbAdSet[] }
  return json.data ?? []
}

/** Create a PAUSED ad. Returns the ad_id. */
export async function createFbAd(
  adAccountId: string,
  adSetId: string,
  creativeId: string,
  name: string,
  userToken: string
): Promise<string> {
  const body = new URLSearchParams({
    access_token: userToken,
    name,
    adset_id: adSetId,
    creative: JSON.stringify({ creative_id: creativeId }),
    status: 'PAUSED',
  })
  const res = await fetch(`${GRAPH_API}/${adAccountId}/ads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throwMetaError(await res.json() as MetaApiError, 'Ad creation failed')
  const json = await res.json() as { id: string }
  return json.id
}
