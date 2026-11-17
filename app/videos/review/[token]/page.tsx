import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import VideoReviewClient from './VideoReviewClient'

export const dynamic = 'force-dynamic'

interface RouteParams {
  token: string
}

interface RpcShape {
  project: {
    id: string
    title: string
    status: 'in_review' | 'approved' | 'archived'
    created_at: string
    client: { id: string; name: string; fb_page_logo_url: string | null } | null
  }
  versions: Array<{
    id: string
    version_number: number
    box_file_id: string | null
    video_url: string | null
    thumbnail_url: string | null
    duration_sec: number | null
    notes: string | null
    created_at: string
  }>
  comments: Array<{
    id: string
    version_id: string
    author_kind: 'internal' | 'client'
    author_name: string | null
    timestamp_sec: number | null
    body: string
    acknowledged: boolean
    created_at: string
  }>
  approvals: Array<{
    id: string
    version_id: string
    approver_kind: 'internal' | 'client'
    approver_name: string | null
    note: string | null
    created_at: string
  }>
}

export default async function VideoReviewPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { token } = await params
  const supabase = await createClient()

  const { data, error } = await supabase.rpc('get_video_project_by_token', {
    p_token: token,
  })

  if (error || !data) notFound()

  const payload = data as unknown as RpcShape

  return <VideoReviewClient token={token} {...payload} />
}
