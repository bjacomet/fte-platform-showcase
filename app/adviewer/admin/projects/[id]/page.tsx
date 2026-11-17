import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import ProjectAdminClient from './ProjectAdminClient'

export const dynamic = 'force-dynamic'

export default async function AdviewerProjectAdminPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Block client accounts from accessing admin
  const { data: clientRow } = await supabase
    .from('adviewer_clients')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()
  if (clientRow) redirect('/adviewer/dashboard')

  // Fetch the project
  const { data: project } = await supabase
    .from('adviewer_projects')
    .select('id, title, description, status, client_id, client:clients(id, name)')
    .eq('id', id)
    .single()

  if (!project) notFound()

  // Cards already in this project
  const { data: projectCards } = await supabase
    .from('adviewer_project_cards')
    .select('id, position, card_id, card:cards(id, title, media_type, client_portal_status)')
    .eq('project_id', id)
    .order('position', { ascending: true })

  // All cards for this client that could be added
  const addedCardIds = (projectCards ?? []).map(
    (pc: { card_id: string }) => pc.card_id
  )

  const { data: availableCards } = await supabase
    .from('cards')
    .select('id, title, media_type, client_portal_status')
    .eq('client_id', project.client_id)
    .eq('archived', false)
    .order('title', { ascending: true })

  // Feedback summary for each card
  const cardIds = (projectCards ?? []).map((pc: { card_id: string }) => pc.card_id)
  const { data: feedback } = await supabase
    .from('adviewer_feedback')
    .select('card_id, decision, created_at')
    .eq('project_id', id)
    .not('decision', 'is', null)

  return (
    <ProjectAdminClient
      project={{
        id: project.id,
        title: project.title,
        description: project.description,
        status: project.status,
        client: Array.isArray(project.client) ? project.client[0] : project.client,
      }}
      projectCards={(projectCards ?? []) as unknown as Array<{
        id: string; position: number; card_id: string
        card: { id: string; title: string; media_type: string | null; client_portal_status: string | null }
      }>}
      availableCards={(availableCards ?? []).filter((c) => !addedCardIds.includes(c.id))}
      addedCardIds={addedCardIds}
      feedback={feedback ?? []}
    />
  )
}
