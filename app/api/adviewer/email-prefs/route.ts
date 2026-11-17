import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Per-user opt-in for Adviewer review-submission emails. RLS restricts each user
// to their own row, so this runs on the user-context client (not service role).
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('adviewer_email_prefs')
    .select('notify_on_review')
    .eq('user_id', user.id)
    .maybeSingle()

  return NextResponse.json({ notify_on_review: data?.notify_on_review ?? false })
}

export async function PUT(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { notify_on_review?: boolean }
  if (typeof body.notify_on_review !== 'boolean') {
    return NextResponse.json({ error: 'notify_on_review must be a boolean' }, { status: 400 })
  }

  const { error } = await supabase
    .from('adviewer_email_prefs')
    .upsert({
      user_id: user.id,
      email: user.email ?? '',
      notify_on_review: body.notify_on_review,
      updated_at: new Date().toISOString(),
    })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
