import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { FULL_CARD_SELECT } from '@/lib/cardQueries'
import type { Card, Client, Column } from '@/types'
import CardPageClient from './CardPageClient'

export const revalidate = 30

export default async function CardPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(`/card/${id}`)}`)

  const [{ data: card }, { data: columns }, { data: clients }] = await Promise.all([
    supabase.from('cards').select(FULL_CARD_SELECT).eq('id', id).single(),
    supabase.from('columns').select('*').order('position', { ascending: true }),
    supabase.from('clients').select('*').eq('active', true).order('name', { ascending: true }),
  ])

  if (!card) notFound()

  const doneColumnId = ((columns ?? []) as Column[]).find((c) => c.title === 'Done')?.id ?? null

  return (
    <CardPageClient
      card={card as Card}
      columns={(columns ?? []) as Column[]}
      clients={(clients ?? []) as Client[]}
      doneColumnId={doneColumnId}
      userEmail={user.email ?? 'unknown'}
    />
  )
}
