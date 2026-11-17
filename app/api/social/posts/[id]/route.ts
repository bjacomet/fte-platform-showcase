import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { SocialPostStatus } from '@/types'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const body = await req.json() as {
    caption?: string
    media_urls?: string[]
    scheduled_for?: string
    status?: SocialPostStatus
  }

  const updates: Record<string, unknown> = {}
  if (body.caption !== undefined) updates.caption = body.caption
  if (body.media_urls !== undefined) updates.media_urls = body.media_urls
  if (body.scheduled_for !== undefined) updates.scheduled_for = body.scheduled_for

  if (body.status === 'approved') {
    const { data: existing } = await supabase
      .from('social_posts')
      .select('status')
      .eq('id', id)
      .single()

    if (!existing || existing.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft posts can be approved' }, { status: 400 })
    }

    updates.status = 'approved'
    updates.approved_by = user.id
    updates.approved_at = new Date().toISOString()
  } else if (body.status === 'draft') {
    // Un-approve: only allowed from approved state
    updates.status = 'draft'
    updates.approved_by = null
    updates.approved_at = null
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('social_posts')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Only allow deleting draft posts
  const { data: post } = await supabase
    .from('social_posts')
    .select('status')
    .eq('id', id)
    .single()

  if (post && post.status !== 'draft' && post.status !== 'failed') {
    return NextResponse.json({ error: 'Only draft or failed posts can be deleted' }, { status: 400 })
  }

  const { error } = await supabase.from('social_posts').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
