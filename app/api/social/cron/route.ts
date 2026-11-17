import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { submitSocialPost } from '@/lib/social-submit'

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Recovery: reset posts stuck in 'submitting' for > 15 min back to 'approved'.
  // This handles the case where the server crashed after acquiring the lock.
  await admin
    .from('social_posts')
    .update({ status: 'approved' })
    .eq('status', 'submitting')
    .lte('submitted_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())

  // Facebook: submit approved posts within 25 min of scheduled time.
  // The 25-min window gives Facebook time to accept the post before publish time
  // while respecting the 10-min minimum Facebook enforces on native scheduling.
  const fbWindow = new Date(Date.now() + 25 * 60 * 1000).toISOString()

  // Instagram: submit approved posts within 5 min of scheduled time.
  // Instagram posts < 5 min away are published immediately by submitSocialPost.
  const igWindow = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  const [fbResult, igResult] = await Promise.all([
    admin
      .from('social_posts')
      .select('id')
      .eq('status', 'approved')
      .eq('platform', 'facebook')
      .lte('scheduled_for', fbWindow)
      .limit(25),
    admin
      .from('social_posts')
      .select('id')
      .eq('status', 'approved')
      .eq('platform', 'instagram')
      .lte('scheduled_for', igWindow)
      .limit(25),
  ])

  const postIds = [
    ...(fbResult.data ?? []).map((p: { id: string }) => p.id),
    ...(igResult.data ?? []).map((p: { id: string }) => p.id),
  ]

  const results: { id: string; ok: boolean; error?: string }[] = []
  for (const postId of postIds) {
    const result = await submitSocialPost(postId)
    results.push({ id: postId, ok: result.ok, error: result.error })
  }

  return NextResponse.json({ processed: results.length, results })
}
