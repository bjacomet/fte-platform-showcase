import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildOAuthUrl } from '@/lib/meta'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', process.env.NEXT_PUBLIC_APP_URL ?? 'https://your-app.vercel.app'))

  const state = crypto.randomBytes(16).toString('hex')
  const res = NextResponse.redirect(buildOAuthUrl(state))
  res.cookies.set('meta_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 300 })
  return res
}
