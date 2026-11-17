import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type {
  Card,
  Client,
  VideoApproval,
  VideoComment,
  VideoProject,
  VideoVersion,
} from '@/types'
import VideoProjectView from './VideoProjectView'

export const dynamic = 'force-dynamic'

interface RouteParams {
  id: string
}

export default async function VideoProjectPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: projectData } = await supabase
    .from('video_projects')
    .select('*, clients(id, name, abbreviation, fb_page_logo_url, calendar_share_token)')
    .eq('id', id)
    .maybeSingle()

  if (!projectData) notFound()
  const project = projectData as VideoProject

  const [{ data: versionsData }, { data: commentsData }, { data: approvalsData }, { data: clientsData }] =
    await Promise.all([
      supabase
        .from('video_versions')
        .select('*')
        .eq('project_id', id)
        .order('version_number', { ascending: false }),
      supabase
        .from('video_comments')
        .select('*, video_versions!inner(project_id)')
        .eq('video_versions.project_id', id)
        .order('timestamp_sec', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true }),
      supabase
        .from('video_approvals')
        .select('*, video_versions!inner(project_id)')
        .eq('video_versions.project_id', id),
      supabase.from('clients').select('*').order('name', { ascending: true }),
    ])

  const versions = (versionsData ?? []) as VideoVersion[]
  const comments = (commentsData ?? []) as VideoComment[]
  const approvals = (approvalsData ?? []) as VideoApproval[]
  const clients = (clientsData ?? []) as Client[]

  // Optional: board card (for the "linked card" chip).
  let linkedCard: Card | null = null
  if (project.card_id) {
    const { data: cardData } = await supabase
      .from('cards')
      .select('id, title, approval_status, client_id, media_type')
      .eq('id', project.card_id)
      .maybeSingle()
    linkedCard = (cardData as Card | null) ?? null
  }

  return (
    <VideoProjectView
      project={project}
      versions={versions}
      comments={comments}
      approvals={approvals}
      clients={clients}
      currentUserId={user.id}
      currentUserEmail={user.email ?? null}
      linkedCard={linkedCard}
    />
  )
}
