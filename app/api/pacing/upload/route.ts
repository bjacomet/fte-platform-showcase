import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requirePacingUser } from '@/lib/pacingAuth'
import type ExcelJS from 'exceljs'

// ── TTD CSV parser (legacy — kept for backwards compatibility with old CSV uploads) ──
function parseTTDCsv(text: string): Array<{
  advertiser: string; campaign: string; adGroup: string
  spend: number; impressions: number; clicks: number
}> {
  const lines = text.split('\n').filter(Boolean)
  if (lines.length < 2) return []

  // Strip BOM, parse header
  const header = lines[0].replace(/^﻿/, '').split(',').map(h => h.replace(/"/g, '').trim())
  const col = (name: string) => header.indexOf(name)

  const iAdvertiser  = col('Advertiser')
  const iCampaign    = col('Campaign')
  const iAdGroup     = col('Ad Group')
  // Support both old ('Advertiser Cost') and new ('Advertiser Cost (Adv Currency)') column names
  const iSpend       = col('Advertiser Cost (Adv Currency)') !== -1
    ? col('Advertiser Cost (Adv Currency)')
    : col('Advertiser Cost')
  const iImpressions = col('Impressions')
  const iClicks      = col('Clicks')

  return lines.slice(1).map(line => {
    const fields: string[] = []
    let cur = '', inQuote = false
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote }
      else if (ch === ',' && !inQuote) { fields.push(cur); cur = '' }
      else { cur += ch }
    }
    fields.push(cur)

    return {
      advertiser:  fields[iAdvertiser]?.trim()  ?? '',
      campaign:    fields[iCampaign]?.trim()    ?? '',
      adGroup:     fields[iAdGroup]?.trim()     ?? '',
      spend:       parseFloat(fields[iSpend])   || 0,
      impressions: parseInt(fields[iImpressions]) || 0,
      clicks:      parseInt(fields[iClicks])    || 0,
    }
  }).filter(r => r.advertiser)
}

// ── TTD XLSX parser (new scheduled report format — Ad Group Performance tab) ──
async function parseTTDXlsx(buffer: ArrayBuffer): Promise<Array<{
  advertiser: string; campaign: string; adGroup: string
  spend: number; impressions: number; clicks: number
}>> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)

  // Find the 'Ad Group Performance' tab; fall back to first visible sheet
  const ws = wb.getWorksheet('Ad Group Performance') ?? wb.worksheets.find(s => s.state !== 'hidden') ?? wb.worksheets[0]
  if (!ws) return []

  const rawRows: string[][] = []
  ws.eachRow(row => {
    const vals = (row.values as (ExcelJS.CellValue | undefined)[]).slice(1)
    rawRows.push(vals.map(v => {
      if (v === null || v === undefined) return ''
      if (typeof v === 'object' && 'result' in (v as object)) return String((v as { result: unknown }).result ?? '')
      return String(v)
    }))
  })

  if (rawRows.length < 2) return []
  const header = rawRows[0].map(h => h.trim())
  const col = (name: string) => header.indexOf(name)

  const iAdvertiser  = col('Advertiser')
  const iCampaign    = col('Campaign')
  const iAdGroup     = col('Ad Group')
  const iSpend       = col('Advertiser Cost (Adv Currency)') !== -1
    ? col('Advertiser Cost (Adv Currency)')
    : col('Advertiser Cost')
  const iImpressions = col('Impressions')
  const iClicks      = col('Clicks')

  return rawRows.slice(1).map(r => ({
    advertiser:  r[iAdvertiser]?.trim()  ?? '',
    campaign:    r[iCampaign]?.trim()    ?? '',
    adGroup:     r[iAdGroup]?.trim()     ?? '',
    spend:       parseFloat(r[iSpend])   || 0,
    impressions: parseInt(r[iImpressions]) || 0,
    clicks:      parseInt(r[iClicks])    || 0,
  })).filter(r => r.advertiser)
}

// ── Facebook Excel parser (simple CSV fallback too) ───────────────────────────
// TapClicks exports: Account | Campaign | Lifetime Budget | Spend | Impressions | Clicks | CTR
function parseFacebookRows(rows: string[][]): Array<{
  advertiser: string; campaign: string; spend: number; impressions: number; clicks: number
}> {
  if (rows.length < 2) return []
  const header = rows[0].map(h => String(h).trim())
  const col = (name: string) => header.indexOf(name)
  const iAccount     = col('Account')
  const iCampaign    = col('Campaign')
  const iSpend       = col('Spend')
  const iImpressions = col('Impressions')
  const iClicks      = col('Clicks')

  return rows.slice(1).map(r => ({
    advertiser:  String(r[iAccount]  ?? '').trim(),
    campaign:    String(r[iCampaign] ?? '').trim(),
    spend:       parseFloat(String(r[iSpend] ?? '0')) || 0,
    impressions: parseInt(String(r[iImpressions] ?? '0')) || 0,
    clicks:      parseInt(String(r[iClicks] ?? '0')) || 0,
  })).filter(r => r.advertiser)
}

// ── Mapping resolver ──────────────────────────────────────────────────────────
function resolveMapping(
  source: 'ttd' | 'facebook',
  advertiser: string,
  campaign: string,
  mappings: Array<{
    id: string; report_source: string; report_advertiser: string
    report_campaign: string; planned_client: string
    planned_platform: string; planned_campaign_type: string
  }>
): string | null {
  // 1. Try exact advertiser + exact campaign
  const exact = mappings.find(
    m => m.report_source === source &&
         m.report_advertiser.toLowerCase() === advertiser.toLowerCase() &&
         m.report_campaign.toLowerCase() === campaign.toLowerCase()
  )
  if (exact) return exact.id

  // 2. Try exact advertiser + wildcard campaign (report_campaign = '')
  const wild = mappings.find(
    m => m.report_source === source &&
         m.report_advertiser.toLowerCase() === advertiser.toLowerCase() &&
         m.report_campaign === ''
  )
  if (wild) return wild.id

  return null
}

