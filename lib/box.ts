import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server'

const BOX_TOKEN_URL = 'https://api.box.com/oauth2/token'
const BOX_API = 'https://api.box.com/2.0'

export interface BoxFile {
  id: string
  name: string
  type: 'file' | 'folder'
  size: number
}

/**
 * Retrieve a valid Box access token, refreshing if expired.
 *
 * `force` refreshes even when the access token is still valid. That is what the
 * keep-alive cron (/api/box/keepalive) needs: Box revokes a refresh token after
 * 60 days without use, and a lazy refresh only happens when someone touches a
 * Box feature, so a quiet stretch silently disconnects every Box path at once.
 * Reads use the admin client by default: app_settings is not readable by
 * signed-in users for secret keys (supabase/restrict_app_settings_reads.sql),
 * so a token read must never depend on who is asking. Every caller is a
 * server route that has already checked the session.
 */
export async function getBoxToken(
  opts: { supabase?: SupabaseClient; force?: boolean } = {},
): Promise<string> {
  const supabase = opts.supabase ?? createAdminClient()

  const { data: rows, error: readErr } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', ['box_access_token', 'box_refresh_token', 'box_token_expires_at'])

  if (readErr) throw new Error(`Box token read failed: ${readErr.message}`)

  const settings = Object.fromEntries((rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]))

  const accessToken = settings['box_access_token']
  const refreshToken = settings['box_refresh_token']
  const expiresAt = settings['box_token_expires_at']

  if (!accessToken || !refreshToken) {
    throw new Error('Box not connected. Visit /settings to connect your Box account.')
  }

  // Refresh if within 5 minutes of expiry
  const expiry = expiresAt ? new Date(expiresAt).getTime() : 0
  if (!opts.force && Date.now() < expiry - 5 * 60 * 1000) {
    return accessToken
  }

  const res = await fetch(BOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.BOX_CLIENT_ID!,
      client_secret: process.env.BOX_CLIENT_SECRET!,
    }),
  })

  if (!res.ok) {
    throw new Error(`Box token refresh failed: ${res.status} ${await res.text()}`)
  }

  const json = await res.json()
  const newExpiry = new Date(Date.now() + json.expires_in * 1000).toISOString()
  const now = new Date().toISOString()

  // Box rotates the refresh token on every refresh and the old one stops working,
  // so a write that fails here is not cosmetic: the only valid refresh token would
  // exist nowhere but this response. Surface it instead of returning success.
  // Written with the admin client: app_settings writes are is_admin()-only under
  // RLS, so a staff user's session would be refused here — after Box has already
  // rotated the token — and disconnect Box for everyone.
  const { error: writeErr } = await createAdminClient().from('app_settings').upsert([
    { key: 'box_access_token', value: json.access_token, updated_at: now },
    { key: 'box_refresh_token', value: json.refresh_token, updated_at: now },
    { key: 'box_token_expires_at', value: newExpiry, updated_at: now },
  ])
  if (writeErr) throw new Error(`Box token refreshed but not saved — reconnect Box in Settings: ${writeErr.message}`)

  return json.access_token as string
}

/**
 * List every item in a Box folder — files AND subfolders — following pagination.
 *
 * Box caps `limit` at 1000 per page, so a single request silently truncates a
 * larger folder. Walking a tree (see lib/atlasBoxSync.ts) needs the folder entries
 * too, which `listFolderFiles` filters out.
 */
export async function listFolderItems(folderId: string, token: string): Promise<BoxFile[]> {
  const out: BoxFile[] = []
  const limit = 1000
  let offset = 0

  for (;;) {
    const res = await fetch(
      `${BOX_API}/folders/${folderId}/items?limit=${limit}&offset=${offset}&fields=id,name,type,size`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`Box folder list failed: ${res.status} (folder ${folderId})`)
    const json = (await res.json()) as { entries?: BoxFile[]; total_count?: number }
    const entries = json.entries ?? []
    out.push(...entries)
    // Stop on a short/empty page, or once we've seen everything Box says exists.
    if (entries.length === 0 || entries.length < limit) break
    offset += entries.length
    if (typeof json.total_count === 'number' && out.length >= json.total_count) break
  }

  return out
}

/** List all files in a Box folder (subfolders excluded). */
export async function listFolderFiles(folderId: string, token: string): Promise<BoxFile[]> {
  const items = await listFolderItems(folderId, token)
  return items.filter((e) => e.type === 'file')
}

/** Download a Box file and return the Response (streamable). */
export async function downloadFile(fileId: string, token: string): Promise<Response> {
  const res = await fetch(`${BOX_API}/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Box file download failed: ${res.status}`)
  return res
}

/** Parse a Box folder URL and return the folder ID. */
export function parseFolderUrl(url: string): string | null {
  const match = url.match(/box\.com\/(?:folder\/|s\/)(\d+)/)
  return match?.[1] ?? null
}

/**
 * Download a Box file by ID, parse it as a PDF, and return its text content.
 * Returns null if the file can't be read. Max 15,000 chars.
 */
export async function extractBrandContext(fileId: string, token: string): Promise<string | null> {
  try {
    const fileRes = await downloadFile(fileId, token)
    const buffer = Buffer.from(await fileRes.arrayBuffer())

    // Dynamically import pdf-parse (CommonJS module) to avoid Next.js edge runtime issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>
    const { text } = await pdfParse(buffer)

    return text.trim().slice(0, 15000) || null
  } catch {
    return null
  }
}

/** Check if Box is connected (token exists in app_settings). */
export async function isBoxConnected(): Promise<boolean> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'box_access_token')
    .single()
  return !!data?.value
}
