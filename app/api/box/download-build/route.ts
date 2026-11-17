import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/writers'
import { getBoxToken } from '@/lib/box'
import { generateUtmUrl } from '@/lib/utm'
import { withHttpsScheme } from '@/lib/url'
import { FB_BUILD_MEDIA_TYPES, TTD_BUILD_MEDIA_TYPES } from '@/types'
import archiver from 'archiver'
import { Workbook, type Worksheet } from 'exceljs'
import path from 'path'
import { Readable } from 'stream'
import fs from 'fs'
import type sharp from 'sharp'

// Box downloads happen before the ZIP streams; a big build can take a while.
export const maxDuration = 300

const BOX_API = 'https://api.box.com/2.0'

interface BoxItem {
  id: string
  name: string
  type: 'file' | 'folder'
}

interface BuildCard {
  id: string
  title: string | null
  media_type: string | null
  fb_body_text: string | null
  fb_headline: string | null
  fb_link_description: string | null
  fb_cta: string | null
  landing_page_url: string | null
  utm_channel: string | null
  utm_campaign: string | null
  flight_start_date: string | null
  flight_end_date: string | null
  flight_month: number | null
  creative_name: string | null
  build_link: string | null
  display_build_link: string | null
  box_folder_id: string | null
  client_id: string | null
  ttd_ad_group_ids: string[] | null
  // Many-to-one embed — Supabase returns an object, not an array
  clients: { name: string | null; abbreviation: string | null; utm_config: Record<string, unknown> | null } | null
  // One-to-many embed — array, one per carousel slide
  carousel_slides: {
    position: number
    headline: string | null
    subheadline: string | null
    link_description: string | null
    landing_page_url: string | null
  }[] | null
}

const BUILD_CARD_SELECT =
  'id, title, media_type, fb_body_text, fb_headline, fb_link_description, fb_cta, ' +
  'landing_page_url, utm_channel, utm_campaign, flight_start_date, flight_end_date, ' +
  'flight_month, creative_name, build_link, display_build_link, box_folder_id, client_id, ttd_ad_group_ids, ' +
  'clients(name, abbreviation, utm_config), ' +
  'carousel_slides(position, headline, subheadline, link_description, landing_page_url)'

const FB_TYPES = new Set<string>(FB_BUILD_MEDIA_TYPES)
const TTD_TYPES = new Set<string>(TTD_BUILD_MEDIA_TYPES)

// A Display/Video/Audio card has one build — the display set itself. Its link
// belongs in build_link, but the drawer once labelled that field "(social)" and
// offered a Display Build field on every card type, so some display cards carry
// their only link in display_build_link. Treat that as the card's build.
function effectiveBuildLink(card: BuildCard): string | null {
  return card.build_link
    ?? (TTD_TYPES.has(card.media_type ?? '') ? card.display_build_link : null)
}

// Template tab per TTD media type — keys must mirror TTD_BUILD_MEDIA_TYPES
const TTD_TYPES_SHEET: Record<string, string> = {
  'Display Request': 'Hosted Display',
  'Video Request': 'Hosted Video',
  'Audio Request': 'Hosted Audio',
}

async function listFolder(folderId: string, token: string, sharedLink: string): Promise<BoxItem[]> {
  const res = await fetch(`${BOX_API}/folders/${folderId}/items?limit=1000&fields=id,name,type`, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Empty when walking by folder id (the card's box_folder_id): the platform's own Box token reaches it.
      ...(sharedLink ? { BoxApi: `shared_link=${sharedLink}` } : {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to list folder ${folderId}: ${res.status} ${text}`)
  }
  const json = await res.json() as { entries: BoxItem[] }
  return json.entries
}

async function collectFiles(
  folderId: string,
  token: string,
  sharedLink: string,
  prefix = ''
): Promise<{ path: string; id: string }[]> {
  const items = await listFolder(folderId, token, sharedLink)
  const files: { path: string; id: string }[] = []
  for (const item of items) {
    const itemPath = prefix ? `${prefix}/${item.name}` : item.name
    if (item.type === 'file') {
      files.push({ path: itemPath, id: item.id })
    } else if (item.type === 'folder') {
      const sub = await collectFiles(item.id, token, sharedLink, itemPath)
      files.push(...sub)
    }
  }
  return files
}

// A build link may be shared at the Build folder or directly at a single
// creative file. Resolve either to the list of files the export should pull.
async function resolveSharedFiles(
  sharedLink: string,
  token: string
): Promise<{ name: string; files: { path: string; id: string }[] }> {
  const res = await fetch(`${BOX_API}/shared_items?fields=id,name,type`, {
    headers: {
      Authorization: `Bearer ${token}`,
      BoxApi: `shared_link=${sharedLink}`,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Could not resolve Box shared link: ${res.status} ${text}`)
  }
  const item = await res.json() as BoxItem
  if (item.type === 'file') {
    return { name: item.name.replace(/\.[^.]+$/, ''), files: [{ path: item.name, id: item.id }] }
  }
  return { name: item.name, files: await collectFiles(item.id, token, sharedLink) }
}

// A Build folder id (cards.box_folder_id), with the name the ZIP is named after.
async function getFolderInfo(
  folderId: string,
  token: string
): Promise<{ id: string; name: string }> {
  const res = await fetch(`${BOX_API}/folders/${folderId}?fields=id,name`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Could not read Box folder ${folderId}: ${res.status}`)
  const json = await res.json() as { id: string; name: string }
  return { id: json.id, name: json.name }
}

async function downloadBoxFiles(
  files: { path: string; id: string }[],
  token: string
): Promise<{ fileBuffers: { path: string; buffer: Buffer }[]; downloadErrors: string[] }> {
  const fileBuffers: { path: string; buffer: Buffer }[] = []
  const downloadErrors: string[] = []
  for (const file of files) {
    const dlRes = await fetch(`${BOX_API}/files/${file.id}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
    })
    if (!dlRes.ok) {
      const errText = await dlRes.text()
      downloadErrors.push(`${file.path}: ${dlRes.status} ${errText.slice(0, 200)}`)
      continue
    }
    const arrayBuffer = await dlRes.arrayBuffer()
    fileBuffers.push({ path: file.path, buffer: Buffer.from(arrayBuffer) })
  }
  return { fileBuffers, downloadErrors }
}

