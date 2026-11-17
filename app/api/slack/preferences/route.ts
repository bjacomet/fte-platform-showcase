import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Updates the current user's notification preferences.
// Body: { watched_columns: string[]; watch_all_clients: boolean; watched_clients: string[] }
export async function PUT(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    watched_columns: string[]
    watch_all_clients: boolean
    watched_clients: string[]
  }

  const { watched_columns, watch_all_clients, watched_clients } = body

  if (!Array.isArray(watched_columns) || typeof watch_all_clients !== 'boolean' || !Array.isArray(watched_clients)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const { error } = await supabase
    .from('slack_connections')
    .update({
      watched_columns,
      watch_all_clients,
      watched_clients,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id)

  if (error) {
    console.error('slack preferences update error:', error)
    return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
