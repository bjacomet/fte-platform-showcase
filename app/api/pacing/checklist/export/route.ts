import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requirePacingUser } from '@/lib/pacingAuth'
import ExcelJS from 'exceljs'

// POST /api/pacing/checklist/export
// Body: { month: number, year: number }
// Returns: Excel file with Digital + Social tabs matching checklist format
export async function POST(req: NextRequest) {
  const denied = await requirePacingUser()
  if (denied) return denied

  try {
    const { month, year } = await req.json() as { month: number; year: number }
    if (!month || !year) {
      return NextResponse.json({ error: 'month and year required' }, { status: 400 })
    }

    const supabase = createAdminClient()

    // ── Fetch planned budgets for this month ──────────────────────────────────
    const { data: budgets, error: budgetsErr } = await supabase
      .from('planned_budgets')
      .select('*')
      .eq('year', year)
      .eq('month', month)
      .order('client_name')

    if (budgetsErr) throw new Error(budgetsErr.message)

    // ── Fetch spend data for this month (to derive live status) ──────────────
    // Two-step join: spend_data has no month/year — those live on spend_uploads.
    // Only the latest upload per source counts (is_latest = true); older uploads
    // are retained as history but must not be summed (would inflate spend).
    const { data: uploads, error: uploadsErr } = await supabase
      .from('spend_uploads')
      .select('id')
      .eq('report_month', month)
      .eq('report_year', year)
      .eq('is_latest', true)
      .order('created_at', { ascending: false })

    if (uploadsErr) throw new Error(uploadsErr.message)

    const uploadIds = (uploads ?? []).map(u => u.id)

    const { data: spendData, error: spendErr } = uploadIds.length
      ? await supabase
          .from('spend_data')
          .select('*, campaign_mappings(planned_client, planned_platform, planned_campaign_type)')
          .in('upload_id', uploadIds)
      : { data: [] as Array<Record<string, unknown>>, error: null }

    if (spendErr) throw new Error(spendErr.message)

    // Build spend lookup: client||platform||campaign_type → total spend
    const spendByKey = new Map<string, number>()
    for (const row of spendData ?? []) {
      if (!row.campaign_mappings) continue
      const { planned_client, planned_platform, planned_campaign_type } = row.campaign_mappings
      const key = `${planned_client}||${planned_platform}||${planned_campaign_type}`
      spendByKey.set(key, (spendByKey.get(key) ?? 0) + row.spend)
    }

    // ── Fetch creative check results for this month ───────────────────────────
    const { data: creativeResults } = await supabase
      .from('creative_check_results')
      .select('*')
      .eq('check_month', month)
      .eq('check_year', year)

    // Build creative lookup: client||platform → { has_creative, creative_details, last_checked_at }
    const creativeByKey = new Map<string, { has_creative: boolean | null; creative_details: string | null; last_checked_at: string | null }>()
    for (const r of creativeResults ?? []) {
      creativeByKey.set(`${r.client_name}||${r.platform}`, {
        has_creative: r.has_creative,
        creative_details: r.creative_details,
        last_checked_at: r.last_checked_at,
      })
    }

    // ── Separate budgets into Digital (TTD) and Social ────────────────────────
    const digitalBudgets = (budgets ?? []).filter(b => b.platform === 'TTD')
    const socialBudgets  = (budgets ?? []).filter(b => b.platform === 'Social')

    // ── Build workbook ────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook()
    wb.creator = 'FTE Platform'
    wb.created = new Date()

    // ── Style helpers ─────────────────────────────────────────────────────────
    const HEADER_FILL: ExcelJS.Fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003057' },
    }
    const HEADER_FONT: Partial<ExcelJS.Font> = {
      bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri',
    }
    const SUBHEADER_FILL: ExcelJS.Fill = {
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0075A9' },
    }
    const GO_FILL: ExcelJS.Fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF22C55E' } }
    const BLOCK_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEF4444' } }
    const CHECK_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4ADE80' } }
    const WARN_FILL: ExcelJS.Fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBBF24' } }
    const THIN_BORDER: Partial<ExcelJS.Borders> = {
      top:    { style: 'thin', color: { argb: 'FFD1D5DB' } },
      left:   { style: 'thin', color: { argb: 'FFD1D5DB' } },
      bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      right:  { style: 'thin', color: { argb: 'FFD1D5DB' } },
    }
    const DATA_FONT: Partial<ExcelJS.Font> = { size: 10, name: 'Calibri' }

    const MONTH_NAMES = ['','January','February','March','April','May','June',
      'July','August','September','October','November','December']

    function styleHeader(row: ExcelJS.Row) {
      row.eachCell(cell => {
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
        cell.border = THIN_BORDER
      })
      row.height = 30
    }

    function styleSubheader(row: ExcelJS.Row) {
      row.eachCell(cell => {
        cell.fill = SUBHEADER_FILL
        cell.font = { ...HEADER_FONT, bold: false }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
        cell.border = THIN_BORDER
      })
      row.height = 20
    }

    function styleDataRow(row: ExcelJS.Row, isEven: boolean) {
      row.eachCell({ includeEmpty: true }, cell => {
        if (!cell.fill || (cell.fill as ExcelJS.FillPattern).fgColor?.argb === 'FF000000') {
          cell.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: isEven ? 'FFF9FAFB' : 'FFFFFFFF' },
          }
        }
        cell.font = DATA_FONT
        cell.border = THIN_BORDER
        cell.alignment = { vertical: 'middle' }
      })
      row.height = 18
    }

    function checkmark(ws: ExcelJS.Worksheet, rowNum: number, colNum: number, hasCreative: boolean | null) {
      const cell = ws.getCell(rowNum, colNum)
      if (hasCreative === true) {
        cell.value = '✓'
        cell.fill = CHECK_FILL
        cell.font = { ...DATA_FONT, bold: true, color: { argb: 'FF166534' } }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
      } else if (hasCreative === false) {
        cell.value = '✗'
        cell.fill = WARN_FILL
        cell.font = { ...DATA_FONT, bold: true, color: { argb: 'FF92400E' } }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
      }
      // null = not checked → leave blank
    }

    function liveStatus(spend: number | null): string {
      if (spend === null) return ''
      if (spend > 0) return `✓ $${spend.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      return 'Not confirmed'
    }

    // ════════════════════════════════════════════════════════════════════════════
    // DIGITAL TAB
    // ════════════════════════════════════════════════════════════════════════════
    const wsD = wb.addWorksheet('Digital', {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 2 }],
    })

    // Columns — matching exact checklist format
    // Campaign | Flight Date | Impressions | TTD Cost | MG Imps | Projected Cost | POD | Owner | NOTES
    // | Shell Created | Budget Confirmed | Geofencing | Pixel/Attribution | CPA Set Up
    // | Creative Uploaded | Copy Tracker Updated | Ready to Launch | Live Budget Check | Pixel Check #2
    wsD.columns = [
      { key: 'campaign',        width: 30 },
      { key: 'flight_date',     width: 18 },
      { key: 'impressions',     width: 14 },
      { key: 'ttd_cost',        width: 13 },
      { key: 'mg_imps',         width: 10 },
      { key: 'projected_cost',  width: 14 },
      { key: 'pod',             width: 8  },
      { key: 'owner',           width: 10 },
      { key: 'notes',           width: 20 },
      { key: 'shell_created',   width: 14 },
      { key: 'budget_confirmed',width: 16 },
      { key: 'geofencing',      width: 12 },
      { key: 'pixel',           width: 18 },
      { key: 'cpa_setup',       width: 11 },
      { key: 'creative',        width: 17 },
      { key: 'copy_tracker',    width: 18 },
      { key: 'ready',           width: 16 },
      { key: 'live_budget',     width: 18 },
      { key: 'pixel2',          width: 14 },
    ]

    // Row 1: Title
    wsD.mergeCells(1, 1, 1, 19)
    const titleD = wsD.getCell(1, 1)
    titleD.value = `Digital Monthly Checklist — ${MONTH_NAMES[month]} ${year}`
    titleD.font = { bold: true, size: 13, name: 'Calibri', color: { argb: 'FFFFFFFF' } }
    titleD.fill = HEADER_FILL
    titleD.alignment = { horizontal: 'center', vertical: 'middle' }
    wsD.getRow(1).height = 24

    // Row 2: Column headers
    const dHeaders = wsD.addRow([
      'Campaign', 'Flight Date', 'Impressions', 'TTD Cost', 'MG Imps', 'Projected Cost',
      'POD', 'Owner', 'NOTES', 'Shell Created', 'Budget Confirmed', 'Geofencing',
      'Pixel/Attribution', 'CPA Set Up', 'Creative Uploaded', 'Copy Tracker Updated',
      'Ready to Launch', 'Live Budget Check', 'Pixel Check #2',
    ])
    styleHeader(dHeaders)

    // Data rows
    let dDataIdx = 0
    for (const b of digitalBudgets) {
      const spendKey    = `${b.client_name}||${b.platform}||${b.campaign_type}`
      const spend       = spendByKey.get(spendKey) ?? null
      const creativeKey = `${b.client_name}||${b.platform}`
      const creative    = creativeByKey.get(creativeKey)

      const hasCreative = creative?.has_creative ?? null
      const liveSpend   = spend !== undefined ? spend : null

      // GO / BLOCKED: GO if creative ✓ and shell would be filled, BLOCKED if creative missing
      const readyVal = hasCreative === true ? 'GO' : hasCreative === false ? 'BLOCKED' : ''

      const row = wsD.addRow([
        `${b.client_name}${b.campaign_type ? ' ' + b.campaign_type : ''}`,
        '',                                               // Flight Date (manual)
        '',                                               // Impressions (manual)
        b.planned_amount > 0 ? b.planned_amount : '',    // TTD Cost from budget
        '',                                               // MG Imps (manual)
        '',                                               // Projected Cost (manual)
        '',                                               // POD (manual)
        '',                                               // Owner (manual)
        '',                                               // NOTES (manual)
        '',                                               // Shell Created (manual)
        '',                                               // Budget Confirmed (manual)
        '',                                               // Geofencing (manual)
        '',                                               // Pixel/Attribution (manual)
        '',                                               // CPA Set Up (manual)
        '',                                               // Creative Uploaded — set below
        '',                                               // Copy Tracker Updated — set below
        readyVal,                                         // Ready to Launch
        liveStatus(liveSpend),                            // Live Budget Check
        '',                                               // Pixel Check #2 (manual)
      ])

      styleDataRow(row, dDataIdx % 2 === 0)

      // TTD Cost: currency format
      const costCell = row.getCell(4)
      if (b.planned_amount > 0) {
        costCell.numFmt = '$#,##0'
        costCell.alignment = { horizontal: 'right', vertical: 'middle' }
      }

      // Creative Uploaded (col 15)
      checkmark(wsD, row.number, 15, hasCreative)

      // Copy Tracker Updated (col 16) — same signal as creative for now
      checkmark(wsD, row.number, 16, hasCreative)

      // Ready to Launch (col 17) color
      const readyCell = row.getCell(17)
      if (readyVal === 'GO') {
        readyCell.fill = GO_FILL
        readyCell.font = { ...DATA_FONT, bold: true, color: { argb: 'FF166534' } }
        readyCell.alignment = { horizontal: 'center', vertical: 'middle' }
      } else if (readyVal === 'BLOCKED') {
        readyCell.fill = BLOCK_FILL
        readyCell.font = { ...DATA_FONT, bold: true, color: { argb: 'FFFFFFFF' } }
        readyCell.alignment = { horizontal: 'center', vertical: 'middle' }
      }

      // Live Budget Check (col 18) color
      const liveCell = row.getCell(18)
      if (liveSpend !== null && liveSpend > 0) {
        liveCell.fill = CHECK_FILL
        liveCell.font = { ...DATA_FONT, color: { argb: 'FF166534' } }
      } else if (liveSpend !== null && liveSpend === 0) {
        liveCell.fill = WARN_FILL
      }

      dDataIdx++
    }

    if (digitalBudgets.length === 0) {
      const emptyRow = wsD.addRow(['No Digital campaigns loaded for this month.'])
      emptyRow.getCell(1).font = { italic: true, color: { argb: 'FF9CA3AF' }, size: 10, name: 'Calibri' }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // SOCIAL TAB
    // ════════════════════════════════════════════════════════════════════════════
    const wsS = wb.addWorksheet('Social', {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 2 }],
    })

    // Campaign | Platform | Flight Dates | % | Social Spend | Flighted | Make Good | POD | Owner | NOTES
    // | Shell Created | Pixel Check | Spec Inserted | Approval Sent | Creative Uploaded
    // | Mapped in TC? | Ready to Launch | Checked Ad Sets On | Live Flight Dates/Budget
    // | Copy Tracker Updated | Attribution on Ads | Allocated Budget Check
    wsS.columns = [
      { key: 'campaign',        width: 28 },
      { key: 'platform',        width: 12 },
      { key: 'flight_dates',    width: 16 },
      { key: 'social_spend',    width: 13 },
      { key: 'pct',             width: 7  },
      { key: 'flighted',        width: 10 },
      { key: 'make_good',       width: 11 },
      { key: 'pod',             width: 8  },
      { key: 'owner',           width: 10 },
      { key: 'notes',           width: 18 },
      { key: 'shell_created',   width: 13 },
      { key: 'pixel_check',     width: 12 },
      { key: 'spec_inserted',   width: 13 },
      { key: 'approval_sent',   width: 14 },
      { key: 'creative',        width: 17 },
      { key: 'mapped_tc',       width: 12 },
      { key: 'ready',           width: 16 },
      { key: 'ad_sets',         width: 16 },
      { key: 'live_budget',     width: 20 },
      { key: 'copy_tracker',    width: 18 },
      { key: 'attribution',     width: 15 },
      { key: 'budget_check',    width: 18 },
    ]

    // Row 1: Title
    wsS.mergeCells(1, 1, 1, 22)
    const titleS = wsS.getCell(1, 1)
    titleS.value = `Social Monthly Checklist — ${MONTH_NAMES[month]} ${year}`
    titleS.font = { bold: true, size: 13, name: 'Calibri', color: { argb: 'FFFFFFFF' } }
    titleS.fill = HEADER_FILL
    titleS.alignment = { horizontal: 'center', vertical: 'middle' }
    wsS.getRow(1).height = 24

    // Row 2: Column headers
    const sHeaders = wsS.addRow([
      'Campaign', 'Platform', 'Flight Dates', 'Social Spend', '%', 'Flighted', 'Make Good',
      'POD', 'Owner', 'NOTES', 'Shell Created', 'Pixel Check', 'Spec Inserted',
      'Approval Sent', 'Creative Uploaded', 'Mapped in TC?', 'Ready to Launch',
      'Checked Ad Sets On', 'Live Flight Dates/Budget', 'Copy Tracker Updated',
      'Attribution on Ads', 'Allocated Budget Check',
    ])
    styleHeader(sHeaders)

    // Data rows
    let sDataIdx = 0
    for (const b of socialBudgets) {
      const spendKey    = `${b.client_name}||${b.platform}||${b.campaign_type}`
      const spend       = spendByKey.get(spendKey) ?? null
      const creativeKey = `${b.client_name}||${b.platform}`
      const creative    = creativeByKey.get(creativeKey)

      const hasCreative = creative?.has_creative ?? null
      const liveSpend   = spend !== undefined ? spend : null
      const readyVal    = hasCreative === true ? 'GO' : hasCreative === false ? 'BLOCKED' : ''

      const row = wsS.addRow([
        b.client_name,                                    // Campaign (client name)
        b.campaign_type || '',                            // Platform (Meta/TikTok/etc)
        '',                                               // Flight Dates (manual)
        b.planned_amount > 0 ? b.planned_amount : '',    // Social Spend from budget
        '',                                               // % (manual)
        '',                                               // Flighted (manual)
        '',                                               // Make Good (manual)
        '',                                               // POD (manual)
        '',                                               // Owner (manual)
        '',                                               // NOTES (manual)
        '',                                               // Shell Created (manual)
        '',                                               // Pixel Check (manual)
        '',                                               // Spec Inserted (manual)
        '',                                               // Approval Sent (manual)
        '',                                               // Creative Uploaded — set below
        '',                                               // Mapped in TC? (manual)
        readyVal,                                         // Ready to Launch
        '',                                               // Checked Ad Sets On (manual)
        liveStatus(liveSpend),                            // Live Flight Dates/Budget
        '',                                               // Copy Tracker Updated — set below
        '',                                               // Attribution on Ads (manual)
        '',                                               // Allocated Budget Check (manual)
      ])

      styleDataRow(row, sDataIdx % 2 === 0)

      // Social Spend: currency format (col 4)
      const spendCell = row.getCell(4)
      if (b.planned_amount > 0) {
        spendCell.numFmt = '$#,##0'
        spendCell.alignment = { horizontal: 'right', vertical: 'middle' }
      }

      // Creative Uploaded (col 15)
      checkmark(wsS, row.number, 15, hasCreative)

      // Copy Tracker Updated (col 20)
      checkmark(wsS, row.number, 20, hasCreative)

      // Ready to Launch (col 17) color
      const readyCell = row.getCell(17)
      if (readyVal === 'GO') {
        readyCell.fill = GO_FILL
        readyCell.font = { ...DATA_FONT, bold: true, color: { argb: 'FF166534' } }
        readyCell.alignment = { horizontal: 'center', vertical: 'middle' }
      } else if (readyVal === 'BLOCKED') {
        readyCell.fill = BLOCK_FILL
        readyCell.font = { ...DATA_FONT, bold: true, color: { argb: 'FFFFFFFF' } }
        readyCell.alignment = { horizontal: 'center', vertical: 'middle' }
      }

      // Live Flight Dates/Budget (col 19) color
      const liveCell = row.getCell(19)
      if (liveSpend !== null && liveSpend > 0) {
        liveCell.fill = CHECK_FILL
        liveCell.font = { ...DATA_FONT, color: { argb: 'FF166534' } }
      } else if (liveSpend !== null && liveSpend === 0) {
        liveCell.fill = WARN_FILL
      }

      sDataIdx++
    }

    if (socialBudgets.length === 0) {
      const emptyRow = wsS.addRow(['No Social campaigns loaded for this month.'])
      emptyRow.getCell(1).font = { italic: true, color: { argb: 'FF9CA3AF' }, size: 10, name: 'Calibri' }
    }

    // ── Stream back as xlsx ───────────────────────────────────────────────────
    const buffer = await wb.xlsx.writeBuffer()

    const monthLabel = MONTH_NAMES[month]
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="Monthly Checklist ${monthLabel} ${year}.xlsx"`,
      },
    })
  } catch (err) {
    console.error('Checklist export error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Export failed' }, { status: 500 })
  }
}