// Facebook Ads Manager expects SCREAMING_SNAKE_CASE for CTA values
const FB_CTA_MAP: Record<string, string> = {
  'No Button':     '',
  'Apply Now':     'APPLY_NOW',
  'Book Now':      'BOOK_TRAVEL',
  'Contact Us':    'CONTACT_US',
  'Download':      'DOWNLOAD',
  'Get Directions':'GET_DIRECTIONS',
  'Get Quote':     'GET_QUOTE',
  'Learn More':    'LEARN_MORE',
  'Order Now':     'ORDER_NOW',
  'Request Time':  'REQUEST_TIME',
  'See Menu':      'SEE_MENU',
  'Send Message':  'MESSAGE_PAGE',
  'Shop Now':      'SHOP_NOW',
  'Sign Up':       'SIGN_UP',
  'Subscribe':     'SUBSCRIBE',
  'Watch More':    'WATCH_MORE',
}

// Facebook expects date strings in MM/DD/YYYY H:MM:SS am/pm format
function fbDate(dateStr: string, endOfDay = false): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  const time = endOfDay ? '11:59:00 pm' : '12:00:00 am'
  return `${mm}/${dd}/${yyyy} ${time}`
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

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm'])
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

// Feed (square-family) vs story (tall), classified by ASPECT RATIO — not the
// crude "taller than wide" test. Feed = the sizes the upload sheet references:
// 1:1 (h/w 1.0) and 4:5 portrait (h/w 1.25, the common carousel feed ratio).
// Story = 9:16 (h/w ~1.78), which goes to tall/ for the user's manual upload.
// The h/w >= 1.5 threshold cleanly separates 4:5 feed from 9:16 story. Files
// with no parseable WxH are treated as square (still sheet-referenced; carousel
// pieces also carry a _NN for slide matching). Used for every FB build card —
// single social ads and carousels alike.
function imageShape(filename: string): 'square' | 'tall' {
  const m = filename.match(/(\d{2,5})\s*x\s*(\d{2,5})/i)
  if (!m) return 'square'
  const w = Number(m[1]), h = Number(m[2])
  return w > 0 && h / w >= 1.5 ? 'tall' : 'square'
}

// Classify by the image's ACTUAL pixel dimensions (read from the buffer), not
// the filename — story graphics are often named "…Story.png" / "…9x16.png" or
// sit in a Story/ subfolder, none of which carry a parseable ≥1.5 WxH token, so
// filename parsing alone was misfiling them into images/. Same threshold as
// imageShape (h/w >= 1.5 ⇒ tall). Falls back to the filename heuristic if sharp
// can't read the buffer (unknown format, decode error, native module absent).
async function imageShapeFromBuffer(buffer: Buffer, filename: string): Promise<'square' | 'tall'> {
  try {
    // Dynamic require to avoid edge-runtime issues with the native binary
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharpFn = require('sharp') as typeof sharp
    const { width, height } = await sharpFn(buffer).metadata()
    if (width && height && width > 0) return height / width >= 1.5 ? 'tall' : 'square'
  } catch {
    // fall through to filename heuristic
  }
  return imageShape(filename)
}

