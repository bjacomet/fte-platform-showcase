import { notFound, redirect } from 'next/navigation'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/writers'
import type { ClientAccountRow } from '@/lib/clientAdmin'
import type { Client, Column } from '@/types'
import ClientsPageContent from './ClientsPageContent'
import { VIDEO_DESIGNER_KEY, parseDesigner } from '@/lib/designers'

export const dynamic = 'force-dynamic'

export default async function ClientsPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const userEmail = user.email ?? 'unknown'
  // Client records and their ad-platform ids are staff-only; Adviewer
  // client-portal accounts are authenticated users too.
  if (!(await isStaffUser())) notFound()

  const [{ data: clients }, { data: columns }, { data: flights }, { data: videoRow }] = await Promise.all([
    supabase.from('clients').select('*').order('name', { ascending: true }), // includes inactive for management
    supabase.from('columns').select('*').order('position', { ascending: true }),
    supabase
      .from('card_flights')
      .select('card_id, cards!inner(client_id)')
      .is('went_dark_at', null)
      .eq('voided', false),
    supabase.from('app_settings').select('value').eq('key', VIDEO_DESIGNER_KEY).maybeSingle(),
  ])

  // ops.* is unreachable from the browser by design; this service-role RPC is
  // the only read path. An error here means supabase/add_client_admin_rpc.sql
  // hasn't run — the page still works, the account fields just start blank.
  const { data: accountRows, error: accountsError } = await createAdminClient().rpc('admin_list_client_accounts')

  // Count active live cards per client
  const liveCountByClient: Record<string, number> = {}
  for (const f of (flights ?? []) as unknown as Array<{ card_id: string; cards: { client_id: string | null } }>) {
    const clientId = f.cards?.client_id
    if (clientId) {
      liveCountByClient[clientId] = (liveCountByClient[clientId] ?? 0) + 1
    }
  }

  const clientsWithCounts = ((clients ?? []) as Client[]).map((c) => ({
    ...c,
    active_live_count: liveCountByClient[c.id] ?? 0,
  }))

  return (
    <ClientsPageContent
      clients={clientsWithCounts}
      columns={(columns ?? []) as Column[]}
      userEmail={userEmail}
      videoDesigner={parseDesigner(videoRow?.value)}
      accounts={(accountRows ?? []) as ClientAccountRow[]}
      accountsUnavailable={!!accountsError}
    />
  )
}
