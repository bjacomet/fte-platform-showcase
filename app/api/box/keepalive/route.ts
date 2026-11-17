import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getBoxToken } from '@/lib/box'

/**
 * Keeps the Box connection alive (issue #86). Box revokes a refresh token after
 * 60 days without use, and getBoxToken() only refreshes when someone uses a Box
 * feature — so a quiet stretch disconnects Build pulls, the file-sync webhook,
 * Download Build and Atlas creative sync all at once, with nothing on screen until
 * the next person hits an error. A daily forced refresh resets that 60-day clock.
 *
 * Daily rather than weekly so one or two failed runs (a Box outage, a bad deploy)
 * still leave weeks of margin. A failure returns 500 so it shows in Vercel's cron
 * logs; "not connected" returns 200 with ok:false because there is nothing to
 * keep alive and retrying will not help. CRON_SECRET-guarded.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    await getBoxToken({ supabase: createAdminClient(), force: true })
    return NextResponse.json({ ok: true, refreshedAt: new Date().toISOString() })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message.startsWith('Box not connected')) {
      return NextResponse.json({ ok: false, error: message })
    }
    console.error('[box keepalive]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
