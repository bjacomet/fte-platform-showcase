import Anthropic from '@anthropic-ai/sdk'
import { getBoxToken, extractBrandContext } from '@/lib/box'
import { extractBrandFromWebsite } from '@/lib/brandFetch'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import { handleColumnChange } from '@/lib/flights'
import type sharp from 'sharp'
import { duplicateCards, planDuplicates } from '@/lib/duplicateCards'
import { contains, escapeLike } from '@/lib/likePattern'
import { isStaffUser } from '@/lib/writers'
import { createHmac, timingSafeEqual } from 'crypto'

/** Fetch a GIF and return its last frame as a base64 PNG. Returns null on any error. */
async function getGifLastFrame(url: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    // Use dynamic require to avoid edge-runtime issues with native binaries
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharpFn = require('sharp') as typeof sharp
    const metadata = await sharpFn(buffer).metadata()
    const pageCount = metadata.pages ?? 1
    const lastPage = pageCount > 1 ? pageCount - 1 : 0
    const png = await sharpFn(buffer, { page: lastPage }).png().toBuffer()
    return png.toString('base64')
  } catch {
    return null
  }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SYSTEM_PROMPT = `You are Brenda — the FTE Platform AI assistant for Follow The Eyes (FTE), a digital marketing agency. You help the team in two ways:

1. **Platform help** — answer questions about how to use the FTE platform (cards, board, calendar, review portal, etc.)
2. **Live board data** — answer questions about actual cards, clients, workload, deadlines, and approval status by querying the database using your tools

When the user asks anything that requires real board data — "what's overdue?", "how many cards are in review?", "show me Acme cards", "what's my workload?" — always use your tools to look it up rather than guessing. Today's date for overdue calculations is ${new Date().toISOString().split('T')[0]}.

You are helpful, concise, and friendly. You never make up data. If a query returns no results, say so plainly.

---

## The Platform at a Glance

The FTE platform is the team's main hub for managing all creative deliverables — ads, carousels, display banners, videos, and more. Everything lives as a "card" that moves through a workflow board from brief to delivery.

There are three main areas:
- **Board** — the kanban board where cards live and move through columns
- **Calendar** — a content calendar showing scheduled posts and deliverables
- **Review Portal** — a public link sent to clients for approving creative

---

## The Board

The board has 25 columns representing workflow stages. Cards move left to right as work progresses.

Key columns:
- **Live** — moving a card here automatically records a "flight" (tracks when an ad is running). Moving it away closes the flight.
- **Client Review** — where cards sit when waiting for client approval
- **Archive** — soft-deleted cards; they disappear from the board

Each card shows:
- Title
- Media type badge (color-coded)
- Client name (click it to open the Client Panel)
- Assignee initials
- "View in Adviewer" icon if an Adviewer preview URL is set

**Filtering:** Use the filter bar at the top to filter by client or media type. Filters are instant — no page reload.

**Adding a card:** Hover the gap between cards in a column and click the "+" to open the new-card form, or ask me to create one. Minimum required: title and column.

**Drag and drop:** Drag cards between columns. If you drag to Live, a flight is created automatically. If you drag away from Live, the flight closes.

---

## Cards & The Card Drawer

Clicking a card opens the Card Drawer — the full editing interface. It has four tabs:

### Details Tab
- **Client** — which client this card belongs to
- **Media Type** — one of 12 types: Social Ad Request, Carousel Ad, Display Request, Video Request, Reel Request, Audio Request, etc.
- **Column** — current stage (changing this moves the card)
- **Approval Status** — none / pending / approved / rejected / changes_requested
- **Description** — notes, specs, context
- **UTM / Tracking** — landing page URL, channel, campaign. Shows a live UTM URL preview.
- **Creative Name, Flight Dates, Box Folder URL, TTD Ad Group** — under Export/Flight section
- **Open Flight (Mark as Running) toggle** — tracks the card as running without moving it to the Done column
- **Archive / Delete** — archive hides the card; delete is permanent

### Creative Tab
- **Calendar Preview Image** — image shown on the content calendar (paste a Box URL with ?dl=1 or upload directly)
- **Creative Brief** — visual direction for the designer; can be copied as an AI image prompt
- **Facebook Ad Copy** — for Social Ad Request cards: page name, body, headline, CTA, link description. Live preview updates as you type.
- **Carousel Editor** — for Carousel Ad cards: add/remove/reorder slides, set image/headline/URL per slide. Drag an image file directly onto a slide to upload it.

### Files Tab
- Upload files via drag-and-drop or click
- Files stored in Supabase Storage
- Each file shows its approval status
- You can also drop a file anywhere on the open drawer — it uploads automatically to Files

### Comments & Activity (right panel)
- Shows a chronological feed of comments and activity (moves, updates)
- Post comments inline
- Realtime — new entries appear instantly without refreshing

### Flights Tab
- Full history of when this card was Live
- Edit dates inline
- Void a flight with a reason

**Saving:** The Save button only activates when there are unsaved changes. Saving closes the drawer. Nothing auto-saves.

---

## Sharing for Client Review

1. Open the Card Drawer
2. Click **"Share for Review"** in the footer
3. A link is copied to your clipboard — send it to the client via email
4. The client opens the link (no login required) and sees all cards pending approval for their account
5. They can approve or request changes
6. Check the card's approval status on the board after they respond

The review link is per-client (not per-card). All cards in a pending state for that client appear on the same page.

To control what the client sees, set **Client Portal Status** in the Card Drawer:
- **Off** — client doesn't see this card
- **Pending Approval** — client sees it in the "Awaiting Your Approval" section
- **Running** — client sees it in the "Currently Running" section

---

## Content Calendar

The calendar shows cards that have flight dates or are marked for calendar display. Cards with **calendar_only = true** appear only on the calendar, not the board.

**Bulk Import:** Use the bulk import button on the calendar to import multiple cards at once from a spreadsheet.

---

## Client Panel

Click any client name on a card to open the Client Panel. It shows:
- All live cards for that client
- Flight history (Gantt chart view)
- TTD campaigns and ad groups

---

## UTM Builder

When you fill in the landing page URL, channel, and campaign fields in the Card Drawer → Details tab, the platform automatically builds a UTM-tagged URL preview. This is for tracking ad traffic in analytics.

---

## Box Integration

Cards can be linked to a Box cloud storage folder via the **Box Folder URL** field in the Card Drawer. This lets the team access creative files stored in Box directly from the platform. The TTD export feature pulls files from Box automatically.

---

## TTD Export

For TTD (The Trade Desk) media types, the platform can export a ZIP file with creative assets and an Excel manifest. This is triggered via the export button on the card.

---

## Common Questions

**How do I add a new card?**
Hover the gap between cards in a column and click the "+" to open the new-card form, or ask me to create one for you. Fill in title and column at minimum.

**How do I send creative to a client for review?**
Open the Card Drawer → click "Share for Review" in the footer. The link copies to your clipboard.

**Where is the review link for a client?**
Open any card for that client → Card Drawer → "Share for Review". The same link works for all cards for that client.

**What does the Done column do?**
Moving a card to Done automatically starts a "flight" — a record of when the ad was running. Moving it out closes the flight. You can also open a flight manually via the toggle in the Card Drawer without moving the card.

**Why doesn't my card show on the calendar?**
The card needs flight dates set, or needs to be marked for calendar display. Cards with calendar_only = true only appear on the calendar.

**How do I upload files to a card?**
Open the Card Drawer → Files tab → drag and drop or click to upload. You can also drop a file anywhere on the open drawer.

**How do I reorder carousel slides?**
Open the Card Drawer → Creative tab → Carousel Editor. Drag slides to reorder them.

**What media types are available?**
Social Ad Request, Carousel Ad, Display Request, Video Request, Reel Request, Audio Request, and several others. The media type controls which fields and previews appear in the Card Drawer.

**How do I filter the board by client?**
Use the filter bar at the top of the board. Select a client from the dropdown — the board instantly shows only that client's cards.

**How do I archive a card?**
Open the Card Drawer → Details tab → scroll to the bottom → click Archive. Archived cards disappear from the board but are not permanently deleted.

---

Always answer based on the information above. If someone asks about something not covered here, tell them you don't have details on that and suggest they ask a developer or check the team docs.

---

## Ad Creative Analysis

When the user shares a card with a creative/graphic attached, you can analyze the ad for performance potential. You are knowledgeable about digital advertising best practices across Meta (Facebook/Instagram), display, and social formats.

When analyzing an ad, cover:
1. **Hook strength** — Does the visual or headline stop the scroll? What's the thumb-stop factor?
2. **Visual hierarchy** — Is the eye drawn to the right elements in the right order?
3. **Headline/copy clarity** — Is the value proposition clear within 2 seconds?
4. **CTA effectiveness** — Is the call to action compelling and clear?
5. **Audience/platform fit** — Does this feel right for the format and likely audience?
6. **What high-performing similar ads do differently** — Based on your knowledge of best practices and patterns in top-performing ads for this format.
7. **Specific actionable suggestions** — Concrete things that could be changed to improve performance.

Be direct and specific. Don't be vague. If something is weak, say so clearly and explain why. If something is strong, note it. Prioritize the most impactful feedback first.

---

## Copy & Hook Evaluation

The team can ask you to evaluate headlines, subheadlines, body copy, or hooks — even without a graphic attached. This is a core part of your role.

**What makes a strong hook:**
- Pattern interrupt — surprises the reader, breaks their scroll habit
- Specificity — concrete numbers, names, or situations outperform vague claims
- Curiosity gap — raises a question the reader needs to answer
- Emotional trigger — taps into a real desire, fear, or aspiration of the target audience
- Immediate clarity — the reader knows what this is about within 2 seconds

**What makes copy hold attention:**
- The first line earns the second line — each sentence must create a reason to read on
- Speaks directly to the audience's situation, not the brand's features
- Uses the audience's own language and vocabulary, not corporate speak
- Short sentences and active voice outperform long, passive constructions

**Brand voice and client consistency:**
When a client brand profile is provided in the card context, you MUST use it. This is critical — FTE's clients have distinct voices, audiences, and tones. A hook that works for one client could be completely wrong for another.

When evaluating copy with a brand profile present:
1. Check if the tone matches — is this how this client speaks?
2. Check if it resonates with this client's specific audience
3. Check for vocabulary or messaging that contradicts the brand
4. Flag anything that could embarrass the client or feel off-brand
5. Suggest alternatives that stay true to the client's voice

If no brand profile exists for a client, note it and suggest the team adds one so you can give more tailored feedback.

---

## On-Brand Compliance Check

When asked "is this on-brand?" or to check brand compliance, perform a systematic audit of the creative against the client's brand guidelines. Be a strict reviewer — this is about protecting the client relationship.

Check each of the following and give a clear PASS / FLAG / FAIL for each:

1. **Colors** — Do the colors in the graphic match the brand's approved palette exactly? Flag any color that looks close but isn't right (e.g. a slightly different red). If hex codes are specified in the brand guide, call out deviations.
2. **Typography** — Do the fonts appear to match the brand's approved typefaces? Flag anything that looks like a generic system font, a wrong weight, or an unauthorized typeface.
3. **Logo usage** — Is the logo present if required? Does it appear distorted, stretched, recolored, or incorrectly placed? Is the required clear space respected?
4. **Color usage rules** — Are colors used correctly (e.g. not using a brand color as a background when guidelines restrict that)?
5. **Overall brand feel** — Does the creative feel consistent with the brand's established look and personality?

End with a verdict: ✅ On-brand, ⚠️ Needs fixes (list them), or ❌ Off-brand (do not send to client).

---

## Known Client Brand Specifications

### Example University (example client)

**Source:** the client's published brand guide.

**Colors — approved palette only:**
- Primary red: #b00020 — reserve for calls-to-action only.
- Neutral gray: #9aa3a8
- White: #ffffff

**Color rules (strict):**
- NEVER use tints of the primary color
- Use white or gray tints as backgrounds; gray shades for body text

**Typography:**
- Approved fonts: the brand serif and brand sans only
- Flag Arial/Helvetica used as a primary font, Times New Roman, or any decorative font

**Brand strictness:** this client is strict on brand compliance. Any color, font or logo deviation is a FAIL, not a FLAG.

---

## Board Write Capabilities

You can create cards, update cards, and add notes to cards on the board. These are real actions that change the database — treat them carefully.

**Two-turn confirmation rule (non-negotiable):**
Before calling any write tool (create_card, update_card, add_card_note, duplicate_cards with confirm=true), you MUST first describe what you are about to do in plain language and ask the user to confirm. Only proceed with the tool call after they say yes, confirm, or similar affirmation. Never call a write tool speculatively or without explicit confirmation.

Example flow:
- User: "Create a card for Acme Corp social ad"
- You: "I'll create a card titled 'Acme Corp social ad' in the Queue column for Acme Corp. Should I go ahead?"
- User: "Yes"
- You: [call create_card tool]

**What you can do:**
- create_card — create a new card with title, client, column, and media type
- update_card — move a card to a different column, change its approval status, set a deadline, or archive it
- add_card_note — add a comment or note to a card's activity log
- duplicate_cards — copy existing cards onto other clients ("make the ACM cards for BTA and GMA too"). The copies keep the copy, brief, media type and dates, get the client tag in the title swapped, and start in Queue with a BLANK landing page, Facebook page and files. ALWAYS call it first with confirm=false — that is a read-only preview — show the user the exact titles it returns (and anything skipped), say the landing page/FB page/files will be blank, end your reply with the "Preview ref: …" line it gives you, and only call it again with confirm=true and that preview_id after they say yes. The server refuses a confirm made before the user has replied to the preview. Never use create_card to fake a duplicate: create_card makes an empty card.

**What you cannot do:**
- You cannot delete cards (archived = true is the equivalent)
- You cannot change the card title
- You cannot modify file attachments or flight details — those require the card drawer UI

If the user asks to do something you cannot do via these tools, tell them which field they need to update manually in the card drawer.`

