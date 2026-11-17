import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { Client, VideoProject, VideoVersion } from '@/types'
import VideosListView from './VideosListView'

export const dynamic = 'force-dynamic'

export default async function VideosPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: clientsData } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true })
  const clients = (clientsData ?? []) as Client[]

  const { data: projectsData } = await supabase
    .from('video_projects')
    .select('*, clients(id, name, abbreviation, fb_page_logo_url)')
    .eq('archived', false)
    .order('updated_at', { ascending: false })
  const projects = (projectsData ?? []) as VideoProject[]

  // Latest version per project (for the thumbnail / last activity line)
  const projectIds = projects.map((p) => p.id)
  const versionsByProject: Record<string, VideoVersion> = {}
  if (projectIds.length > 0) {
    const { data: versionsData } = await supabase
      .from('video_versions')
      .select('*')
      .in('project_id', projectIds)
      .order('version_number', { ascending: false })
    const versions = (versionsData ?? []) as VideoVersion[]
    for (const v of versions) {
      if (!versionsByProject[v.project_id]) {
        versionsByProject[v.project_id] = v
      }
    }
  }

  return (
    <VideosListView
      clients={clients}
      projects={projects}
      latestVersionByProject={versionsByProject}
    />
  )
}
