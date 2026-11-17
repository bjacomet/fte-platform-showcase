import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/** Users allowed to access pacing — shared by the /pacing page gate and the /api/pacing/* routes. */
export const PACING_ALLOWED = ['admin@example.com', 'admin2@example.com']

/**
 * Session gate for /api/pacing/* route handlers. The middleware exempts /api/*
 * from the login redirect, so every pacing handler must call this first.
 * Returns a 401/403 response to short-circuit with, or null when authorized.
 */
export async function requirePacingUser(): Promise<NextResponse | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!user.email || !PACING_ALLOWED.includes(user.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

/**
 * Checklist scan results are POSTed by external Claude sessions / scheduled
 * tasks that have no browser session — accept the EXTERNAL_API_KEY bearer
 * token (same key as /api/cards) or fall back to the session gate.
 */
export async function requirePacingUserOrApiKey(req: Request): Promise<NextResponse | null> {
  const apiKey = process.env.EXTERNAL_API_KEY
  if (apiKey && req.headers.get('authorization') === `Bearer ${apiKey}`) return null
  return requirePacingUser()
}
