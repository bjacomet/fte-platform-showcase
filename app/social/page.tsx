import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import SocialClient from './SocialClient'
import type { SocialPage, SocialPost } from '@/types'

interface SearchParams {
  page_id?: string
  year?: string
  month?: string
}

export default async function SocialSchedulerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const now = new Date()
  const year = parseInt(params.year ?? String(now.getFullYear()))
  const month = parseInt(params.month ?? String(now.getMonth() + 1))

  const { data: pages } = await supabase
    .from('social_pages')
    .select('id, page_name, fb_page_id, ig_account_id, status, connected_at, client_id')
    .eq('status', 'active')
    .order('page_name')

  const activePage = (pages ?? []).find((p) => p.id === params.page_id) ?? pages?.[0] ?? null

  const firstDay = new Date(Date.UTC(year, month - 1, 1)).toISOString()
  const lastDay = new Date(Date.UTC(year, month, 0, 23, 59, 59)).toISOString()

  const { data: posts } = activePage
    ? await supabase
        .from('social_posts')
        .select('*')
        .eq('page_id', activePage.id)
        .gte('scheduled_for', firstDay)
        .lte('scheduled_for', lastDay)
        .order('scheduled_for')
    : { data: [] }

  return (
    <SocialClient
      pages={(pages ?? []) as SocialPage[]}
      posts={(posts ?? []) as SocialPost[]}
      activePage={activePage as SocialPage | null}
      year={year}
      month={month}
    />
  )
}