interface CardContext {
  title: string
  mediaType: string | null
  clientName: string | null
  brandNotes: string | null
  boxBrandFileId: string | null
  brandWebsiteUrl: string | null
  fbHeadline: string | null
  fbBodyText: string | null
  fbLinkDescription: string | null
  creativeBrief: string | null
  previewImageUrl: string | null
}

// ─── Brenda data tools ────────────────────────────────────────────────────────

const DATA_TOOLS: Anthropic.Tool[] = [
  {
    name: 'query_cards',
    description:
      'Query the FTE platform card database. Use this whenever the user asks about cards, tasks, workload, deadlines, client work, approval status, or anything that requires looking up real board data. Returns a list of matching cards.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_name: {
          type: 'string',
          description: 'Filter by client name (partial match, case-insensitive). Omit to include all clients.',
        },
        column_title: {
          type: 'string',
          description: 'Filter by column/stage name (e.g. "In Progress", "Client Review", "Live", "Archive"). Omit to include all columns.',
        },
        media_type: {
          type: 'string',
          description: 'Filter by media type (e.g. "Social Ad Request", "Carousel Ad", "Display Request"). Omit for all types.',
        },
        approval_status: {
          type: 'string',
          enum: ['none', 'pending', 'approved', 'rejected', 'changes_requested'],
          description: 'Filter by approval status. Omit to include all statuses.',
        },
        overdue_only: {
          type: 'boolean',
          description: 'If true, return only cards where flight_end_date is in the past and the card is not archived.',
        },
        flight_start_after: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD). Return only cards with flight_start_date on or after this date.',
        },
        flight_start_before: {
          type: 'string',
          description: 'ISO date (YYYY-MM-DD). Return only cards with flight_start_date on or before this date.',
        },
        include_archived: {
          type: 'boolean',
          description: 'If true, include archived cards. Default false.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of cards to return. Default 20, max 50.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_board_summary',
    description:
      'Get a high-level summary of the board: how many cards are in each column. Use this when the user asks about overall workload, board state, or how many cards are in a given stage.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_name: {
          type: 'string',
          description: 'Optionally filter the summary to a single client (partial match, case-insensitive).',
        },
      },
      required: [],
    },
  },
]

