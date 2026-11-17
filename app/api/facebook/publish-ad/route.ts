import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/writers'
import { getBoxToken } from '@/lib/box'
import {
  decryptToken,
  normalizeAdAccountId,
  uploadAdVideo,
  uploadAdImage,
  createFbCampaign,
  createFbAdSet,
  createFbAdCreative,
  createFbAd,
  type AssetFeedSpec,
  type AssetCustomizationRule,
} from '@/lib/meta'
import path from 'path'

const BOX_API = 'https://api.box.com/2.0'

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm'])
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// Mirror of the mapping in download-build — same SCREAMING_SNAKE_CASE values
// the Marketing API expects for call_to_action_types.
const FB_CTA_MAP: Record<string, string> = {
  'No Button':      '',
  'Apply Now':      'APPLY_NOW',
  'Book Now':       'BOOK_TRAVEL',
  'Contact Us':     'CONTACT_US',
  'Download':       'DOWNLOAD',
  'Get Directions': 'GET_DIRECTIONS',
  'Get Quote':      'GET_QUOTE',
  'Learn More':     'LEARN_MORE',
  'Order Now':      'ORDER_NOW',
  'Request Time':   'REQUEST_TIME',
  'See Menu':       'SEE_MENU',
  'Send Message':   'MESSAGE_PAGE',
  'Shop Now':       'SHOP_NOW',
  'Sign Up':        'SIGN_UP',
  'Subscribe':      'SUBSCRIBE',
  'Watch More':     'WATCH_MORE',
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

function flightMonthLabel(dateStr: string | null): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00Z')
  const num = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${num}-${MONTH_NAMES[d.getUTCMonth()]}`
}

function detectVideoOrientation(filename: string): 'portrait' | 'landscape' {
  const match = filename.match(/(\d{3,4})x(\d{3,4})/i)
  if (match && parseInt(match[2]) > parseInt(match[1])) return 'portrait'
  return 'landscape'
}

interface BoxItem {
  id: string
  name: string
  type: 'file' | 'folder'
}

async function listFolder(folderId: string, token: string, sharedLink: string): Promise<BoxItem[]> {
  const res = await fetch(`${BOX_API}/folders/${folderId}/items?limit=1000&fields=id,name,type`, {
    headers: {
      Authorization: `Bearer ${token}`,
      BoxApi: `shared_link=${sharedLink}`,
    },
  })
  if (!res.ok) throw new Error(`Box folder list failed: ${res.status}`)
  const json = await res.json() as { entries: BoxItem[] }
  return json.entries
}

async function collectFiles(
  folderId: string, token: string, sharedLink: string, prefix = ''
): Promise<{ path: string; id: string }[]> {
  const items = await listFolder(folderId, token, sharedLink)
  const files: { path: string; id: string }[] = []
  for (const item of items) {
    const itemPath = prefix ? `${prefix}/${item.name}` : item.name
    if (item.type === 'file') {
      files.push({ path: itemPath, id: item.id })
    } else if (item.type === 'folder') {
      files.push(...await collectFiles(item.id, token, sharedLink, itemPath))
    }
  }
  return files
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isStaffUser())) return NextResponse.json({ error: 'Forbidden — staff access only' }, { status: 403 })

  const body = await req.json() as {
    cardId?: string
    adAccountId?: string
    existingCampaignId?: string
    existingAdSetId?: string
    dailyBudgetCents?: number
  }
  if (!body.cardId) return NextResponse.json({ error: 'cardId required' }, { status: 400 })
  if (!body.adAccountId) return NextResponse.json({ error: 'adAccountId required' }, { status: 400 })

  const adAccountId = normalizeAdAccountId(body.adAccountId)
  const dailyBudgetCents = typeof body.dailyBudgetCents === 'number' && body.dailyBudgetCents > 0
    ? body.dailyBudgetCents
    : 100

  // ── 1. Fetch card + client
  const { data: card } = await supabase
    .from('cards')
    .select(`
      id, title, creative_name, media_type,
      fb_body_text, fb_headline, fb_link_description, fb_cta, landing_page_url,
      flight_start_date, flight_end_date, build_link, client_id,
      clients (name)
    `)
    .eq('id', body.cardId)
    .single()

  if (!card) return NextResponse.json({ error: 'Card not found' }, { status: 404 })

  const clientRow = Array.isArray(card.clients) ? card.clients[0] : card.clients

  if (!card.build_link) {
    return NextResponse.json({ error: 'No build link on this card' }, { status: 422 })
  }

  // ── 2. Get the ads user token
  const admin = createAdminClient()
  const { data: tokenRow } = await admin
    .from('app_settings')
    .select('value')
    .eq('key', 'meta_ads_user_token_encrypted')
    .single()

  if (!tokenRow?.value) {
    return NextResponse.json({
      error: 'No Meta ads token found. Reconnect Facebook in Settings to grant ads_management permission.',
    }, { status: 422 })
  }
  const userToken = decryptToken(tokenRow.value)

  // ── 3. Get the Facebook page for this client
  const { data: pageRow } = await admin
    .from('social_pages')
    .select('fb_page_id')
    .eq('client_id', card.client_id)
    .eq('status', 'active')
    .limit(1)
    .single()

  if (!pageRow?.fb_page_id) {
    return NextResponse.json({
      error: 'No active Facebook page connected for this client.',
    }, { status: 422 })
  }
  const pageId = pageRow.fb_page_id

  // ── 4. Download files from Box
  let boxToken: string
  try {
    boxToken = await getBoxToken()
  } catch {
    return NextResponse.json({ error: 'Box not connected' }, { status: 503 })
  }

  const sharedLink = card.build_link
  const itemRes = await fetch(`${BOX_API}/shared_items`, {
    headers: {
      Authorization: `Bearer ${boxToken}`,
      BoxApi: `shared_link=${sharedLink}`,
    },
  })
  if (!itemRes.ok) {
    return NextResponse.json({ error: 'Could not resolve Box shared link' }, { status: 502 })
  }
  const itemData = await itemRes.json() as { id: string }

  const fileList = await collectFiles(itemData.id, boxToken, sharedLink)
  const fileBuffers: { path: string; buffer: Buffer }[] = []
  for (const file of fileList) {
    const dlRes = await fetch(`${BOX_API}/files/${file.id}/content`, {
      headers: { Authorization: `Bearer ${boxToken}` },
      redirect: 'follow',
    })
    if (dlRes.ok) {
      fileBuffers.push({ path: file.path, buffer: Buffer.from(await dlRes.arrayBuffer()) })
    }
  }

  if (fileBuffers.length === 0) {
    return NextResponse.json({ error: 'No files found in the build folder' }, { status: 404 })
  }

  const videoFiles = fileBuffers.filter(f => VIDEO_EXTS.has(path.extname(f.path).toLowerCase()))
  const imageFiles = fileBuffers.filter(f => IMAGE_EXTS.has(path.extname(f.path).toLowerCase()))

  // ── 5. Upload media to Facebook
  type VideoEntry = { videoId: string; orientation: 'portrait' | 'landscape' }
  const uploadedVideos: VideoEntry[] = []
  for (const vf of videoFiles) {
    const videoId = await uploadAdVideo(adAccountId, vf.buffer, path.basename(vf.path), userToken)
    uploadedVideos.push({ videoId, orientation: detectVideoOrientation(path.basename(vf.path)) })
  }

  let imageHash: string | null = null
  if (imageFiles.length > 0) {
    imageHash = await uploadAdImage(adAccountId, imageFiles[0].buffer, path.basename(imageFiles[0].path), userToken)
  }

  if (uploadedVideos.length === 0 && !imageHash) {
    return NextResponse.json({ error: 'No supported media files found in the build folder' }, { status: 422 })
  }

  // ── 6. Build the asset_feed_spec
  const campaignName = flightMonthLabel(card.flight_start_date) ?? clientRow?.name ?? card.title ?? 'Campaign'
  const adName = card.creative_name ?? card.title ?? 'Ad'
  const cta = FB_CTA_MAP[card.fb_cta ?? ''] ?? (card.fb_cta ?? 'LEARN_MORE')

  const squareVideos = uploadedVideos.filter(v => v.orientation === 'landscape')
  const portraitVideos = uploadedVideos.filter(v => v.orientation === 'portrait')

  const assetFeedSpec: AssetFeedSpec = {
    bodies: [{ text: card.fb_body_text ?? '' }],
    titles: [{ text: card.fb_headline ?? '' }],
    link_urls: [{
      website_url: card.landing_page_url ?? '',
      display_url: card.landing_page_url ?? '',
    }],
    call_to_action_types: cta ? [cta] : ['LEARN_MORE'],
  }

  const allVideos = [...squareVideos, ...portraitVideos]
  if (allVideos.length > 0) {
    assetFeedSpec.videos = allVideos.map(v => ({ video_id: v.videoId }))
  }
  if (imageHash) {
    assetFeedSpec.images = [{ hash: imageHash }]
  }

  // Build placement customization rules based on what was uploaded
  const rules: AssetCustomizationRule[] = []

  squareVideos.forEach((v, i) => {
    rules.push({
      customization_spec: {
        publisher_platforms: ['facebook', 'instagram'],
        facebook_positions: ['feed', 'instream_video', 'marketplace', 'facebook_reels'],
        instagram_positions: ['stream', 'reels', 'explore_home'],
      },
      video_label: { type: 'index', value: i },
    })
  })

  portraitVideos.forEach((v, i) => {
    rules.push({
      customization_spec: {
        publisher_platforms: ['facebook', 'instagram', 'messenger'],
        facebook_positions: ['story', 'facebook_reels_overlay'],
        instagram_positions: ['story', 'reels'],
        messenger_positions: ['story'],
      },
      video_label: { type: 'index', value: squareVideos.length + i },
    })
  })

  if (imageHash) {
    rules.push({
      customization_spec: {
        publisher_platforms: ['facebook'],
        facebook_positions: ['right_hand_column', 'search'],
      },
      image_label: { type: 'index', value: 0 },
    })
  }

  if (rules.length > 0) {
    assetFeedSpec.asset_customization_rules = rules
  }

  // ── 7. Create the campaign structure (or reuse existing IDs from the modal)
  const campaignId = body.existingCampaignId
    ?? await createFbCampaign(adAccountId, campaignName, userToken)

  const adSetId = body.existingAdSetId
    ?? await createFbAdSet(adAccountId, {
      name: campaignName,
      campaignId,
      startDate: card.flight_start_date,
      endDate: card.flight_end_date,
      dailyBudgetCents,
    }, userToken)

  const creativeId = await createFbAdCreative(adAccountId, {
    name: `${adName} - Creative`,
    pageId,
    assetFeedSpec,
  }, userToken)

  const adId = await createFbAd(adAccountId, adSetId, creativeId, adName, userToken)

  // ── 8. Write FB IDs back to the card
  const now = new Date().toISOString()
  await admin.from('cards').update({
    fb_campaign_id: campaignId,
    fb_ad_id: adId,
    fb_published_at: now,
    updated_at: now,
  }).eq('id', body.cardId)

  await admin.from('card_activity').insert({
    card_id: body.cardId,
    actor: user.email ?? 'staff',
    actor_email: user.email ?? null,
    action: 'published',
    detail: `Published to Facebook Ads (campaign ${campaignId})`,
  })

  return NextResponse.json({
    campaignId,
    adSetId,
    creativeId,
    adId,
    fb_published_at: now,
  })
}
