import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/writers'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const errorParam = req.nextUrl.searchParams.get('error')
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://your-app.vercel.app'

  if (errorParam) {
    const desc = req.nextUrl.searchParams.get('error_description') ?? errorParam
    console.error('Box OAuth error:', errorParam, desc)
    return NextResponse.redirect(new URL(`/settings?box=error&detail=${encodeURIComponent(desc)}`, req.url))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/settings?box=error&detail=no_code', req.url))
  }

  const returnedState = req.nextUrl.searchParams.get('state')
  const savedState = req.cookies.get('box_oauth_state')?.value
  if (!savedState || savedState !== returnedState) {
    return NextResponse.redirect(new URL('/settings?box=error&detail=state_mismatch', req.url))
  }

  const supabaseAuth = await createClient()
  const { data: { user } } = await supabaseAuth.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  if (!isAdminEmail(user.email)) return NextResponse.redirect(new URL('/settings?box=error&detail=forbidden', req.url))

  const tokenRes = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.BOX_CLIENT_ID!,
      client_secret: process.env.BOX_CLIENT_SECRET!,
      redirect_uri: `${appUrl}/api/box/callback`,
    }),
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    console.error('Box token exchange failed:', errText)
    return NextResponse.redirect(
      new URL(`/settings?box=error&detail=${encodeURIComponent(errText.slice(0, 200))}`, req.url)
    )
  }

  const json = await tokenRes.json()
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString()

  // Use service-role client so RLS doesn't block writing system tokens
  const supabase = createAdminClient()
  const { error: dbError } = await supabase.from('app_settings').upsert([
    { key: 'box_access_token', value: json.access_token, updated_at: new Date().toISOString() },
    { key: 'box_refresh_token', value: json.refresh_token, updated_at: new Date().toISOString() },
    { key: 'box_token_expires_at', value: expiresAt, updated_at: new Date().toISOString() },
  ])

  if (dbError) {
    console.error('Supabase upsert failed:', dbError)
    return NextResponse.redirect(
      new URL(`/settings?box=error&detail=${encodeURIComponent(dbError.message)}`, req.url)
    )
  }

  const res = NextResponse.redirect(new URL('/settings?box=connected', req.url))
  res.cookies.delete('box_oauth_state')
  return res
}