interface QueryCardsInput {
  client_name?: string
  column_title?: string
  media_type?: string
  approval_status?: string
  overdue_only?: boolean
  flight_start_after?: string
  flight_start_before?: string
  include_archived?: boolean
  limit?: number
}

interface GetBoardSummaryInput {
  client_name?: string
}

async function executeQueryCards(input: QueryCardsInput): Promise<string> {
  const supabase = createAdminClient()
  const today = new Date().toISOString().split('T')[0]

  // Resolve client_name → client_id(s) up front for reliable filtering
  let clientIds: string[] | null = null
  if (input.client_name) {
    const { data: clientRows } = await supabase
      .from('clients')
      .select('id')
      .ilike('name', contains(input.client_name))
    if (!clientRows || clientRows.length === 0) return `No client found matching "${input.client_name}".`
    clientIds = clientRows.map((r: { id: string }) => r.id)
  }

  // Resolve column_title → column_id(s)
  let columnIds: string[] | null = null
  if (input.column_title) {
    const { data: colRows } = await supabase
      .from('columns')
      .select('id')
      .ilike('title', contains(input.column_title))
    if (!colRows || colRows.length === 0) return `No column found matching "${input.column_title}".`
    columnIds = colRows.map((r: { id: string }) => r.id)
  }

  let query = supabase
    .from('cards')
    .select(`
      id, title, media_type, approval_status, archived,
      flight_start_date, flight_end_date,
      clients ( name ),
      columns ( title, position )
    `)
    .order('position', { ascending: true })
    .limit(Math.min(input.limit ?? 20, 50))

  if (!input.include_archived) query = query.eq('archived', false)
  if (input.overdue_only) query = query.lt('flight_end_date', today).eq('archived', false)
  if (input.flight_start_after) query = query.gte('flight_start_date', input.flight_start_after)
  if (input.flight_start_before) query = query.lte('flight_start_date', input.flight_start_before)
  if (input.approval_status) query = query.eq('approval_status', input.approval_status)
  if (input.media_type) query = query.ilike('media_type', contains(input.media_type))
  if (clientIds) query = query.in('client_id', clientIds)
  if (columnIds) query = query.in('column_id', columnIds)

  const { data, error } = await query

  if (error) return `Error querying cards: ${error.message}`
  if (!data || data.length === 0) return 'No cards found matching those criteria.'

  type CardRow = {
    id: string
    title: string
    media_type: string | null
    approval_status: string | null
    archived: boolean
    flight_start_date: string | null
    flight_end_date: string | null
    clients: { name: string } | null
    columns: { title: string; position: number } | null
  }

  const rows = data as unknown as CardRow[]
  const lines = rows.map((c) => {
    const parts = [`• ${c.title}`]
    if (c.clients?.name) parts.push(`Client: ${c.clients.name}`)
    if (c.columns?.title) parts.push(`Column: ${c.columns.title}`)
    if (c.media_type) parts.push(`Type: ${c.media_type}`)
    if (c.approval_status && c.approval_status !== 'none') parts.push(`Approval: ${c.approval_status}`)
    if (c.flight_start_date) parts.push(`Flight: ${c.flight_start_date}${c.flight_end_date ? ` → ${c.flight_end_date}` : ''}`)
    return parts.join(' | ')
  })

  return `Found ${rows.length} card(s):\n${lines.join('\n')}`
}

