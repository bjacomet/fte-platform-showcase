import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import AdminClient from './AdminClient'

export const dynamic = 'force-dynamic'

export default async function AdviewerAdminPage() {
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

  // Fetch all projects with client info and card counts
  const { data: projects } = await supabase
    .from('adviewer_projects')
    .select(`
      id, title, description, status, created_at, updated_at,
      client:clients(id, name),
      cards:adviewer_project_cards(id)
    `)
    .order('updated_at', { ascending: false })

  // Fetch all clients for the create project form
  const { data: clients } = await supabase
    .from('clients')
    .select('id, name')
    .eq('active', true)
    .order('name', { ascending: true })

  // Fetch adviewer_clients (who has portal access)
  const { data: adviewerClients } = await supabase
    .from('adviewer_clients')
    .select('id, client_id, email, created_at, last_login_at')

  return (
    <AdminClient
      projects={projects ?? []}
      clients={clients ?? []}
      adviewerClients={adviewerClients ?? []}
    />
  )
}
