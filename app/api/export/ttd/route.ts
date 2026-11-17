import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getBoxToken, listFolderFiles, downloadFile } from '@/lib/box'
import { generateUtmUrl } from '@/lib/utm'
import path from 'path'
import fs from 'fs'
import archiver from 'archiver'
import { Workbook, type Worksheet } from 'exceljs'
import { Readable } from 'stream'

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// Map our media_type values to TTD sheet tab names
const SHEET_MAP: Record<string, string> = {
  'Display Request': 'Hosted Display',
  'Video Request':   'Hosted Video',
  'Audio Request':   'Hosted Audio',
  'CTV':             'Hosted Video',
}

function formatDate(dateStr: string, endOfDay = false): Date {
  const d = new Date(dateStr + 'T00:00:00Z')
  if (endOfDay) {
    d.setUTCHours(23, 59, 0, 0)
  }
  return d
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()

  // Auth check
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { cardId } = await req.json()
  if (!cardId) return NextResponse.json({ error: 'cardId required' }, { status: 400 })

  // Load card + client + ad group
  const { data: card, error: cardError } = await supabase
    .from('cards')
    .select(`
      *,
      clients(id, name, abbreviation, utm_config),
      ttd_ad_groups(id, ttd_ad_group_id, name)
    `)
    .eq('id', cardId)
    .single()

  if (cardError || !card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 })
  }

  const client = card.clients as { id: string; name: string; abbreviation: string | null; utm_config: Record<string, unknown> | null } | null
  const adGroup = card.ttd_ad_groups as { id: string; ttd_ad_group_id: string; name: string } | null

  const abbreviation = client?.abbreviation ?? client?.name?.slice(0, 4).toUpperCase() ?? 'FTE'
  const month = card.flight_month ?? new Date().getMonth() + 1
  const creativeName = card.creative_name ?? 'Creative'
  const basePrefix = `${abbreviation}-M${month}-${creativeName}`

  // Determine sheet
  const sheetName = SHEET_MAP[card.media_type ?? ''] ?? 'Hosted Display'

  // Generate UTM URL
  const utmUrl = generateUtmUrl({
    baseUrl: card.landing_page_url ?? '',
    campaign: card.utm_campaign ?? '',
    channel: card.utm_channel ?? '',
    client: client as Parameters<typeof generateUtmUrl>[0]['client'],
  })

  // Flight dates
  const startDate = card.flight_start_date ? formatDate(card.flight_start_date) : new Date()
  const endDate = card.flight_end_date ? formatDate(card.flight_end_date, true) : new Date()

  // Box files
  if (!card.box_folder_id) {
    return NextResponse.json({ error: 'No Box folder linked to this card' }, { status: 400 })
  }

  let boxToken: string
  try {
    boxToken = await getBoxToken()
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }

  const boxFiles = await listFolderFiles(card.box_folder_id, boxToken)
  if (boxFiles.length === 0) {
    return NextResponse.json({ error: 'Box folder is empty or inaccessible' }, { status: 400 })
  }

  // Load TTD template
  const templatePath = path.join(process.cwd(), 'public', 'templates', 'ttd-template-v38.xlsx')
  if (!fs.existsSync(templatePath)) {
    return NextResponse.json({ error: 'TTD template not found on server' }, { status: 500 })
  }

  const wb = new Workbook()
  await wb.xlsx.readFile(templatePath)

  const ws = wb.getWorksheet(sheetName)
  if (!ws) {
    return NextResponse.json({ error: `Sheet "${sheetName}" not found in template` }, { status: 500 })
  }

  const mapSheetHeaders = (sheet: Worksheet): Record<string, number> => {
    const map: Record<string, number> = {}
    sheet.getRow(1).eachCell((cell, colNum) => {
      if (cell.value) map[cell.value.toString()] = colNum
    })
    return map
  }

  const colMap = mapSheetHeaders(ws)

  // HTML5 builds (one .zip per size) are logged on the "Hosted HTML 5" tab,
  // not the media-type tab
  const html5Ws = wb.getWorksheet('Hosted HTML 5')
  const html5ColMap = html5Ws ? mapSheetHeaders(html5Ws) : {}

  const clickthroughUrl = utmUrl || card.landing_page_url

  // Write one row per Box file
  let rowIndex = 2
  let html5RowIndex = 2
  for (const file of boxFiles) {
    const sizeMatch = file.name.match(/(\d+x\d+)/i)
    const size = sizeMatch?.[1] ?? ''
    const ext = path.extname(file.name)
    const creativeFull = size ? `${basePrefix}-${size}${ext}` : `${basePrefix}${ext}`
    const isHtml5 = ext.toLowerCase() === '.zip'

    const targetWs = isHtml5 ? html5Ws : ws
    const targetColMap = isHtml5 ? html5ColMap : colMap
    if (!targetWs) continue

    const row = targetWs.getRow(isHtml5 ? html5RowIndex++ : rowIndex++)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const set = (colName: string, value: any) => {
      const col = targetColMap[colName]
      if (col) row.getCell(col).value = value
    }

    if (isHtml5) {
      const dims = size.match(/(\d+)x(\d+)/i)
      set('Name (required)', creativeFull)
      // Template headers really have two spaces before "(required)" here
      if (dims) {
        set('Width  (required)', Number(dims[1]))
        set('Height  (required)', Number(dims[2]))
      }
      set('HTML Asset File Name (required)', creativeFull)
      set('Clickthrough URL (required)', clickthroughUrl)
      set('Use Clickthrough As Default', 'Yes')
      set('Landing Page URLs (required)', clickthroughUrl)
      set('Click Tracking Parameter (required)', 'clickTAG')
      set('Is Securable', 'YES')
      set('Flight Start Date', startDate)
      set('Flight End Date', endDate)
      set('Flight Time Zone ID', 'UTC')
      if (adGroup?.ttd_ad_group_id) set('Ad Group Ids', adGroup.ttd_ad_group_id)
    } else {
      set('Name (required)', creativeFull)
      set('Asset File Name (required)', creativeFull)
      set('Clickthrough URL (required)', clickthroughUrl)
      set('Landing Page URL (required)', clickthroughUrl)
      set('Flight Start Date', startDate)
      set('Flight End Date', endDate)
      set('Flight Time Zone ID', 'UTC')
      if (adGroup?.ttd_ad_group_id) set('Ad Group Ids', adGroup.ttd_ad_group_id)
    }

    row.commit()
  }

  // Write XLSX to buffer
  const xlsxBuffer = await wb.xlsx.writeBuffer()

  // Build ZIP using archiver, stream to response
  const zipFilename = `${basePrefix}.zip`

  // We need to stream the archive — collect it in a buffer for Next.js response
  const archive = archiver('zip', { zlib: { level: 6 } })
  const chunks: Buffer[] = []

  archive.on('data', (chunk: Buffer) => chunks.push(chunk))

  const finishPromise = new Promise<void>((resolve, reject) => {
    archive.on('end', resolve)
    archive.on('error', reject)
  })

  // Append the XLSX
  archive.append(Buffer.from(xlsxBuffer), { name: 'ttd_upload.xlsx' })

  // Append each Box file, renamed to convention
  for (const file of boxFiles) {
    const sizeMatch = file.name.match(/(\d+x\d+)/i)
    const size = sizeMatch?.[1] ?? ''
    const ext = path.extname(file.name)
    const renamedFile = size ? `${basePrefix}-${size}${ext}` : file.name

    const fileRes = await downloadFile(file.id, boxToken)
    if (fileRes.body) {
      const nodeStream = Readable.fromWeb(fileRes.body as Parameters<typeof Readable.fromWeb>[0])
      archive.append(nodeStream, { name: renamedFile })
    }
  }

  archive.finalize()
  await finishPromise

  const zipBuffer = Buffer.concat(chunks)

  return new NextResponse(zipBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipFilename}"`,
      'Content-Length': zipBuffer.length.toString(),
    },
  })
}