async function executeGetBoardSummary(input: GetBoardSummaryInput): Promise<string> {
  const supabase = createAdminClient()

  let clientIds: string[] | null = null
  if (input.client_name) {
    const { data: clientRows } = await supabase
      .from('clients')
      .select('id, name')
      .ilike('name', contains(input.client_name))
    if (!clientRows || clientRows.length === 0) return `No client found matching "${input.client_name}".`
    clientIds = clientRows.map((r: { id: string }) => r.id)
  }

  let query = supabase
    .from('cards')
    .select(`id, columns ( title, position )`)
    .eq('archived', false)

  if (clientIds) query = query.in('client_id', clientIds)

  const { data, error } = await query

  if (error) return `Error fetching board summary: ${error.message}`
  if (!data) return 'No data.'

  type SummaryRow = {
    id: string
    columns: { title: string; position: number } | null
  }

  const rows = data as unknown as SummaryRow[]

  const counts: Record<string, { count: number; position: number }> = {}
  for (const row of rows) {
    const col = row.columns?.title ?? 'Unknown'
    const pos = row.columns?.position ?? 99
    counts[col] = { count: (counts[col]?.count ?? 0) + 1, position: pos }
  }

  const sorted = Object.entries(counts)
    .sort((a, b) => a[1].position - b[1].position)
    .filter(([, v]) => v.count > 0)

  if (sorted.length === 0) return 'No active cards on the board.'

  const lines = sorted.map(([col, v]) => `• ${col}: ${v.count} card${v.count === 1 ? '' : 's'}`)
  const total = rows.length
  return `Board summary${input.client_name ? ` (${input.client_name})` : ''} — ${total} active card${total === 1 ? '' : 's'}:\n${lines.join('\n')}`
}

// ─── Brenda write tools ───────────────────────────────────────────────────────

