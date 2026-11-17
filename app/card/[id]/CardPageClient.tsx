'use client'

import { useRouter } from 'next/navigation'
import CardDrawer from '@/components/CardDrawer'
import type { Card, Client, Column } from '@/types'

interface Props {
  card: Card
  columns: Column[]
  clients: Client[]
  doneColumnId: string | null
  userEmail: string
}

export default function CardPageClient({ card, columns, clients, doneColumnId, userEmail }: Props) {
  const router = useRouter()

  return (
    <CardDrawer
      card={card}
      columns={columns}
      clients={clients}
      doneColumnId={doneColumnId}
      onClose={() => {}}
      onUpdated={() => {}}
      onDeleted={() => router.push('/board')}
      onColumnChanged={() => {}}
      userEmail={userEmail}
      standalone
    />
  )
}