// ── Route handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const denied = await requirePacingUser()
  if (denied) return denied

  try {
    const supabase = createAdminClient()
    const contentType = req.headers.get('content-type') ?? ''

    let source: 'ttd' | 'facebook'
    let month: number
    let year: number
    let userEmail: string
    let rows: Array<{ advertiser: string; campaign: string; adGroup?: string; spend: number; impressions: number; clicks: number }>

    if (contentType.includes('application/json')) {
      // XLSX parsed in the browser — receive pre-extracted rows as JSON
      const body = await req.json() as {
        source: string; month: number; year: number; userEmail?: string
        rows: Array<{ advertiser: string; campaign: string; adGroup?: string; spend: number; impressions: number; clicks: number }>
      }
      source    = body.source as 'ttd' | 'facebook'
      month     = Number(body.month)
      year      = Number(body.year)
      userEmail = body.userEmail ?? ''
      rows      = Array.isArray(body.rows) ? body.rows : []
    } else {
      // FormData with file — CSV (TTD legacy) or server-side XLSX fallback
      const formData  = await req.formData()
      source    = formData.get('source') as 'ttd' | 'facebook'
      month     = parseInt(formData.get('month') as string)
      year      = parseInt(formData.get('year') as string)
      userEmail = (formData.get('userEmail') as string) ?? ''
      const file = formData.get('file') as File

      if (!source || !month || !year || !file) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
      }

      if (source === 'ttd') {
        const isXlsx = file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')
        if (isXlsx) {
          const buffer = await file.arrayBuffer()
          rows = await parseTTDXlsx(buffer)
        } else {
          const text = await file.text()
          rows = parseTTDCsv(text)
        }
      } else {
        const buffer = await file.arrayBuffer()
        const ExcelJS = await import('exceljs')
        const wb = new ExcelJS.Workbook()
        await wb.xlsx.load(buffer)
        const ws = wb.worksheets[0]
        const rawRows: string[][] = []
        ws.eachRow(row => {
          const vals = (row.values as (ExcelJS.CellValue | undefined)[]).slice(1)
          rawRows.push(vals.map(v => {
            if (v === null || v === undefined) return ''
            if (typeof v === 'object' && v !== null && 'result' in v) return String((v as { result: unknown }).result ?? '')
            return String(v)
          }))
        })
        rows = parseFacebookRows(rawRows)
      }
    }

    if (!source || !month || !year) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Load all active mappings
    const { data: mappings } = await supabase
      .from('campaign_mappings')
      .select('id, report_source, report_advertiser, report_campaign, planned_client, planned_platform, planned_campaign_type')
      .eq('active', true)

    const allMappings = mappings ?? []

    if (!rows.length) {
      return NextResponse.json({ error: 'No data rows parsed from file' }, { status: 400 })
    }

    // Aggregate TTD rows by advertiser + campaign (it comes in at ad-group level)
    const aggregated = new Map<string, typeof rows[0]>()
    for (const r of rows) {
      const key = `${r.advertiser}||${r.campaign}`
      const existing = aggregated.get(key)
      if (existing) {
        existing.spend       += r.spend
        existing.impressions += r.impressions
        existing.clicks      += r.clicks
      } else {
        aggregated.set(key, { ...r })
      }
    }
    const dedupedRows = Array.from(aggregated.values())

    const totalSpend       = dedupedRows.reduce((s, r) => s + r.spend, 0)
    const totalImpressions = dedupedRows.reduce((s, r) => s + r.impressions, 0)

    // Create upload record
    const { data: upload, error: uploadErr } = await supabase
      .from('spend_uploads')
      .insert({
        report_source:     source,
        report_month:      month,
        report_year:       year,
        uploaded_by:       userEmail,
        row_count:         dedupedRows.length,
        total_spend:       totalSpend,
        total_impressions: totalImpressions,
      })
      .select('id')
      .single()

    if (uploadErr || !upload) {
      return NextResponse.json({ error: 'Failed to create upload record' }, { status: 500 })
    }

    // Prior uploads for this source/month/year are kept as history. The
    // trg_spend_upload_latest trigger already flipped their is_latest flag to
    // false on the INSERT above, so the dashboard and checklist export (which
    // filter is_latest = true) read only this upload. No delete needed.

    // Build spend_data rows with mapping resolution
    const spendRows = dedupedRows.map(r => ({
      upload_id:         upload.id,
      report_source:     source,
      report_advertiser: r.advertiser,
      report_campaign:   r.campaign,
      report_ad_group:   r.adGroup ?? null,
      spend:             r.spend,
      impressions:       r.impressions,
      clicks:            r.clicks,
      mapping_id:        resolveMapping(source, r.advertiser, r.campaign, allMappings),
    }))

    const { error: insertErr } = await supabase.from('spend_data').insert(spendRows)
    if (insertErr) {
      return NextResponse.json({ error: 'Failed to store spend data' }, { status: 500 })
    }

    const unmappedCount = spendRows.filter(r => !r.mapping_id).length

    return NextResponse.json({
      success: true,
      uploadId: upload.id,
      rowCount: dedupedRows.length,
      totalSpend,
      unmappedCount,
    })
  } catch (err) {
    console.error('Pacing upload error:', err)
    return NextResponse.json({ error: 'Server error processing upload' }, { status: 500 })
  }
}
