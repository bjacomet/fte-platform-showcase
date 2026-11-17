/**
 * Exports all archived cards to public/data/creative-archive.json.
 * Run: npx tsx scripts/export-creative-archive.ts
 *
 * Runs automatically before next build (see package.json "build" script).
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.
 */

import { createClient } from '@supabase/supabase-js'
import fs from 'fs/promises'
import path from 'path'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: path.join(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

function storagePublicUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/creative-files/${path}`
}

async function main() {
  console.log('🗂  Fetching archived cards...')

  const { data: cards, error: cardsErr } = await supabase
    .from('cards')
    .select(`
      id, title, client_id, media_type, approval_status, description,
      landing_page_url, utm_campaign, utm_channel, preview_image_url,
      flight_start_date, flight_end_date, creative_name,
      source_card_id, run_number, archived, created_at, updated_at,
      clients(id, name, abbreviation, fb_page_logo_url)
    `)
    .eq('archived', true)
    .order('created_at', { ascending: false })

  if (cardsErr) {
    console.error('Error fetching cards:', cardsErr.message)
    process.exit(1)
  }

  const cardIds = (cards ?? []).map((c: (typeof cards)[number]) => c.id)

  if (cardIds.length === 0) {
    await fs.mkdir(path.join(process.cwd(), 'public', 'data'), { recursive: true })
    await fs.writeFile(path.join(process.cwd(), 'public', 'data', 'creative-archive.json'), '[]', 'utf-8')
    console.log('✅  No archived cards — wrote empty archive.')
    return
  }

  const { data: files } = await supabase
    .from('card_files')
    .select('id, card_id, file_name, file_url, file_type, dimensions')
    .in('card_id', cardIds)

  const filesByCard = new Map<string, typeof files>()
  for (const f of files ?? []) {
    if (!filesByCard.has(f.card_id)) filesByCard.set(f.card_id, [])
    filesByCard.get(f.card_id)!.push(f)
  }

  // Build lineage map: rootId → [{ card_id, run_number, flight_start_date, flight_end_date }]
  // Root = card with source_card_id IS NULL (run 1), or the original referenced by source_card_id
  type CardRow = (typeof cards)[number]
  const cardMap = new Map<string, CardRow>()
  for (const c of cards ?? []) cardMap.set(c.id, c)

  function getRootId(card: CardRow): string {
    return card.source_card_id ?? card.id
  }

  const lineageMap = new Map<string, { card_id: string; run_number: number; flight_start_date: string | null; flight_end_date: string | null }[]>()
  for (const c of cards ?? []) {
    const root = getRootId(c)
    if (!lineageMap.has(root)) lineageMap.set(root, [])
    lineageMap.get(root)!.push({
      card_id: c.id,
      run_number: c.run_number ?? 1,
      flight_start_date: c.flight_start_date,
      flight_end_date: c.flight_end_date,
    })
  }
  // Sort each lineage group by run_number
  for (const runs of lineageMap.values()) {
    runs.sort((a, b) => a.run_number - b.run_number)
  }

  const archive = (cards ?? []).map((c: CardRow) => {
    type FileRow = NonNullable<typeof files>[number]
    const cardFiles = (filesByCard.get(c.id) ?? []).map((f: FileRow) => ({
      id: f.id,
      file_name: f.file_name,
      file_url: f.file_url?.startsWith('http') ? f.file_url : storagePublicUrl(f.file_url),
      file_type: f.file_type,
      dimensions: f.dimensions,
    }))

    const client = c.clients as unknown as { id: string; name: string; abbreviation: string | null; fb_page_logo_url: string | null } | null

    const rootId = getRootId(c)
    const lineage = lineageMap.get(rootId) ?? []

    return {
      id: c.id,
      title: c.title,
      client_id: c.client_id,
      client_name: client?.name ?? null,
      client_abbreviation: client?.abbreviation ?? null,
      client_logo_url: client?.fb_page_logo_url ?? null,
      media_type: c.media_type,
      approval_status: c.approval_status,
      description: c.description,
      landing_page_url: c.landing_page_url,
      utm_campaign: c.utm_campaign,
      utm_channel: c.utm_channel,
      preview_image_url: c.preview_image_url,
      flight_start_date: c.flight_start_date,
      flight_end_date: c.flight_end_date,
      creative_name: c.creative_name,
      source_card_id: c.source_card_id,
      run_number: c.run_number ?? 1,
      archived: c.archived,
      is_live: false, // archived cards are never in the Live column
      effective_flight_start: c.flight_start_date,
      effective_flight_end: c.flight_end_date,
      flight_dates_auto: false, // archived cards always have manually-set dates (or none)
      created_at: c.created_at,
      updated_at: c.updated_at,
      files: cardFiles,
      lineage,
    }
  })

  const outDir = path.join(process.cwd(), 'public', 'data')
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(
    path.join(outDir, 'creative-archive.json'),
    JSON.stringify(archive, null, 2),
    'utf-8',
  )

  console.log(`✅  Wrote ${archive.length} entries to public/data/creative-archive.json`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
