import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    page_id: string
    platform: 'facebook' | 'instagram'
    caption?: string
    media_urls?: string[]
    scheduled_for: string
  }

  if (!body.page_id || !body.platform || !body.scheduled_for) {
    return NextResponse.json({ error: 'page_id, platform, and scheduled_for are required' }, { status: 400 })
  }

  const { data: page, error: pageError } = await supabase
    .from('social_pages')
    .select('id, client_id')
    .eq('id', body.page_id)
    .single()

  if (pageError || !page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('social_posts')
    .insert({
      page_id: body.page_id,
      client_id: page.client_id,
      platform: body.platform,
      caption: body.caption ?? null,
      media_urls: body.media_urls ?? [],
      scheduled_for: body.scheduled_for,
      status: 'draft',
      created_by: user.id,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