// Column names AND ordering mirror the full Ads Manager template schema,
// taken verbatim from a working Adpiler ads export (2026-07-17) whose carousel
// rows import successfully. A hand-picked subset in custom order (the previous
// approach) imported single-image ads fine but Ads Manager silently dropped the
// ad level of carousel rows — campaign + ad set created, no ads, no error — so
// the sheet now carries the complete schema with unused columns left blank.
// Product groups sit between Creative Optimization and Call to Action, with
// Story ID last, exactly as in the template.
const FB_COLUMNS_PRE_PRODUCTS = [
  'Campaign ID', 'Campaign Name', 'Campaign Status', 'Special Ad Categories',
  'Special Ad Category Country', 'Campaign Objective', 'Buying Type',
  'Campaign Spend Limit', 'Campaign Daily Budget', 'Campaign Lifetime Budget',
  'Campaign Bid Strategy', 'Tags', 'Campaign Is Using L3 Schedule',
  'Campaign Start Time', 'Campaign Stop Time',
  'Ad Set ID', 'Ad Set Run Status', 'Ad Set Name', 'Ad Set Time Start', 'Ad Set Time Stop',
  'Ad Set Daily Budget', 'Ad Set Lifetime Budget', 'Link Object ID', 'Link',
  'Application ID', 'Countries', 'Global Regions', 'Excluded Global Regions',
  'Cities', 'Regions', 'Zip', 'Gender', 'Age Min', 'Age Max',
  'Education Status', 'College Start Year', 'College End Year', 'Interested In',
  'Relationship', 'Connections', 'Excluded Connections', 'Friends of Connections',
  'Locales', 'Broad Category Clusters', 'Custom Audiences', 'Excluded Custom Audiences',
  'Location Cluster IDs', 'Excluded Location Cluster IDs',
  'Publisher Platforms', 'Device Platforms', 'Facebook Positions', 'Instagram Positions',
  'Messenger Positions', 'Oculus Positions', 'Audience Network Positions',
  'Optimization Goal', 'Billing Event', 'Bid Amount', 'Ad Set Bid Strategy',
  'Beneficiary (financial ads in Taiwan)', 'Payer (financial ads in Taiwan)',
  'Beneficiary (Taiwan)', 'Payer (Taiwan)',
  'Beneficiary (financial ads in Australia)', 'Payer (financial ads in Australia)',
  'Ad Set Minimum Spend Limit', 'Ad Set Maximum Spend Limit',
  'Large Geo Areas', 'Excluded Large Geo Areas', 'Medium Geo Areas', 'Excluded Medium Geo Areas',
  'Small Geo Areas', 'Excluded Small Geo Areas', 'Metro Areas', 'Excluded Metro Areas',
  'Subcities', 'Excluded Subcities', 'Neighborhoods', 'Excluded Neighborhoods',
  'Subneighborhoods', 'Excluded Subneighborhoods',
  'Ad ID', 'Ad Status', 'Ad Name', 'Title', 'Body', 'Link Description', 'Display Link',
  'Image Hash', 'Creative Type', 'URL Tags', 'Image File Name', 'Video File Name',
  'Creative Optimization',
] as const

const FB_COLUMNS_POST_PRODUCTS = ['Call to Action', 'Story ID'] as const

type FbRow = Record<string, string | number | undefined>

const toSheetRow = (columns: string[], values: FbRow) => columns.map(col => values[col] ?? '')

// Meta caps carousel ads at 10 cards
const MAX_CAROUSEL_PRODUCTS = 10

// Per-card column group for carousel ads. "Product N - Image Hash" carries the
// image FILENAME, matched against the files uploaded during import (verified by
// the working Adpiler export). When any carousel is present, all 10 groups are
// emitted (matching the working export), blank ones unused.
const productColumns = (count: number): string[] => {
  const cols: string[] = []
  for (let n = 1; n <= count; n++) {
    cols.push(`Product ${n} - Link`, `Product ${n} - Name`, `Product ${n} - Description`, `Product ${n} - Image Hash`)
  }
  return cols
}

interface CarouselSlideEntry {
  headline: string
  description: string
  link: string
  imageName: string // '' when no build file matched the slide
}

interface FbSheetEntry {
  card: BuildCard
  // Basenames as they appear in the ZIP's images/ folder — one ad row each
  // (ignored for carousel entries, which write one row from `slides`)
  imageNames: string[]
  clickUrl: string
  slides?: CarouselSlideEntry[]
}

