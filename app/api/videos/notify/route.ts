// POST /api/videos/notify
//
// Best-effort Slack notification for video proofing events. Called from the
// client after a successful insert/update. Never blocks the main flow.
//
// Body: { event: 'new_version' | 'comment' | 'internal_approved' | 'client_approved',
//         projectId, versionId?, ... }

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  notifyNewVersion,
  notifyNewComment,
  notifyInternalApproved,
  notifyClientApproved,
} from '@/lib/slack'

export const runtime = 'nodejs'

async function resolveProjectInfo(projectId: string) {
  const supabase = await createClient()
  const { data: project } = await supabase
    .from('video_projects')
    .select('id, title, share_token, client_id, clients(name)')
    .eq('id', projectId)
    .maybeSingle<{
      id: string
      title: string
      share_token: string
      client_id: string | null
      clients: { name: string } | null
    }>()
  if (!project) return null
  return {
    title: project.title,
    clientName: project.clients?.name ?? null,
    internalUrl: `/videos/${project.id}`,
    externalUrl: `/videos/review/${project.share_token}`,
  }
}

function absoluteUrl(pathOrUrl: string, req: Request): string {
  try {
    return new URL(pathOrUrl, req.url).toString()
  } catch {
    return pathOrUrl
  }
}

async function versionNumberFor(versionId: string): Promise<number | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('video_versions')
    .select('version_number')
    .eq('id', versionId)
    .maybeSingle()
  return data?.version_number ?? null
}

export async function POST(req: Request) {
  try {
    const payload = await req.json()
    const { event, projectId, versionId } = payload ?? {}
    if (!event || !projectId) {
      return NextResponse.json({ ok: false, error: 'missing event or projectId' }, { status: 400 })
    }

    const info = await resolveProjectInfo(projectId)
    if (!info) return NextResponse.json({ ok: false, error: 'project not found' }, { status: 404 })

    const viewUrl = absoluteUrl(info.internalUrl, req)

    if (event === 'new_version') {
      await notifyNewVersion({
        projectTitle: info.title,
        versionNumber: Number(payload.versionNumber) || 0,
        clientName: info.clientName,
        uploadedBy: payload.uploadedBy ?? null,
        viewUrl,
      })
    } else if (event === 'comment') {
      const vn = versionId ? await versionNumberFor(versionId) : null
      await notifyNewComment({
        projectTitle: info.title,
        versionNumber: vn ?? 0,
        authorName: payload.authorName ?? 'Anonymous',
        authorKind: payload.authorKind === 'client' ? 'client' : 'internal',
        timestampSec: payload.timestampSec ?? null,
        body: String(payload.body ?? ''),
        viewUrl,
      })
    } else if (event === 'internal_approved') {
      const vn = versionId ? await versionNumberFor(versionId) : null
      await notifyInternalApproved({
        projectTitle: info.title,
        versionNumber: vn ?? 0,
        approverName: payload.approverName ?? 'Internal',
        viewUrl,
      })
    } else if (event === 'client_approved') {
      const vn = versionId ? await versionNumberFor(versionId) : null
      await notifyClientApproved({
        projectTitle: info.title,
        versionNumber: vn ?? 0,
        approverName: payload.approverName ?? 'Client',
        clientName: info.clientName,
        viewUrl,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('notify route error', err)
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
