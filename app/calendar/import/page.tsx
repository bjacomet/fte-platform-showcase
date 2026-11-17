import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { normalizeMonth } from '@/lib/calendar'
import type { Client, Column } from '@/types'
import ImportPage from './ImportPage'

// Server component: looks up the client + columns the import page needs.
// Auth + client list mirror what `/calendar` does so this page only shows up
// for signed-in staff. If no client query param is present, redirect to the
// calendar root so the user picks one first.

interface SearchParams {
  client?: string
  year?: string
  month?: string
}

export const dynamic = 'force-dynamic'

export default async function CalendarImportRoute({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Admin client used for the columns + clients lookup so RLS doesn't gate
  // anything the staff calendar would already show this user.
  const admin = createAdminClient()

  const { data: clientsData } = await admin
    .from('clients')
    .select('*')
    .eq('active', true)
    .order('name', { ascending: true })
  const clients = (clientsData ?? []) as Client[]

  if (clients.length === 0) {
    redirect('/calendar')
  }

  const selectedClientId = params.client && clients.some((c) => c.id === params.client)
    ? params.client
    : clients[0].id

  const { year, month } = normalizeMonth(params.year, params.month)

  // Columns: we need one to drop the created cards into (they're calendar_only
  // so the actual column doesn't matter for display, but the FK must point
  // somewhere). Use the first column — same pick the modal made.
  const { data: columnsData } = await admin
    .from('columns')
    .select('*')
    .order('position', { ascending: true })
  const columns = (columnsData ?? []) as Column[]

  if (columns.length === 0) {
    // Edge case: brand-new install with no columns. Send them somewhere
    // that won't blow up.
    return (
      <div className="min-h-screen bg-[#0f1117] text-gray-200 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold mb-2">No board columns yet</h1>
          <p className="text-sm text-gray-400 mb-4">
            The calendar import needs at least one board column to anchor created cards.
            Create one on the board first.
          </p>
          <Link href="/board" className="text-blue-400 hover:underline text-sm">
            Go to Board →
          </Link>
        </div>
      </div>
    )
  }

  return (
    <ImportPage
      clients={clients}
      selectedClientId={selectedClientId}
      year={year}
      month={month}
      columnId={columns[0].id}
    />
  )
}
