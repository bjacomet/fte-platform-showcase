import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://your-app.vercel.app'

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', appUrl))

  const state = crypto.randomBytes(16).toString('hex')
  const params = new URLSearchParams({
    client_id: process.env.BOX_CLIENT_ID!,
    redirect_uri: `${appUrl}/api/box/callback`,
    response_type: 'code',
    state,
  })

  const res = NextResponse.redirect(`https://account.box.com/api/oauth2/authorize?${params.toString()}`)
  res.cookies.set('box_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 300 })
  return res
}
