import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Removes the current user's Slack connection.
export async function DELETE(): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await supabase
    .from('slack_connections')
    .delete()
    .eq('user_id', user.id)

  if (error) {
    console.error('slack disconnect error:', error)
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