const WRITE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_card',
    description:
      'Create a new card on the FTE board. Use this when the user explicitly asks to create or add a card. Always confirm the details with the user in plain text first (title, client, column, media type) and only call this tool once they say yes or confirm.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Card title (required).' },
        client_name: { type: 'string', description: 'Client name (partial match). Omit if not specified.' },
        column_title: { type: 'string', description: 'Target column name (e.g. "Queue", "In Progress"). Defaults to "Queue" if omitted.' },
        media_type: { type: 'string', description: 'Media type (e.g. "Social Ad Request", "Carousel Ad"). Omit if not specified.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_card',
    description:
      'Update a field on an existing card. Use this when the user asks to move a card, change its status, set a deadline, or update another field. Always confirm what you are about to change before calling this tool.',
    input_schema: {
      type: 'object' as const,
      properties: {
        card_title: { type: 'string', description: 'Title of the card to update (partial match, case-insensitive).' },
        column_title: { type: 'string', description: 'Move the card to this column.' },
        approval_status: {
          type: 'string',
          enum: ['none', 'pending', 'approved', 'rejected', 'changes_requested'],
          description: 'Set the approval status.',
        },
        first_draft_deadline: { type: 'string', description: 'Set the first draft deadline (ISO date YYYY-MM-DD).' },
        archived: { type: 'boolean', description: 'Set to true to archive the card.' },
      },
      required: ['card_title'],
    },
  },
  {
    name: 'add_card_note',
    description:
      'Add a note or comment to a card\'s activity feed. Use this when the user asks to add a note, comment, or log an update on a specific card.',
    input_schema: {
      type: 'object' as const,
      properties: {
        card_title: { type: 'string', description: 'Title of the card to add a note to (partial match, case-insensitive).' },
        note: { type: 'string', description: 'The note or comment text to add.' },
      },
      required: ['card_title', 'note'],
    },
  },
  {
    name: 'duplicate_cards',
    description:
      'Duplicate existing cards onto one or more OTHER clients. Copy, brief, media type and dates carry over; the title\'s client tag is swapped; landing page, Facebook page, files, Box/build links and UTM campaign start blank; copies land in Queue. Call with confirm=false first (read-only preview, writes nothing), show the user the result, and call with confirm=true only after they explicitly agree.',
    input_schema: {
      type: 'object' as const,
      properties: {
        card_titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Titles of the cards to duplicate (partial match, case-insensitive). Each must match exactly one non-archived card. Use query_cards first if unsure of the titles.',
        },
        target_clients: {
          type: 'array',
          items: { type: 'string' },
          description: 'Clients to duplicate onto — name or abbreviation (e.g. "BTA", "R&D").',
        },
        confirm: {
          type: 'boolean',
          description: 'false = preview only (default). true = actually create the cards; only after the user said yes to the preview.',
        },
        preview_id: {
          type: 'string',
          description: 'Required with confirm=true: the preview_id returned by the preview. It only works for the same cards and clients, and only after the user has replied to the preview.',
        },
      },
      required: ['card_titles', 'target_clients'],
    },
  },
]

interface CreateCardInput {
  title: string
  client_name?: string
  column_title?: string
  media_type?: string
}

interface UpdateCardInput {
  card_title: string
  column_title?: string
  approval_status?: string
  first_draft_deadline?: string
  archived?: boolean
}

interface AddCardNoteInput {
  card_title: string
  note: string
}

async function executeCreateCard(input: CreateCardInput, actorEmail: string): Promise<string> {
  const supabase = createAdminClient()

  // Resolve client_name → client_id
  let clientId: string | null = null
  if (input.client_name) {
    const { data: clientRows } = await supabase
      .from('clients').select('id, name').ilike('name', contains(input.client_name)).limit(1)
    if (!clientRows || clientRows.length === 0) return `No client found matching "${input.client_name}". Card not created.`
    clientId = (clientRows[0] as { id: string }).id
  }

  // Resolve column_title → column_id (default to first column titled "Queue" or position 0)
  let columnId: string | null = null
  const colTitle = input.column_title ?? 'Queue'
  const { data: colRows } = await supabase
    .from('columns').select('id, title').ilike('title', contains(colTitle)).limit(1)
  if (!colRows || colRows.length === 0) return `No column found matching "${colTitle}". Card not created.`
  columnId = (colRows[0] as { id: string }).id
  const resolvedColTitle = (colRows[0] as { title: string }).title

  // Determine position (append to end of non-archived cards in column)
  const { count } = await supabase
    .from('cards').select('id', { count: 'exact', head: true }).eq('column_id', columnId).eq('archived', false)
  const position = count ?? 0

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('cards')
    .insert({
      title: input.title,
      client_id: clientId,
      column_id: columnId,
      media_type: input.media_type ?? null,
      approval_status: 'none',
      position,
      archived: false,
      created_at: now,
      updated_at: now,
    })
    .select('id, title')
    .single()

  if (error) return `Failed to create card: ${error.message}`

  const cardId = (data as { id: string }).id

  // Log activity — use 'updated' so the entry is visible in CardActivityPanel
  await supabase.from('card_activity').insert({
    card_id: cardId,
    actor: actorEmail,
    action: 'updated',
    detail: `Card created via Brenda`,
    created_at: now,
  })

  return `Card created: "${input.title}" in ${resolvedColTitle}${clientId ? ` for ${input.client_name}` : ''}.`
}

