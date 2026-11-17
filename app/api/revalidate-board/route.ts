import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  let cardId: string | undefined
  try {
    const body = await req.json() as { cardId?: unknown }
    if (typeof body.cardId === 'string') cardId = body.cardId
  } catch {
    // body is optional
  }

  revalidatePath('/board')
  if (cardId) revalidatePath(`/card/${cardId}`)

  return Response.json({ ok: true })
}
