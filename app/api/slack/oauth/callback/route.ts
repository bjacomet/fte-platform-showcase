import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Handles the OAuth redirect from Slack after the user authorizes.
// Exchanges the code for tokens, extracts the user's Slack ID + workspace,
// and upserts a row in slack_connections.
// On success, redirects to /settings?slack=connected.
// On failure, redirects to /settings?slack=error.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))

  const code = req.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.redirect(new URL('/settings?slack=error&detail=missing_code', req.url))
  }

  const clientId = process.env.SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/slack/oauth/callback`

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL('/settings?slack=error&detail=misconfigured', req.url))
  }

  // Exchange the code for tokens
  const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })

  const token = await tokenRes.json() as {
    ok: boolean
    error?: string
    authed_user?: { id: string; access_token?: string }
    team?: { id: string; name: string }
    authed_user_profile?: { display_name?: string; real_name?: string }
  }

  if (!token.ok || !token.authed_user?.id || !token.team?.id) {
    const detail = encodeURIComponent(token.error ?? 'unknown')
    return NextResponse.redirect(new URL(`/settings?slack=error&detail=${detail}`, req.url))
  }

  // Fetch the user's Slack profile to get their display name
  let slackUserName: string | null = null
  const userToken = token.authed_user.access_token
  if (userToken) {
    try {
      const profileRes = await fetch('https://slack.com/api/users.identity', {
        headers: { Authorization: `Bearer ${userToken}` },
      })
      const profile = await profileRes.json() as {
        ok: boolean
        user?: { name?: string; real_name?: string }
      }
      if (profile.ok && profile.user) {
        slackUserName = profile.user.real_name ?? profile.user.name ?? null
      }
    } catch {
      // Non-critical — name is display-only
    }
  }

  // Upsert the connection (one row per Supabase user)
  const { error } = await supabase.from('slack_connections').upsert(
    {
      user_id: user.id,
      slack_user_id: token.authed_user.id,
      slack_team_id: token.team.id,
      slack_team_name: token.team.name,
      slack_user_name: slackUserName,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )

  if (error) {
    console.error('slack_connections upsert error:', error)
    return NextResponse.redirect(new URL('/settings?slack=error&detail=db_error', req.url))
  }

  return NextResponse.redirect(new URL('/settings?slack=connected', req.url))
}