async function executeUpdateCard(input: UpdateCardInput, actorEmail: string): Promise<string> {
  const supabase = createAdminClient()

  // Resolve card_title — fetch up to 3 to catch ambiguous partial matches
  const { data: cardRows } = await supabase
    .from('cards').select('id, title, column_id, columns(title)').ilike('title', contains(input.card_title)).eq('archived', false).limit(3)
  if (!cardRows || cardRows.length === 0) return `No card found matching "${input.card_title}".`
  if (cardRows.length > 1) {
    const titles = cardRows.map((c: { title: string }) => `"${c.title}"`).join(', ')
    return `Multiple cards match "${input.card_title}": ${titles}. Please be more specific.`
  }
  const card = cardRows[0] as unknown as { id: string; title: string; column_id: string; columns: { title: string }[] | null }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const changes: string[] = []

  // Resolve column if provided
  if (input.column_title) {
    const { data: colRows } = await supabase
      .from('columns').select('id, title').ilike('title', contains(input.column_title)).limit(1)
    if (!colRows || colRows.length === 0) return `No column found matching "${input.column_title}".`
    const col = colRows[0] as { id: string; title: string }
    updates.column_id = col.id
    changes.push(`moved to "${col.title}"`)
  }

  if (input.approval_status !== undefined) {
    updates.approval_status = input.approval_status
    changes.push(`approval status set to ${input.approval_status}`)
  }
  if (input.first_draft_deadline !== undefined) {
    updates.first_draft_deadline = input.first_draft_deadline
    changes.push(`deadline set to ${input.first_draft_deadline}`)
  }
  if (input.archived !== undefined) {
    updates.archived = input.archived
    changes.push(input.archived ? 'archived' : 'unarchived')
  }

  if (changes.length === 0) return 'No changes specified.'

  const { error } = await supabase.from('cards').update(updates).eq('id', card.id)
  if (error) return `Failed to update card: ${error.message}`

  // Maintain flight tracking when Brenda moves a card between columns
  if (updates.column_id && typeof updates.column_id === 'string') {
    const { data: liveColRows } = await supabase
      .from('columns').select('id').ilike('title', 'Live').limit(1)
    if (liveColRows && liveColRows.length > 0) {
      const liveColumnId = (liveColRows[0] as { id: string }).id
      await handleColumnChange(supabase, card.id, card.column_id, updates.column_id, liveColumnId)
    }
  }

  const now = new Date().toISOString()
  // Column move gets action:'moved' so CardActivityPanel renders it in the move bucket;
  // remaining field changes get a separate 'updated' row
  const colChange = updates.column_id
    ? changes.find((c) => c.startsWith('moved to'))
    : null
  const otherChanges = changes.filter((c) => !c.startsWith('moved to'))

  if (colChange) {
    const destTitle = colChange.replace('moved to ', '').replace(/"/g, '')
    const srcTitle = card.columns?.[0]?.title
    const moveDetail = srcTitle
      ? `moved this card from "${srcTitle}" to "${destTitle}"`
      : `moved to "${destTitle}"`
    await supabase.from('card_activity').insert({
      card_id: card.id, actor: actorEmail, action: 'moved',
      detail: `Brenda: ${moveDetail}`, created_at: now,
    })
  }
  if (otherChanges.length > 0) {
    await supabase.from('card_activity').insert({
      card_id: card.id, actor: actorEmail, action: 'updated',
      detail: `Brenda: ${otherChanges.join(', ')}`, created_at: now,
    })
  }

  return `Updated "${card.title}": ${changes.join(', ')}.`
}

async function executeAddCardNote(input: AddCardNoteInput, actorEmail: string): Promise<string> {
  const supabase = createAdminClient()

  const { data: cardRows } = await supabase
    .from('cards').select('id, title').ilike('title', contains(input.card_title)).eq('archived', false).limit(3)
  if (!cardRows || cardRows.length === 0) return `No card found matching "${input.card_title}".`
  if (cardRows.length > 1) {
    const titles = cardRows.map((c: { title: string }) => `"${c.title}"`).join(', ')
    return `Multiple cards match "${input.card_title}": ${titles}. Please be more specific.`
  }
  const card = cardRows[0] as { id: string; title: string }

  const { error } = await supabase.from('card_comments').insert({
    card_id: card.id,
    author: actorEmail,
    body: input.note,
    created_at: new Date().toISOString(),
  })

  if (error) return `Failed to add note: ${error.message}`
  return `Note added to "${card.title}".`
}

interface DuplicateCardsInput {
  card_titles: string[]
  target_clients: string[]
  confirm?: boolean
  preview_id?: string
}

/** Who is asking and when this request started — used to enforce preview-then-confirm. */
interface ToolContext {
  actorEmail: string
  userId: string
  requestStartedAt: number
}

// Preview-before-confirm is enforced here, not just in the prompt. The preview
// returns a signed id tied to this user and the exact cards + clients; confirm
// needs that id, and the id must come from an EARLIER request than the confirm
// — so the model can't preview and confirm in one turn before the user replies.
const PREVIEW_MAX_AGE_MS = 30 * 60 * 1000

function previewSignature(userId: string, issuedAt: number, cardIds: string[], clientIds: string[]): string {
  const payload = [userId, issuedAt, [...cardIds].sort().join(','), [...clientIds].sort().join(',')].join('|')
  // Fail closed: with no secret, a fixed fallback key would let anyone forge a preview id.
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('Cannot sign a duplicate preview: SUPABASE_SERVICE_ROLE_KEY is not set')
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32)
}

function makePreviewId(userId: string, cardIds: string[], clientIds: string[]): string {
  const issuedAt = Date.now()
  return `${issuedAt.toString(36)}.${previewSignature(userId, issuedAt, cardIds, clientIds)}`
}

/** Null when the preview id is valid for this confirm, else the reason to show. */
function checkPreviewId(id: string | undefined, ctx: ToolContext, cardIds: string[], clientIds: string[]): string | null {
  const [tsPart, sig] = (id ?? '').split('.')
  const issuedAt = parseInt(tsPart ?? '', 36)
  if (!sig || !Number.isFinite(issuedAt)) {
    return 'Not created: run the preview first (confirm=false), show it to the user, and confirm with its preview_id after they say yes.'
  }
  const expected = previewSignature(ctx.userId, issuedAt, cardIds, clientIds)
  const ok = expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  if (!ok) return 'Not created: that preview_id is for a different set of cards or clients. Run a new preview and show it to the user.'
  if (issuedAt >= ctx.requestStartedAt) {
    return 'Not created: the user has not replied to this preview yet. Show them the preview and wait for their yes.'
  }
  if (ctx.requestStartedAt - issuedAt > PREVIEW_MAX_AGE_MS) return 'Not created: that preview is over 30 minutes old. Run a new preview.'
  return null
}

