import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { VIDEO_DESIGNER_KEY, parseDesigner } from '@/lib/designers'
import { CONTACTS_KEY } from '@/lib/locationContacts'

/**
 * Staff edits to the two app_settings keys staff own. RLS keeps app_settings
 * writes admin-only (it also holds integration tokens), so the browser can't
 * write these directly; this route checks requireWriter() and writes with the
 * service-role client. Only the keys below are accepted — tokens and other
 * platform config stay admin-only via their own routes.
 *
 * Every response says what actually happened, so the UI never shows "saved"
 * when the write didn't land.
 */

const MAX_VALUE_BYTES = 512 * 1024

const isString = (v: unknown): v is string => typeof v === 'string'

// Shape checks match what the readers assume (Board.tsx calls email.toLowerCase(),
// buildContactsCsv normalizes every row's location), so a hand-made request
// can't store a value that crashes the Board or Atlas pages for everyone.
const VALIDATORS: Record<string, (value: unknown) => string | null> = {
  [VIDEO_DESIGNER_KEY]: (v) => {
    const d = isString(v) ? parseDesigner(v) : null
    return d && isString(d.name) && isString(d.email) ? null : 'Expected a designer with a name and email.'
  },
  [CONTACTS_KEY]: (v) => {
    if (!isString(v)) return 'Expected the contact list as JSON.'
    try {
      const parsed = JSON.parse(v) as { rows?: unknown; fileName?: unknown; uploadedAt?: unknown }
      if (!Array.isArray(parsed.rows)) return 'Contact list has no rows.'
      if (!isString(parsed.fileName) || !isString(parsed.uploadedAt)) return 'Contact list is missing its file name or upload time.'
      const ok = parsed.rows.every((r) => {
        const row = r as Record<string, unknown> | null
        return !!row && typeof row === 'object' && isString(row.location) && isString(row.name) && isString(row.email)
      })
      return ok ? null : 'Every contact needs a location, name and email.'
    } catch {
      return 'Contact list is not valid JSON.'
    }
  },
}

async function guard(key: string): Promise<NextResponse | null> {
  const denied = await requireWriter()
  if (denied) return denied
  if (!Object.hasOwn(VALIDATORS, key)) {
    return NextResponse.json({ error: 'That setting can only be changed by an admin.' }, { status: 403 })
  }
  return null
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const denied = await guard(key)
  if (denied) return denied

  // Reject oversized bodies before parsing them.
  const raw = await req.text()
  if (new TextEncoder().encode(raw).length > MAX_VALUE_BYTES + 1024) {
    return NextResponse.json({ error: 'That is too large to store.' }, { status: 413 })
  }
  let body: { value?: unknown } | null = null
  try { body = JSON.parse(raw) as { value?: unknown } } catch { body = null }
  const value = body?.value
  const invalid = VALIDATORS[key](value)
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 })
  if (new TextEncoder().encode(value as string).length > MAX_VALUE_BYTES) {
    return NextResponse.json({ error: 'That is too large to store.' }, { status: 413 })
  }

  const { data, error } = await createAdminClient()
    .from('app_settings')
    .upsert({ key, value: value as string, updated_at: new Date().toISOString() })
    .select('key')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: 'Nothing was saved.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const denied = await guard(key)
  if (denied) return denied

  const { error } = await createAdminClient().from('app_settings').delete().eq('key', key)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // Deleting a key that's already gone is the state the user asked for.
  return NextResponse.json({ ok: true })
}
