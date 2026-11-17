import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface CardSummary {
  title: string
  client: string
  column: string
  mediaType: string | null
  deadline: string | null
  daysUntilDeadline: number | null
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { cards, today } = await req.json() as {
    cards: CardSummary[]
    today: string
  }

  if (cards.length === 0) {
    return Response.json({ snapshot: 'Nothing active right now — enjoy the quiet!', priorities: [], flags: [], tip: '' })
  }

  const cardList = cards
    .map((c) => {
      const due = c.daysUntilDeadline === null
        ? 'no deadline'
        : c.daysUntilDeadline < 0
          ? `${Math.abs(c.daysUntilDeadline)}d overdue`
          : c.daysUntilDeadline === 0
            ? 'due TODAY'
            : `due in ${c.daysUntilDeadline}d`
      return `- "${c.title}" | ${c.client} | ${c.mediaType ?? 'unknown type'} | Stage: ${c.column} | ${due}`
    })
    .join('\n')

  const prompt = `Today is ${today}. You are helping a graphic designer at an ad agency, plan his workday.

Active cards:
${cardList}

Respond ONLY with a valid JSON object matching this exact shape — no markdown, no extra text:

{
  "snapshot": "2-3 sentences on the overall shape of the day. Be direct.",
  "priorities": [
    {
      "title": "card title",
      "client": "client name",
      "type": "media type or null",
      "stage": "column name",
      "urgency": "overdue" | "today" | "soon" | "queued",
      "reason": "one short sentence on why this is this priority"
    }
  ],
  "flags": ["short observation 1", "short observation 2"],
  "tip": "One practical design tip specific to the work on his plate today. Max 2 sentences."
}

Rules:
- priorities: max 6, ordered by what he should do first
- flags: max 3, only if something genuinely stands out (duplicates, stuck cards, client pile-up). Omit array if nothing to flag.
- tip: specific to his actual work types today, not generic advice
- All strings must be plain text, no markdown inside values`

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: 'You are a JSON-only API. Always respond with a single valid JSON object matching the exact shape requested. Never include markdown, explanations, or any text outside the JSON.',
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = (response.content[0].type === 'text' ? response.content[0].text.trim() : '{}')
    .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

  try {
    const parsed = JSON.parse(raw) as {
      snapshot: string
      priorities: { title: string; client: string; type: string | null; stage: string; urgency: string; reason: string }[]
      flags?: string[]
      tip: string
    }
    return Response.json(parsed)
  } catch {
    return Response.json({ error: 'parse_failed', raw })
  }
}