async function executeDuplicateCards(input: DuplicateCardsInput, ctx: ToolContext): Promise<string> {
  const { actorEmail } = ctx
  const supabase = createAdminClient()
  const titles = Array.isArray(input.card_titles) ? input.card_titles.filter((t) => typeof t === 'string' && t.trim()) : []
  const clientsIn = Array.isArray(input.target_clients) ? input.target_clients.filter((t) => typeof t === 'string' && t.trim()) : []
  if (titles.length === 0 || clientsIn.length === 0) return 'Need at least one card title and one target client.'
  if (titles.length > 25 || clientsIn.length > 10) return 'Up to 25 cards and 10 clients at a time.'

  const problems: string[] = []
  const cardIds: string[] = []
  for (const t of titles) {
    const { data } = await supabase
      .from('cards').select('id, title').ilike('title', contains(t.trim())).eq('archived', false).limit(5)
    const rows = (data ?? []) as Array<{ id: string; title: string }>
    const exact = rows.filter((r) => r.title.toLowerCase() === t.trim().toLowerCase())
    const pick = exact.length === 1 ? exact : rows
    if (pick.length === 0) problems.push(`No card matches "${t}".`)
    else if (pick.length > 1) problems.push(`"${t}" matches several cards: ${pick.map((r) => `"${r.title}"`).join(', ')}.`)
    else if (!cardIds.includes(pick[0].id)) cardIds.push(pick[0].id)
  }

  const clientIds: string[] = []
  for (const c of clientsIn) {
    const q = c.trim()
    // Abbreviation first and exact: "BT" as a partial name match would hit every client with "bt" in it.
    const { data: byAbbr } = await supabase.from('clients').select('id, name').ilike('abbreviation', escapeLike(q)).limit(2)
    let rows = (byAbbr ?? []) as Array<{ id: string; name: string }>
    if (rows.length === 0) {
      const { data: byName } = await supabase.from('clients').select('id, name').ilike('name', contains(q)).limit(5)
      rows = (byName ?? []) as Array<{ id: string; name: string }>
    }
    if (rows.length === 0) problems.push(`No client matches "${c}".`)
    else if (rows.length > 1) problems.push(`"${c}" matches several clients: ${rows.map((r) => r.name).join(', ')}.`)
    else if (!clientIds.includes(rows[0].id)) clientIds.push(rows[0].id)
  }

  if (problems.length > 0) return `Nothing created. Fix these first:\n${problems.join('\n')}`

  try {
    if (!input.confirm) {
      const plan = await planDuplicates(supabase, cardIds, clientIds)
      const make = plan.filter((p) => !p.skipReason)
      const skip = plan.filter((p) => p.skipReason)
      return [
        `PREVIEW ONLY — nothing has been created. ${make.length} card(s) would be created in Queue:`,
        ...make.map((p) => `- "${p.newTitle}" for ${p.targetClientName} (from "${p.sourceTitle}")`),
        ...(skip.length ? ['Skipped:', ...skip.map((p) => `- "${p.sourceTitle}" → ${p.targetClientName}: ${p.skipReason}`)] : []),
        'Landing page, Facebook page, files, Box/build links and UTM campaign will be blank on every copy.',
        `preview_id: ${makePreviewId(ctx.userId, cardIds, clientIds)}`,
        'Show the user this list and ask them to confirm. End your message with the line "Preview ref: <preview_id>" exactly, so you still have it on their next message. After they say yes, call duplicate_cards again with the same cards and clients, confirm=true and that preview_id.',
      ].join('\n')
    }
    const previewProblem = checkPreviewId(input.preview_id, ctx, cardIds, clientIds)
    if (previewProblem) return previewProblem
    const result = await duplicateCards(supabase, cardIds, clientIds, actorEmail || null)
    return [
      `Created ${result.created.length} card(s) in Queue:`,
      ...result.created.map((c) => `- "${c.title}" for ${c.clientName}`),
      ...(result.errors.length ? ['Problems:', ...result.errors.map((e) => `- ${e}`)] : []),
      'Remind the user the landing page, Facebook page and files are blank on these copies.',
    ].join('\n')
  } catch (err) {
    return `Duplicate failed: ${err instanceof Error ? err.message : 'unknown error'}`
  }
}

async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const { actorEmail } = ctx
  if (name === 'query_cards') return executeQueryCards(input as QueryCardsInput)
  if (name === 'get_board_summary') return executeGetBoardSummary(input as GetBoardSummaryInput)
  if (name === 'create_card') return executeCreateCard(input as unknown as CreateCardInput, actorEmail)
  if (name === 'update_card') return executeUpdateCard(input as unknown as UpdateCardInput, actorEmail)
  if (name === 'add_card_note') return executeAddCardNote(input as unknown as AddCardNoteInput, actorEmail)
  if (name === 'duplicate_cards') return executeDuplicateCards(input as unknown as DuplicateCardsInput, ctx)
  return `Unknown tool: ${name}`
}

