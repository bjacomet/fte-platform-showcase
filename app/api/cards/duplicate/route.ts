import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isStaffUser } from '@/lib/writers'
import { duplicateCards, planDuplicates } from '@/lib/duplicateCards'

// A fat-fingered "select all" should not be able to mint hundreds of cards in one click.
const MAX_CARDS = 25
const MAX_CLIENTS = 10

interface DuplicateRequest {
  cardIds?: unknown
  targetClientIds?: unknown
  dryRun?: unknown
}

function stringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...new Set(v as string[])] : null
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isStaffUser())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: DuplicateRequest
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const cardIds = stringArray(body.cardIds)
  const targetClientIds = stringArray(body.targetClientIds)
  if (!cardIds?.length || !targetClientIds?.length) {
    return NextResponse.json({ error: 'cardIds and targetClientIds are required' }, { status: 400 })
  }
  if (cardIds.length > MAX_CARDS || targetClientIds.length > MAX_CLIENTS) {
    return NextResponse.json(
      { error: `Up to ${MAX_CARDS} cards and ${MAX_CLIENTS} clients at a time.` },
      { status: 400 },
    )
  }

  try {
    if (body.dryRun === true) {
      const plan = await planDuplicates(supabase, cardIds, targetClientIds)
      return NextResponse.json({ plan })
    }
    const result = await duplicateCards(supabase, cardIds, targetClientIds, user.email ?? null)
    return NextResponse.json(result, { status: result.created.length > 0 ? 201 : 200 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Duplicate failed' }, { status: 500 })
  }
}