async function buildFacebookSheet(entries: FbSheetEntry[]): Promise<ArrayBuffer | null> {
  if (entries.length === 0) return null

  const hasCarousel = entries.some(e => (e.slides?.length ?? 0) > 0)
  const columns = [
    ...FB_COLUMNS_PRE_PRODUCTS,
    ...productColumns(hasCarousel ? MAX_CAROUSEL_PRODUCTS : 0),
    ...FB_COLUMNS_POST_PRODUCTS,
  ]

  const wb = new Workbook()
  const ws = wb.addWorksheet('Ads Manager Template')
  ws.addRow(columns)

  // One campaign + one ad set spanning every ad: named from the earliest
  // flight month, falling back to the client, then the first ad's name —
  // never blank (Ads Manager rejects rows with no Name and no ID).
  const starts = entries.map(e => e.card.flight_start_date).filter((d): d is string => !!d).sort()
  const ends = entries.map(e => e.card.flight_end_date).filter((d): d is string => !!d).sort()
  const clientName = entries[0].card.clients?.name ?? ''
  const firstAdName = entries[0].card.creative_name ?? entries[0].card.title ?? ''
  const campaignName = flightMonthLabel(starts[0] ?? null) ?? (clientName || firstAdName || 'FTE Campaign')
  const startStr = starts.length > 0 ? fbDate(starts[0]) : ''
  const endStr = ends.length > 0 ? fbDate(ends[ends.length - 1], true) : ''

  for (const { card, imageNames, clickUrl, slides } of entries) {
    const adName = card.creative_name ?? card.title ?? campaignName
    const cta = FB_CTA_MAP[card.fb_cta ?? ''] ?? (card.fb_cta ?? '')

    const base: FbRow = {
      // Campaign — all PAUSED so the import is safe before review
      'Campaign Name': campaignName, 'Campaign Status': 'PAUSED',
      'Campaign Objective': 'Clicks to Website', 'Buying Type': 'AUCTION',
      'Campaign Bid Strategy': 'Highest volume or value',
      'Campaign Start Time': startStr, 'Campaign Stop Time': endStr,
      // Ad Set — a single ad set with all placements; videos ship in the
      // ZIP (videos/ folder) for manual assignment in Ads Manager
      'Ad Set Name': campaignName, 'Ad Set Run Status': 'PAUSED',
      'Ad Set Time Start': startStr, 'Ad Set Time Stop': endStr,
      'Link': clickUrl, 'Countries': 'US', 'Age Min': 18, 'Age Max': 65,
      'Publisher Platforms': 'facebook, instagram, messenger',
      'Facebook Positions': 'feed, right_hand_column, instream_video, marketplace, story, search, biz_disco_feed, facebook_reels, facebook_reels_overlay',
      'Instagram Positions': 'stream, story, reels, explore_home',
      'Messenger Positions': 'story',
      'Device Platforms': 'mobile, desktop',
      'Optimization Goal': 'NONE', 'Billing Event': 'POST_ENGAGEMENT',
      // Ad
      'Ad Status': 'PAUSED', 'Ad Name': adName,
      'Title': card.fb_headline ?? '', 'Body': card.fb_body_text ?? '',
      'Link Description': card.fb_link_description ?? '',
      'Display Link': clickUrl,
      'Creative Type': 'Link Page Post Ad',
      'Call to Action': cta,
    }

    // Carousel: one row per card, slides as Product groups. Creative Type
    // "Standard" + populated Product columns is how Ads Manager round-trips
    // carousels; ad-level Link/Title/Image File Name mirror the first card.
    // Slides with no matched build image are skipped — Meta requires every
    // carousel card to carry an image, and one imageless Product group can
    // invalidate the whole ad row (silently: no error in the import review).
    if (slides && slides.length > 0) {
      const withImages = slides.filter(s => s.imageName !== '')
      const skipped = slides.length - withImages.length
      if (skipped > 0) {
        console.warn(
          `facebook_upload: card "${card.title}" — ${skipped} slide(s) had no matching build image and were omitted from the carousel row`
        )
      }
      const capped = withImages.slice(0, MAX_CAROUSEL_PRODUCTS)
      if (capped.length === 0) {
        ws.addRow(toSheetRow(columns, base))
        continue
      }
      const row: FbRow = {
        ...base,
        'Creative Type': 'Standard',
        'Link': capped[0].link || clickUrl,
        'Display Link': '',
        'Title': card.fb_headline ?? capped[0].headline,
        'Image File Name': capped[0].imageName,
      }
      capped.forEach((slide, i) => {
        const n = i + 1
        row[`Product ${n} - Link`] = slide.link || clickUrl
        row[`Product ${n} - Name`] = slide.headline
        row[`Product ${n} - Description`] = slide.description
        row[`Product ${n} - Image Hash`] = slide.imageName
      })
      ws.addRow(toSheetRow(columns, row))
      continue
    }

    if (imageNames.length === 0) {
      ws.addRow(toSheetRow(columns, base))
      continue
    }
    for (const name of imageNames) {
      // Ads within one ad set need distinct names or the import merges them —
      // when one card carries several creatives, suffix the filename stem
      // (unique within the build folder; a dims token like 1080x1080 isn't)
      const rowAdName = imageNames.length > 1
        ? `${adName} - ${name.replace(/\.[^.]+$/, '')}`
        : adName
      ws.addRow(toSheetRow(columns, { ...base, 'Ad Name': rowAdName, 'Image File Name': name }))
    }
  }

  return wb.xlsx.writeBuffer()
}

type ImgPair = { orig: string; final: string }

// Lays one FB-build card's files into the ZIP and returns the image lists the
// sheet needs. `finalName` maps a Box basename to its ZIP name (identity for
// the single-card GET, dedupe for the bulk POST).
//
// Every image — single social ad OR carousel slide piece — is split by its real
// pixel dimensions into the feed sizes the sheet references (1:1, 4:5) and story
// 9:16. Feed images go to `images/` — the folder name Meta's Ads Manager import
// resolves bundled creative from (a real Ads Manager export uses exactly this
// layout, which is why an Adpiler export round-trips and our old `square/` did
// NOT: the importer couldn't locate carousel Product images outside `images/`,
// so carousel ads imported as empty shells). Story 9:16 sizes go to `tall/` for
// the user's manual placement-customization upload; videos to `videos/`.
// `squareImages` (orig+final basenames) is what the sheet draws from: single-ad
// rows reference them directly, carousel Product spots match by _NN.
async function layoutFbCardFiles(
  archive: archiver.Archiver,
  fileBuffers: { path: string; buffer: Buffer }[],
  finalName: (basename: string) => string
): Promise<{ squareImages: ImgPair[]; allImageNames: string[] }> {
  const squareImages: ImgPair[] = []
  const allImageNames: string[] = []
  for (const { path: filePath, buffer } of fileBuffers) {
    const ext = path.extname(filePath).toLowerCase()
    const base = path.basename(filePath)
    if (VIDEO_EXTS.has(ext)) {
      archive.append(buffer, { name: `videos/${finalName(base)}` })
      continue
    }
    if (IMAGE_EXTS.has(ext)) {
      const fname = finalName(base)
      allImageNames.push(fname)
      const shape = await imageShapeFromBuffer(buffer, base)
      // Feed → images/ (Meta's bundled-creative folder); story → tall/
      const folder = shape === 'square' ? 'images' : 'tall'
      archive.append(buffer, { name: `${folder}/${fname}` })
      if (shape === 'square') squareImages.push({ orig: base, final: fname })
      continue
    }
    archive.append(buffer, { name: finalName(base) })
  }
  return { squareImages, allImageNames }
}

