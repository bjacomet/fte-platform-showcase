import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import type { AtlasGenerateRequest, AtlasGenerateResult, AtlasQuarter } from '@/types'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are a healthcare marketing copywriter specializing in oncology and urology patient acquisition campaigns for Atlas, a multi-location network of cancer and urology treatment centers.

Your job is to write compelling, compliant, compassionate ad copy for each center location. The copy must be:
- Warm, reassuring, and patient-centric — never alarming or clinical
- Specific to the location's community (landscape, demographics, focus type)
- Clear and action-oriented
- Appropriate for Facebook/social ads and display graphics
- Free of unsubstantiated medical claims

You will receive a JSON array of location+focus type combinations and must return copy for all 5 fields per row.`

function buildPrompt(rows: AtlasGenerateRequest['rows']): string {
  const rowDescriptions = rows.map((r, i) =>
    `Row ${i + 1}:
  Location: ${r.location_name}
  Focus Type: ${r.focus_type}
  Quarter: ${r.quarter} ${r.year}
  Key Notes: ${r.key_notes ?? 'None'}
  Landscape: ${r.landscape ?? 'Not specified'}
  Age Demo: ${r.age_demo ?? 'General'}
  Ethnicity Demo: ${r.ethnicity_demo ?? 'General Market'}`
  ).join('\n\n')

  return `Generate ad copy for the following ${rows.length} Atlas location+focus type combination(s):

${rowDescriptions}

For each row, return a JSON array with objects in this exact structure:
{
  "row_index": <number, 0-based>,
  "social_copy": "<2-3 sentence Facebook ad body copy — warm, patient-focused, ends with a soft CTA like 'Learn more about your options.'>",
  "social_headline": "<Short punchy headline, 6 words or fewer, for Facebook ad>",
  "social_subhead": "<1 sentence supporting line for the Facebook ad, 10 words or fewer>",
  "graphic_headline": "<Bold display graphic headline, 4-5 words max>",
  "graphic_subhead": "<Supporting line for the graphic, 6-8 words>"
}

Return ONLY a valid JSON array, no markdown, no explanation.`
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as AtlasGenerateRequest

  if (!body.rows || body.rows.length === 0) {
    return Response.json({ error: 'No rows provided' }, { status: 400 })
  }

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(body.rows) }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''

  let parsed: { row_index: number; social_copy: string; social_headline: string; social_subhead: string; graphic_headline: string; graphic_subhead: string }[]
  try {
    parsed = JSON.parse(text)
  } catch {
    return Response.json({ error: 'AI returned unparseable response', raw: text }, { status: 500 })
  }

  const results: AtlasGenerateResult[] = parsed.map((p) => {
    const row = body.rows[p.row_index]
    return {
      location_id: row.location_id,
      focus_type: row.focus_type,
      quarter: row.quarter as AtlasQuarter,
      year: row.year,
      social_copy: p.social_copy,
      social_headline: p.social_headline,
      social_subhead: p.social_subhead,
      graphic_headline: p.graphic_headline,
      graphic_subhead: p.graphic_subhead,
    }
  })

  return Response.json({ results })
}
