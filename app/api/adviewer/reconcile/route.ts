import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { generateAdviewerForCard } from '@/lib/adviewerGenerate'

/**
 * Cron backstop for Adviewer publishing. Link generation is normally triggered
 * client-side when a card is moved into a "Ready for Adviewer" column — but that
 * depends on the user's tab running current code and actually firing the fetch.
 * A stale board tab (old JS bundle), a failed fetch, or a future move path we
 * forget to wire all leave a card sitting in the column with no link.
 *
 * This job finds those stragglers — non-archived cards in any "Ready for Adviewer"
 * column with a null adpiler_preview_url — and runs the same generate logic on
 * them, so any miss self-heals within one cron interval. CRON_SECRET-guarded.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Resolve "Ready for Adviewer" column(s) by title, same match as the client trigger.
  const { data: cols } = await admin
    .from('columns')
    .select('id')
    .ilike('title', '%ready for adviewer%')

  const columnIds = (cols ?? []).map((c: { id: string }) => c.id)
  if (columnIds.length === 0) {
    return NextResponse.json({ processed: 0, results: [], note: 'no Ready for Adviewer column' })
  }

  // Cards parked in those columns with no link yet. Bounded so a backlog can't
  // blow the cron's time budget — the next run picks up any remainder.
  const { data: cards } = await admin
    .from('cards')
    .select('id')
    .in('column_id', columnIds)
    .eq('archived', false)
    .is('adpiler_preview_url', null)
    .limit(50)

  const ids = (cards ?? []).map((c: { id: string }) => c.id)

  const results: { id: string; ok: boolean; error?: string }[] = []
  for (const id of ids) {
    const r = await generateAdviewerForCard(admin, id)
    results.push({ id, ok: r.ok, error: r.ok ? undefined : r.error })
  }

  return NextResponse.json({ processed: results.length, results })
}
