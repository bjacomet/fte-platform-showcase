import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AdminDashboard from './AdminDashboard'
import type { AdviewerCampaign } from '@/types'

export const dynamic = 'force-dynamic'

export default async function AdviewerDashboardPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/adviewer/login')

  // Resolve which client this auth user belongs to
  const { data: adviewerClient } = await supabase
    .from('adviewer_clients')
    .select('id, client_id, email')
    .eq('auth_user_id', user.id)
    .single()

  if (adviewerClient) {
    // Authenticated client — send to their project list
    redirect('/adviewer/projects')
  }

  // Staff member — show campaign dashboard
  const [{ data: clients }, { data: campaigns }] = await Promise.all([
    supabase
      .from('clients')
      .select('id, name, abbreviation, fb_page_logo_url')
      .eq('active', true)
      .order('name', { ascending: true }),

    supabase
      .from('adviewer_campaigns')
      .select(`
        id, title, token, status, archived, client_id, created_at, updated_at,
        client:clients(id, name, fb_page_logo_url),
        campaign_cards:adviewer_campaign_cards(
          id, position, status, client_notes,
          card:cards(id, title, media_type, archived, atlas_location_id)
        ),
        campaign_files:adviewer_campaign_files(id, file_name, file_url, position, status, client_notes),
        scopes:adviewer_campaign_scopes(id, status)
      `)
      .order('updated_at', { ascending: false }),
  ])

  return (
    <AdminDashboard
      userEmail={user.email ?? ''}
      clients={clients ?? []}
      campaigns={(campaigns ?? []) as unknown as AdviewerCampaign[]}
    />
  )
}
