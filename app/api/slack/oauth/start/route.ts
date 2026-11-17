import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Redirects the signed-in user to Slack's OAuth authorization page.
// Scopes:
//   bot scope  : chat:write  — lets the bot DM users in the workspace
//   user scope : identity.basic — lets us read the authorizing user's Slack ID
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clientId = process.env.SLACK_CLIENT_ID
  if (!clientId) {
    return NextResponse.json({ error: 'SLACK_CLIENT_ID not configured' }, { status: 500 })
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/slack/oauth/callback`

  const url = new URL('https://slack.com/oauth/v2/authorize')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('scope', 'chat:write')
  url.searchParams.set('user_scope', 'identity.basic')
  url.searchParams.set('redirect_uri', redirectUri)

  return NextResponse.redirect(url.toString())
}
