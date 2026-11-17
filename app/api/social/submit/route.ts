import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { submitSocialPost } from '@/lib/social-submit'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as { postId?: string }
  const { postId } = body
  if (!postId) return NextResponse.json({ error: 'postId required' }, { status: 400 })

  const result = await submitSocialPost(postId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.httpStatus ?? 500 })
  }
  return NextResponse.json(result)
}
