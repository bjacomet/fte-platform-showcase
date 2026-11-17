import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Two-tier write access. Mirrors the DB functions `public.is_writer()` (staff)
 * and `public.is_admin()` (admin) — keep the three in sync. Used by service-role
 * API routes, which bypass RLS and so can't rely on the DB functions themselves.
 *
 *   STAFF  — any authenticated Board user who is NOT an Adviewer client-portal
 *            account. Can do all content work, including everything in Adviewer.
 *   ADMIN  — the two admin accounts + the lead designer. Reserved for platform config:
 *            integration connect/config (Box/Meta/Slack) and the like.
 *
 * Carve-out: card create/edit via Claude (Brenda `/api/chat`, external
 * `/api/cards`) is intentionally NOT gated here. See docs/security.md.
 */
export const ADMIN_EMAILS = [
  'admin@example.com',
  'admin2@example.com',
  'designer@example.com',
]

export function isAdminEmail(email?: string | null): boolean {
  return !!email && ADMIN_EMAILS.includes(email)
}

/**
 * True when there is a logged-in user who is NOT an Adviewer client-portal
 * account (i.e. real FTE staff). Async because it checks `adviewer_clients`.
 */
export async function isStaffUser(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false
  const { data: client } = await supabase
    .from('adviewer_clients')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  return !client
}

/**
 * Guard for JSON API routes that write shared data via the service-role client.
 * Allows any authenticated staff member (not a client-portal account).
 * Returns a 401/403 response to short-circuit with, or null when authorized.
 */
export async function requireWriter(): Promise<NextResponse | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: client } = await supabase
    .from('adviewer_clients')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (client) {
    return NextResponse.json({ error: 'Forbidden — staff access only' }, { status: 403 })
  }
  return null
}

/**
 * Guard for platform-config routes (integration connect/config). Admins only.
 */
export async function requireAdmin(): Promise<NextResponse | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Forbidden — admin access only' }, { status: 403 })
  }
  return null
}