// Build Product-group entries for a carousel card by matching each slide to
// its build file via the trailing _NN filename convention (NN = position + 1,
// the same rule as the Box pull-slides flow). `images` is the card's square
// feed slide graphics (1:1 / 4:5, in images/ — story 9:16 versions live in
// tall/ and are excluded), pairing the original Box basename (which carries the
// _NN) with the final ZIP basename. If no file carries a _NN token, files are
// assigned to slides in name order.
function carouselSlideEntries(
  card: BuildCard,
  images: ImgPair[],
  clickUrl: string
): CarouselSlideEntry[] {
  const slides = [...(card.carousel_slides ?? [])].sort((a, b) => a.position - b.position)
  if (slides.length === 0) return []

  const byNumber = new Map<number, string>()
  for (const img of images) {
    const m = img.orig.match(/_0*(\d+)\.[^.]+$/)
    // First file wins for a given number so the mapping is deterministic
    if (m && !byNumber.has(Number(m[1]))) byNumber.set(Number(m[1]), img.final)
  }
  const fallbackOrder = byNumber.size === 0
    ? [...images].sort((a, b) => a.orig.localeCompare(b.orig)).map(i => i.final)
    : []

  return slides.map((slide, i) => ({
    headline: slide.headline ?? '',
    description: slide.subheadline ?? slide.link_description ?? '',
    link: withUtm(slide.landing_page_url ?? '', card) || clickUrl,
    imageName: byNumber.get(slide.position + 1) ?? fallbackOrder[i] ?? '',
  }))
}

// Primary (sheet-referenced) images for single social ads: non-tall ones; if a
// build is all tall sizes, the tall creative IS the ad, so fall back to everything.
function primaryImageNames(imageArchiveNames: string[]): string[] {
  const primary = imageArchiveNames.filter(n => imageShape(n) === 'square')
  return primary.length > 0 ? primary : imageArchiveNames
}

// De-dupe basenames across cards sharing one ZIP folder: foo.png → foo-2.png
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let i = 2
  while (used.has(`${stem}-${i}${ext}`)) i++
  const result = `${stem}-${i}${ext}`
  used.add(result)
  return result
}

// Only add UTM params if the URL doesn't already have them
function withUtm(rawUrl: string, card: BuildCard): string {
  const baseUrl = withHttpsScheme(rawUrl)
  if (!baseUrl) return ''
  const alreadyHasUtm = (() => {
    try {
      return [...new URL(baseUrl).searchParams.keys()].some(k => k.startsWith('utm_'))
    } catch {
      return baseUrl.includes('utm_')
    }
  })()
  if (alreadyHasUtm) return baseUrl
  return generateUtmUrl({
    baseUrl,
    campaign: card.utm_campaign ?? '',
    channel: card.utm_channel ?? '',
    client: card.clients as Parameters<typeof generateUtmUrl>[0]['client'],
  }) || baseUrl
}

const resolveClickUrl = (card: BuildCard): string => withUtm(card.landing_page_url ?? '', card)

function mapSheetHeaders(ws: Worksheet): Record<string, number> {
  const colMap: Record<string, number> = {}
  ws.getRow(1).eachCell((cell, colNum) => {
    if (cell.value) colMap[cell.value.toString()] = colNum
  })
  return colMap
}

async function loadTtdTemplate(): Promise<Workbook | null> {
  const templatePath = path.join(process.cwd(), 'public', 'templates', 'ttd-template-v38.xlsx')
  if (!fs.existsSync(templatePath)) return null
  const wb = new Workbook()
  await wb.xlsx.readFile(templatePath)
  return wb
}

