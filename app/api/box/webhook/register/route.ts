import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/writers'
import { getBoxToken } from '@/lib/box'

const BOX_API = 'https://api.box.com/2.0'

interface BoxWebhookResponse {
  id: string
  type: 'webhook'
  target: { id: string; type: string }
  address: string
  triggers: string[]
  created_at: string
}

interface BoxWebhookError {
  type: 'error'
  status: number
  code: string
  message: string
}

/**
 * POST /api/box/webhook/register
 *
 * Registers a Box webhook on the root "Client Projects" folder so that
 * FILE.UPLOADED events anywhere in the folder tree fire our webhook handler.
 *
 * Body: { rootFolderId: string }
 *
 * Stores the webhook ID and root folder ID in app_settings:
 *   box_root_folder_id — the folder being watched
 *   box_webhook_id     — the Box-assigned webhook ID
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isAdminEmail(user.email)) return NextResponse.json({ error: 'Forbidden — admin access only' }, { status: 403 })

  const body = await req.json() as { rootFolderId?: string }
  const rootFolderId = body.rootFolderId?.trim()
  if (!rootFolderId) {
    return NextResponse.json({ error: 'Missing rootFolderId' }, { status: 400 })
  }

  let token: string
  try {
    token = await getBoxToken()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Box not connected' },
      { status: 503 }
    )
  }

  // Build the absolute URL to our webhook handler
  const host = req.headers.get('host') ?? ''
  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const webhookUrl = `${proto}://${host}/api/box/webhook`

  // Register the webhook with Box
  const boxRes = await fetch(`${BOX_API}/webhooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      target: { id: rootFolderId, type: 'folder' },
      address: webhookUrl,
      triggers: ['FILE.UPLOADED'],
    }),
  })

  const boxData = await boxRes.json() as BoxWebhookResponse | BoxWebhookError

  if (!boxRes.ok) {
    const err = boxData as BoxWebhookError
    return NextResponse.json(
      { error: `Box API error: ${err.message ?? boxRes.status}` },
      { status: 502 }
    )
  }

  const webhook = boxData as BoxWebhookResponse

  // Persist in app_settings
  const admin = createAdminClient()
  const now = new Date().toISOString()

  await Promise.all([
    admin.from('app_settings').upsert({ key: 'box_root_folder_id', value: rootFolderId, updated_at: now }),
    admin.from('app_settings').upsert({ key: 'box_webhook_id', value: webhook.id, updated_at: now }),
  ])

  return NextResponse.json({
    webhookId: webhook.id,
    target: webhook.target,
    address: webhook.address,
    triggers: webhook.triggers,
  })
}