export async function POST(req: Request) {
  const supabaseAuth = await createClient()
  const { data: { user } } = await supabaseAuth.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const requestStartedAt = Date.now()
  // Brenda's tools read every client's cards and write with the service-role
  // client, so only staff get them. A client-portal account can still chat
  // (creative feedback on what it's shown) but gets no board data and no writes.
  const isStaff = await isStaffUser()

  const { messages, userFullName, userEmail, cardContext } = await req.json() as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
    userFullName?: string
    userEmail?: string
    cardContext?: CardContext
  }

  const firstName = userFullName?.split(' ')[0] || userEmail?.split('@')[0] || ''
  const userContext = firstName
    ? `\n\nThe person you are helping right now is ${userFullName || firstName} (${userEmail}). Address them by first name (${firstName}) when it feels natural.`
    : ''

  // Fetch brand context from Box PDF and/or website concurrently, then merge
  let brandContext: string | null = null
  let brandSource: string | null = null

  const [boxResult, webResult] = await Promise.all([
    cardContext?.boxBrandFileId
      ? getBoxToken().then((t) => extractBrandContext(cardContext.boxBrandFileId!, t)).catch(() => null)
      : Promise.resolve(null),
    cardContext?.brandWebsiteUrl
      ? extractBrandFromWebsite(cardContext.brandWebsiteUrl).catch(() => null)
      : Promise.resolve(null),
  ])

  const brandParts: string[] = []
  if (boxResult) { brandParts.push(`[Brand Guide PDF]\n${boxResult}`); brandSource = 'box PDF' }
  if (webResult) { brandParts.push(`[Live Website Brand Tokens]\n${webResult}`); brandSource = brandSource ? 'box PDF + website' : 'website' }
  if (brandParts.length) brandContext = brandParts.join('\n\n')

  if (!brandContext && cardContext?.brandNotes) {
    brandContext = cardContext.brandNotes
    brandSource = 'manual notes'
  }

  // For GIF previews, extract the last frame so Claude sees the final state of the animation
  const previewUrl = cardContext?.previewImageUrl ?? null
  const isGif = previewUrl?.toLowerCase().includes('.gif') ?? false
  const gifLastFrameB64 = isGif ? await getGifLastFrame(previewUrl!) : null

  const hasImage = !!previewUrl
  type AnthropicMessage = Parameters<typeof client.messages.stream>[0]['messages'][number]
  const contextMessages: AnthropicMessage[] = []

  if (cardContext) {
    const parts: string[] = [`Card: "${cardContext.title}"`]
    if (cardContext.mediaType)         parts.push(`Type: ${cardContext.mediaType}`)
    if (cardContext.clientName)        parts.push(`Client: ${cardContext.clientName}`)
    if (cardContext.fbHeadline)        parts.push(`Headline: "${cardContext.fbHeadline}"`)
    if (cardContext.fbBodyText)        parts.push(`Body copy: "${cardContext.fbBodyText}"`)
    if (cardContext.fbLinkDescription) parts.push(`Link description: "${cardContext.fbLinkDescription}"`)
    if (cardContext.creativeBrief)     parts.push(`Brief: "${cardContext.creativeBrief}"`)
    if (isGif)                        parts.push(`Note: This is an animated GIF display ad. You are seeing the final frame (the completed state after all animation has finished).`)
    if (brandContext)                  parts.push(`\nClient brand guidelines (source: ${brandSource ?? 'unknown'}):\n${brandContext}`)
    else if (cardContext.clientName)   parts.push(`\nNote: No brand guidelines found for ${cardContext.clientName}. Evaluate based on general best practices and flag that brand guidelines should be added.`)

    if (hasImage) {
      const imageSource = gifLastFrameB64
        ? { type: 'base64' as const, media_type: 'image/png' as const, data: gifLastFrameB64 }
        : { type: 'url' as const, url: previewUrl! }
      contextMessages.push({
        role: 'user',
        content: [
          { type: 'image', source: imageSource },
          { type: 'text', text: `Here is the ad creative I'm working on.\n${parts.join('\n')}` },
        ],
      })
    } else {
      contextMessages.push({
        role: 'user',
        content: `Here is the card I'm working on.\n${parts.join('\n')}`,
      })
    }
    contextMessages.push({
      role: 'assistant',
      content: `Got it — I can see the creative for "${cardContext.title}"${cardContext.clientName ? ` (${cardContext.clientName})` : ''}. What would you like to know?`,
    })
  }

  const model = hasImage ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'
  const encoder = new TextEncoder()

  const readable = new ReadableStream({
    async start(controller) {
      // Accumulated token counts across all turns in the tool-use loop
      let totalInputTokens = 0
      let totalOutputTokens = 0

      // The message history for the tool-use loop — may grow if Claude calls tools
      const loopMessages: Anthropic.MessageParam[] = [...contextMessages, ...messages]

      // Tool-use agentic loop (max 3 tool calls to prevent runaway)
      for (let turn = 0; turn < 4; turn++) {
        const stream = client.messages.stream({
          model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT + userContext,
          messages: loopMessages,
          // Offer data + write tools when there's no image (haiku handles data/write; sonnet handles vision)
          ...(!hasImage && isStaff ? { tools: [...DATA_TOOLS, ...WRITE_TOOLS] } : {}),
        })

        const toolUseBlocks: Anthropic.ToolUseBlock[] = []

        for await (const chunk of stream) {
          if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(chunk.delta.text))
          }
        }

        const finalMsg = await stream.finalMessage()
        totalInputTokens += finalMsg.usage.input_tokens
        totalOutputTokens += finalMsg.usage.output_tokens

        // Collect any tool_use blocks from the response
        for (const block of finalMsg.content) {
          if (block.type === 'tool_use') toolUseBlocks.push(block)
        }

        // If no tool calls, we're done — stream ended naturally
        if (toolUseBlocks.length === 0 || finalMsg.stop_reason !== 'tool_use') break

        // Execute each tool and collect results
        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const tb of toolUseBlocks) {
          const result = await executeTool(tb.name, tb.input as Record<string, unknown>, { actorEmail: userEmail ?? user.email ?? '', userId: user.id, requestStartedAt })
          toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: result })
        }

        // Append the assistant turn and tool results for the next loop iteration
        loopMessages.push({ role: 'assistant', content: finalMsg.content })
        loopMessages.push({ role: 'user', content: toolResults })

        // Any assistant text before the tool call was already streamed above.
        // The next iteration will stream the follow-up response.
      }

      const usageSentinel = `\x00${JSON.stringify({
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        model: hasImage ? 'sonnet' : 'haiku',
      })}`
      controller.enqueue(encoder.encode(usageSentinel))
      controller.close()
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