// Appends one card's rows to a (possibly shared) TTD workbook. `cursors`
// tracks the next free row per tab so a bulk export stacks several cards'
// rows in one sheet — Display/Video/Audio cards land on their own tabs.
// Returns true if any row was written.
function appendTtdRows(
  wb: Workbook,
  card: BuildCard,
  adGroupTextIds: string[],
  fileBuffers: { path: string }[],
  clickUrl: string,
  cursors: Record<string, number>
): boolean {
  // All selected ad group IDs go in one cell, comma+space separated
  const adGroupIdsCell = adGroupTextIds.join(', ')
  let wrote = false
  const nextRow = (tab: string) => {
    const row = cursors[tab] ?? 2
    cursors[tab] = row + 1
    return row
  }

  // Collect creative files (display-relevant types only)
  const DISPLAY_EXTS = new Set(['.gif', '.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'])
  const creativeFiles = fileBuffers.filter(f =>
    DISPLAY_EXTS.has(path.extname(f.path).toLowerCase())
  )

  // HTML5 builds arrive as one .zip per size — TTD logs these on the
  // "Hosted HTML 5" tab, not the media-type tab
  const zipFiles = fileBuffers.filter(f => path.extname(f.path).toLowerCase() === '.zip')

  if (zipFiles.length > 0) {
    const ws = wb.getWorksheet('Hosted HTML 5')
    if (ws) {
      const colMap = mapSheetHeaders(ws)
      for (const file of zipFiles) {
        const row = ws.getRow(nextRow('Hosted HTML 5'))

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const set = (colName: string, value: any) => {
          const col = colMap[colName]
          if (col) row.getCell(col).value = value
        }

        const filename = path.basename(file.path)
        const dims = filename.match(/(\d+)x(\d+)/i)

        set('Name (required)', filename)
        // Template headers really have two spaces before "(required)" here
        if (dims) {
          set('Width  (required)', Number(dims[1]))
          set('Height  (required)', Number(dims[2]))
        }
        set('HTML Asset File Name (required)', filename)
        set('Clickthrough URL (required)', clickUrl)
        set('Use Clickthrough As Default', 'Yes')
        set('Landing Page URLs (required)', clickUrl)
        set('Click Tracking Parameter (required)', 'clickTAG')
        set('Is Securable', 'YES')
        set('Flight Time Zone ID', 'UTC')
        if (adGroupIdsCell) set('Ad Group Ids', adGroupIdsCell)
        // Start at 6am UTC to account for timezone differences; end at 11:59pm
        if (card.flight_start_date) set('Flight Start Date', new Date(card.flight_start_date + 'T06:00:00Z'))
        if (card.flight_end_date) set('Flight End Date', new Date(card.flight_end_date + 'T23:59:00Z'))

        row.commit()
        wrote = true
      }
    }
  }

  // Non-zip creatives go on the media-type tab. The single fallback row only
  // applies when there are no creative files at all — an all-zip HTML5 build
  // must not add a stray near-empty row to the display tab.
  if (creativeFiles.length > 0 || zipFiles.length === 0) {
    const sheetName = TTD_TYPES_SHEET[card.media_type ?? ''] ?? 'Hosted Display'
    const ws = wb.getWorksheet(sheetName)
    if (!ws) return wrote

    const colMap = mapSheetHeaders(ws)
    const filesToWrite = creativeFiles.length > 0 ? creativeFiles : [null]

    for (const file of filesToWrite) {
      const row = ws.getRow(nextRow(sheetName))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const set = (colName: string, value: any) => {
        const col = colMap[colName]
        if (col) row.getCell(col).value = value
      }

      // Use the actual Box filename directly — it already has the right name
      const filename = file ? path.basename(file.path) : (card.creative_name ?? '')

      set('Name (required)', filename)
      set('Asset File Name (required)', filename)
      set('Clickthrough URL (required)', clickUrl)
      set('Landing Page URL (required)', clickUrl)
      set('Flight Time Zone ID', 'UTC')
      if (adGroupIdsCell) set('Ad Group Ids', adGroupIdsCell)
      // Start at 6am UTC to account for timezone differences; end at 11:59pm
      if (card.flight_start_date) set('Flight Start Date', new Date(card.flight_start_date + 'T06:00:00Z'))
      if (card.flight_end_date) set('Flight End Date', new Date(card.flight_end_date + 'T23:59:00Z'))

      row.commit()
      wrote = true
    }
  }

  return wrote
}

// Resolves cards' saved ad-group UUIDs → TTD text IDs in one query,
// preserving each card's selection order.
async function resolveAdGroupTextIds(cards: BuildCard[]): Promise<Map<string, string[]>> {
  const allUuids = [...new Set(cards.flatMap(c => c.ttd_ad_group_ids ?? []))]
  const byUuid = new Map<string, string>()
  if (allUuids.length > 0) {
    const supabase = await createClient()
    const { data: agRows } = await supabase
      .from('ttd_ad_groups')
      .select('id, ttd_ad_group_id')
      .in('id', allUuids)
    for (const r of agRows ?? []) byUuid.set(r.id, r.ttd_ad_group_id)
  }
  const result = new Map<string, string[]>()
  for (const card of cards) {
    result.set(
      card.id,
      (card.ttd_ad_group_ids ?? [])
        .map(uuid => byUuid.get(uuid))
        .filter((id): id is string => !!id)
    )
  }
  return result
}

