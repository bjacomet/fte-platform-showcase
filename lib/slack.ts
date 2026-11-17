// Slack notifications for video proofing events.
//
// Configuration:
//   - Webhook URL is read from the `slack_video_webhook_url` row in `app_settings`.
//   - Absent/empty URL => notifications silently skipped (no-op).
//
// This file only runs on the server (API routes / server actions).

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server'
import type { SlackConnection } from '@/types'

export async function getSlackVideoWebhook(): Promise<string | null> {
  // Admin client: the webhook URL is a secret and app_settings secret keys are
  // not readable by signed-in users (supabase/restrict_app_settings_reads.sql).
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'slack_video_webhook_url')
    .maybeSingle()
  const url = data?.value?.trim()
  return url && url.length > 0 ? url : null
}

/** Post a plain-text message to the Slack webhook. Best-effort. */
export async function postSlackText(text: string): Promise<void> {
  try {
    const webhook = await getSlackVideoWebhook()
    if (!webhook) return
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } catch (err) {
    // Never block the main flow on a notification failure.
    console.error('Slack notify failed:', err)
  }
}

/** Helpers for the four video events the video designer wanted. */
export async function notifyNewVersion(params: {
  projectTitle: string
  versionNumber: number
  clientName: string | null
  uploadedBy: string | null
  viewUrl: string
}): Promise<void> {
  const who = params.uploadedBy ? ` by ${params.uploadedBy}` : ''
  const client = params.clientName ? ` for ${params.clientName}` : ''
  await postSlackText(
    `🎬 *V${params.versionNumber}* uploaded${who} on *${params.projectTitle}*${client}. <${params.viewUrl}|Open proof>`
  )
}

export async function notifyNewComment(params: {
  projectTitle: string
  versionNumber: number
  authorName: string
  authorKind: 'internal' | 'client'
  timestampSec: number | null
  body: string
  viewUrl: string
}): Promise<void> {
  const ts =
    params.timestampSec != null ? ` at ${formatTs(params.timestampSec)}` : ''
  const icon = params.authorKind === 'client' ? '👤' : '💬'
  const preview = params.body.length > 160 ? params.body.slice(0, 157) + '…' : params.body
  await postSlackText(
    `${icon} New comment on *${params.projectTitle}* V${params.versionNumber}${ts} from *${params.authorName}*: "${preview}" <${params.viewUrl}|Open>`
  )
}

export async function notifyInternalApproved(params: {
  projectTitle: string
  versionNumber: number
  approverName: string
  viewUrl: string
}): Promise<void> {
  await postSlackText(
    `✅ *${params.approverName}* approved *${params.projectTitle}* V${params.versionNumber} internally. <${params.viewUrl}|Open>`
  )
}

export async function notifyClientApproved(params: {
  projectTitle: string
  versionNumber: number
  approverName: string
  clientName: string | null
  viewUrl: string
}): Promise<void> {
  const suffix = params.clientName ? ` for *${params.clientName}*` : ''
  await postSlackText(
    `🎉 Client *${params.approverName}* approved *${params.projectTitle}* V${params.versionNumber}${suffix}. <${params.viewUrl}|Open>`
  )
}

function formatTs(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

// ── Per-user DM notifications ──────────────────────────────────────────────
//
// Uses the workspace bot token (SLACK_BOT_TOKEN) to send a DM to a specific
// Slack user. The bot token is installed once to the workspace; each user's
// Slack user ID is stored in slack_connections after they complete OAuth.
//
// Passing a Slack user ID as the `channel` param opens a DM automatically.
// Best-effort — failures are logged but never propagate to the caller.

/**
 * DM every user whose slack_connections row watches the given column
 * (and matches the card's client). Shared by POST /api/slack/notify
 * (board drags) and POST /api/cards/restart (Copy Tracker re-runs), which
 * can't call the HTTP route because session cookies don't forward
 * server-to-server. Best-effort; returns the number of DMs attempted.
 */
export async function notifyColumnWatchers(
  supabase: SupabaseClient,
  params: { cardId: string; columnId: string; clientId: string | null },
): Promise<number> {
  const { cardId, columnId, clientId } = params

  const [{ data: card }, { data: column }] = await Promise.all([
    supabase.from('cards').select('title, client_id').eq('id', cardId).maybeSingle(),
    supabase.from('columns').select('title').eq('id', columnId).maybeSingle(),
  ])
  if (!card || !column) return 0

  const { data: connections } = await supabase
    .from('slack_connections')
    .select('*')
    .contains('watched_columns', [columnId])
  if (!connections || connections.length === 0) return 0

  const cardClientId = clientId ?? card.client_id ?? null

  const targets = (connections as SlackConnection[]).filter((conn) => {
    if (conn.watch_all_clients) return true
    if (!cardClientId) return false
    return conn.watched_clients.includes(cardClientId)
  })
  if (targets.length === 0) return 0

  let clientName: string | null = null
  if (cardClientId) {
    const { data: clientRow } = await supabase
      .from('clients')
      .select('name')
      .eq('id', cardClientId)
      .maybeSingle()
    clientName = clientRow?.name ?? null
  }

  const clientSuffix = clientName ? ` (${clientName})` : ''
  const text = `📋 *${card.title}*${clientSuffix} moved to *${column.title}*`

  await Promise.allSettled(
    targets.map((conn) => sendSlackDM(conn.slack_user_id, text))
  )
  return targets.length
}

/** Send a plain-text Slack DM to a single user. */
export async function sendSlackDM(slackUserId: string, text: string): Promise<void> {
  try {
    const token = process.env.SLACK_BOT_TOKEN?.trim()
    if (!token) return

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel: slackUserId, text }),
    })

    const json = await res.json() as { ok: boolean; error?: string }
    if (!json.ok) {
      console.error('Slack DM failed:', json.error)
    }
  } catch (err) {
    console.error('Slack DM error:', err)
  }
}