export async function GET(req: NextRequest) {
  // Checked before anything else, not only when a cardId is sent: every path
  // below spends the platform's shared Box token on a caller-supplied link, and
  // the middleware does not redirect /api/* to login.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sharedLink = req.nextUrl.searchParams.get('sharedLink')
  const cardId = req.nextUrl.searchParams.get('cardId')
  // variant=display downloads a card's DISPLAY build (cards.display_build_link)
  // rather than its social build. The card is still fetched when a cardId is
  // sent, but it is not used to shape the ZIP: a display set
  // pulled from a Social Ad Request card would otherwise be laid out as an FB
  // build and handed a facebook_upload.xlsx, which is the wrong sheet for a
  // set of HTML5 banners. A display download is just the files.
  const variant = req.nextUrl.searchParams.get('variant')
  const displayOnly = variant === 'display'
  // By folder id instead of a shared link — the Atlas "Download all builds" path.
  //   folderId=<id>   the card's Build folder (cards.box_folder_id)
  // Must equal the card's own box_folder_id: a folder id is not a capability the
  // way a shared link is, so the card is what authorizes it.
  const folderIdParam = req.nextUrl.searchParams.get('folderId')
  const byFolder = !!folderIdParam

  if (!sharedLink && !byFolder) {
    return NextResponse.json({ error: 'Missing sharedLink parameter' }, { status: 400 })
  }
  if (byFolder && !cardId) {
    return NextResponse.json({ error: 'folderId requires cardId' }, { status: 400 })
  }

  let card: BuildCard | null = null
  if (cardId) {
    const { data } = await supabase
      .from('cards')
      .select(BUILD_CARD_SELECT)
      .eq('id', cardId)
      .single()

    if (data) card = data as unknown as BuildCard
    // Card UPDATE is open to every signed-in account (client-portal ones too), so
    // the ownership check alone would let anyone point box_folder_id at any folder
    // the platform's Box token can reach. Folder-id downloads are staff-only.
    if (byFolder && !(await isStaffUser())) {
      return NextResponse.json({ error: 'Forbidden — staff access only' }, { status: 403 })
    }
    if (byFolder && (!card || card.box_folder_id?.trim() !== folderIdParam)) {
      return NextResponse.json({ error: 'Folder does not belong to this card' }, { status: 403 })
    }
  }

  let token: string
  try {
    token = await getBoxToken()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Box not connected' },
      { status: 503 }
    )
  }

  // Resolve shared link → folder, collect and download all files
  let folderName: string
  let fileBuffers: { path: string; buffer: Buffer }[]
  try {
    let shared: { name: string; files: { path: string; id: string }[] }
    if (byFolder) {
      const buildFolder = await getFolderInfo(folderIdParam as string, token)
      shared = { name: buildFolder.name, files: await collectFiles(buildFolder.id, token, '') }
    } else {
      shared = await resolveSharedFiles(sharedLink as string, token)
    }
    folderName = shared.name ?? 'build'
    const files = shared.files
    if (files.length === 0) {
      return NextResponse.json({ error: 'No files found in folder' }, { status: 404 })
    }
    const result = await downloadBoxFiles(files, token)
    fileBuffers = result.fileBuffers
    if (fileBuffers.length === 0) {
      return NextResponse.json({
        error: 'Could not download any files from Box',
        details: result.downloadErrors,
      }, { status: 502 })
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read Box folder' },
      { status: 502 }
    )
  }

  // Build ZIP
  const archive = archiver('zip', { zlib: { level: 6 } })

  // Everything below reads sheetCard, not card: on a display download the card
  // exists (for auth) but must not shape the archive.
  // Exception: on a TTD-type card the display build IS the card's build, so it
  // still gets its ttd_upload.xlsx.
  const sheetCard = displayOnly && !TTD_TYPES.has(card?.media_type ?? '') ? null : card
  const isFbBuild = !!sheetCard && FB_TYPES.has(sheetCard.media_type ?? '')
  const isCarousel = sheetCard?.media_type === 'Carousel Ad'
  let squareImages: ImgPair[] = []
  let allImageNames: string[] = []

  if (isFbBuild) {
    // Single-card download keeps the original Box filenames (no cross-card dedupe)
    const layout = await layoutFbCardFiles(archive, fileBuffers, b => b)
    squareImages = layout.squareImages
    allImageNames = layout.allImageNames
  } else {
    for (const { path: filePath, buffer } of fileBuffers) {
      archive.append(buffer, { name: filePath })
    }
  }

  // Append upload sheet if card context was provided
  if (sheetCard) {
    const card = sheetCard
    const mediaType = card.media_type ?? ''
    const clickUrl = resolveClickUrl(card)

    if (FB_TYPES.has(mediaType)) {
      const squareNames = squareImages.map(i => i.final)
      const imageNames = squareNames.length > 0 ? squareNames : primaryImageNames(allImageNames)
      const slides = isCarousel
        ? carouselSlideEntries(card, squareImages, clickUrl)
        : undefined
      const fbBuffer = await buildFacebookSheet([{ card, imageNames, clickUrl, slides }])
      if (fbBuffer) archive.append(Buffer.from(fbBuffer), { name: 'facebook_upload.xlsx' })
    } else if (mediaType in TTD_TYPES_SHEET) {
      const adGroupIds = (await resolveAdGroupTextIds([card])).get(card.id) ?? []
      const wbTtd = await loadTtdTemplate()
      if (wbTtd && appendTtdRows(wbTtd, card, adGroupIds, fileBuffers, clickUrl, {})) {
        const ttdBuffer = await wbTtd.xlsx.writeBuffer()
        archive.append(Buffer.from(ttdBuffer), { name: 'ttd_upload.xlsx' })
      }
    }
  }

  return finalizeZipResponse(archive, `${folderName}.zip`)
}

// Bulk export: several social cards → one ZIP with a single combined
// facebook_upload.xlsx (one campaign + one ad set, one ad per card) and all
// creatives grouped images/ + tall/ for the two Ads Manager upload steps.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let cardIds: string[] = []
  try {
    const body = await req.json() as { cardIds?: unknown }
    if (Array.isArray(body.cardIds)) {
      cardIds = body.cardIds.filter((id): id is string => typeof id === 'string')
    }
  } catch {
    // fall through to the empty-selection error
  }
  if (cardIds.length === 0) {
    return NextResponse.json({ error: 'No cards selected' }, { status: 400 })
  }

  const { data } = await supabase
    .from('cards')
    .select(BUILD_CARD_SELECT)
    .in('id', cardIds)
  const cards = ((data ?? []) as unknown as BuildCard[])
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))

  if (cards.length === 0) {
    return NextResponse.json({ error: 'Cards not found' }, { status: 404 })
  }

  // Validate up front so the export is all-or-nothing — a partial ZIP that
  // silently skipped cards would read as complete
  const problems: string[] = []
  for (const c of cards) {
    const label = c.title ?? c.id
    const mediaType = c.media_type ?? ''
    if (!FB_TYPES.has(mediaType) && !TTD_TYPES.has(mediaType)) {
      problems.push(`"${label}" is ${mediaType || 'untyped'} — only social or display/video/audio card types can be bulk-exported`)
    } else if (!effectiveBuildLink(c)) {
      problems.push(`"${label}" has no Build link`)
    }
  }
  const isTtdExport = cards.some(c => TTD_TYPES.has(c.media_type ?? ''))
  if (isTtdExport && cards.some(c => FB_TYPES.has(c.media_type ?? ''))) {
    problems.push('Selection mixes social and display cards — they use different upload sheets, export them separately')
  }
  if (new Set(cards.map(c => c.client_id ?? '')).size > 1) {
    problems.push('Selected cards span multiple clients — export one client (one ad account) at a time')
  }
  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join('. ') }, { status: 400 })
  }

  let token: string
  try {
    token = await getBoxToken()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Box not connected' },
      { status: 503 }
    )
  }

  const archive = archiver('zip', { zlib: { level: 6 } })
  const usedNames = new Set<string>()

  const fetchCardFiles = async (card: BuildCard) => {
    const link = effectiveBuildLink(card)!
    const { files } = await resolveSharedFiles(link, token)
    return (await downloadBoxFiles(files, token)).fileBuffers
  }
  const cardFetchError = (card: BuildCard, err: unknown) => NextResponse.json({
    error: `"${card.title ?? card.id}": ${err instanceof Error ? err.message : 'failed to read Box folder'}`,
  }, { status: 502 })

  if (isTtdExport) {
    // ── Display/Video/Audio bulk: flat de-duped files + one combined
    // ttd_upload.xlsx. Cards stack rows on their media-type tabs (and the
    // Hosted HTML 5 tab for .zip builds) via the shared row cursors.
    const adGroupIdsByCard = await resolveAdGroupTextIds(cards)
    const wbTtd = await loadTtdTemplate()
    const cursors: Record<string, number> = {}
    let wroteAny = false

    for (const card of cards) {
      let fileBuffers: { path: string; buffer: Buffer }[]
      try {
        fileBuffers = await fetchCardFiles(card)
      } catch (err) {
        return cardFetchError(card, err)
      }

      // TTD trafficking wants a flat file set whose names match the sheet rows
      const finalFiles: { path: string }[] = []
      for (const { path: filePath, buffer } of fileBuffers) {
        const finalName = uniqueName(path.basename(filePath), usedNames)
        archive.append(buffer, { name: finalName })
        finalFiles.push({ path: finalName })
      }

      if (wbTtd) {
        const wrote = appendTtdRows(
          wbTtd, card, adGroupIdsByCard.get(card.id) ?? [], finalFiles,
          resolveClickUrl(card), cursors
        )
        wroteAny = wroteAny || wrote
      }
    }

    if (wbTtd && wroteAny) {
      const ttdBuffer = await wbTtd.xlsx.writeBuffer()
      archive.append(Buffer.from(ttdBuffer), { name: 'ttd_upload.xlsx' })
    }
  } else {
    // ── Facebook bulk: every card's images split into images/ (feed — the sheet
    // references these, incl. carousel slide pieces) and tall/ (story 9:16, for
    // the user's manual upload). One combined facebook_upload.xlsx (one campaign
    // + one ad set, one ad per single card / one carousel row per carousel).
    const sheetEntries: FbSheetEntry[] = []

    for (const card of cards) {
      let fileBuffers: { path: string; buffer: Buffer }[]
      try {
        fileBuffers = await fetchCardFiles(card)
      } catch (err) {
        return cardFetchError(card, err)
      }

      const { squareImages, allImageNames } =
        await layoutFbCardFiles(archive, fileBuffers, b => uniqueName(b, usedNames))

      const clickUrl = resolveClickUrl(card)
      const squareNames = squareImages.map(i => i.final)
      sheetEntries.push({
        card,
        imageNames: squareNames.length > 0 ? squareNames : primaryImageNames(allImageNames),
        clickUrl,
        slides: card.media_type === 'Carousel Ad'
          ? carouselSlideEntries(card, squareImages, clickUrl)
          : undefined,
      })
    }

    const fbBuffer = await buildFacebookSheet(sheetEntries)
    if (fbBuffer) archive.append(Buffer.from(fbBuffer), { name: 'facebook_upload.xlsx' })
  }

  const clientName = cards[0].clients?.name ?? 'client'
  const monthLabel = flightMonthLabel(
    cards.map(c => c.flight_start_date).filter((d): d is string => !!d).sort()[0] ?? null
  )
  const zipName = [clientName, monthLabel, isTtdExport ? 'ttd-build' : 'facebook-build']
    .filter((p): p is string => !!p)
    .join('-')
    .replace(/[^\w.-]+/g, '-')

  return finalizeZipResponse(archive, `${zipName}.zip`)
}

// Streamed, not buffered. Vercel caps a NON-streamed function response at 4.5 MB,
// and an Atlas social build alone is a few MB of MP4 + PNG, so a buffered
// `new NextResponse(Buffer.concat(chunks))` works on localhost (no cap) and fails
// in production. Streaming responses are not subject to that cap; the function
// is bounded by maxDuration instead.
function finalizeZipResponse(archive: archiver.Archiver, filename: string): Response {
  archive.on('warning', err => console.warn('[download-build] zip warning:', err.message))
  archive.on('error', err => console.error('[download-build] zip error:', err.message))

  const body = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>
  // finalize() rejects on a zip error; the 'error' listener above already logged it
  // and toWeb() errors the stream, so swallow it rather than leave it unhandled.
  archive.finalize().catch(() => {})

  return new Response(body, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
