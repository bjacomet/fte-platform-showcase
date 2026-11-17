import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireWriter } from '@/lib/writers'
import { getBoxToken, downloadFile } from '@/lib/box'
import { getOrCreateFolderSharedLink } from '@/lib/boxSharedLink'
import { isAtlasAttachableFile } from '@/lib/atlasBoxSync'
import { snapshotCardFileRound } from '@/lib/adviewerHistory'

export const maxDuration = 300

interface ApplyAssignment {
  rowKey: string
  /** The Social Build folder. Null on a row that exists only for its Display build. */
  buildFolderId: string | null
  /** Square MP4 to attach; null when the row only carries links. */
  boxFileId: string | null
  fileName: string | null
  /** The Banner Ads Build folder, when the row has one. */
  displayFolderId: string | null
  cardIds: string[]
  /** Overwrite a card's existing link when it differs. Off = keep it and report. */
  replaceLinks?: boolean
}

type LinkOutcome = 'filled' | 'replaced' | 'unchanged' | 'kept'

interface ApplyResult {
  rowKey: string
  cardId: string
  ok: boolean
  error?: string
  social?: LinkOutcome
  display?: LinkOutcome
}

/** What to do with a card's existing link when the folder's link arrives. */
function linkOutcome(current: string | null, next: string, replace: boolean): LinkOutcome {
  const cur = current?.trim() || ''
  if (!cur) return 'filled'
  if (cur === next) return 'unchanged'
  return replace ? 'replaced' : 'kept'
}

/**
 * POST — attach confirmed Box creatives to Atlas cards.
 *
 * Only ever called from the Atlas confirm screen with assignments the user has
 * reviewed: the server does not re-derive matches, it applies what was approved.
 *
 * Per card it uploads the MP4 (when the row has one), replaces any
 * same-base-name card_files row, logs the activity, and sets
 * cards.box_folder_id to the Build folder so the Box webhook owns future
 * revisions (see docs/features/box-integration.md — that auto-sync is dormant
 * until the webhook is re-registered).
 *
 * It also stores each Build folder's Box shared link on the card — build_link
 * (Social) and display_build_link (Banner Ads). The link is the folder's
 * existing one, or a new one created the way Box's "Copy link" does it. A card's
 * existing, different link is kept unless the row says to replace it.
 *
 * One build may legitimately fan out to several cards (the ScanCo centres
 * share one video), so the file is downloaded once and stored once per card.
 */
export async function POST(req: Request) {
  const denied = await requireWriter()
  if (denied) return denied

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let body: { assignments?: ApplyAssignment[] }
  try {
    body = (await req.json()) as { assignments?: ApplyAssignment[] }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const assignments = (body.assignments ?? []).filter(
    (a) =>
      a?.rowKey &&
      (a.buildFolderId || a.displayFolderId) &&
      Array.isArray(a.cardIds) && a.cardIds.length > 0 &&
      // A file is all-or-nothing: id and name together, or neither.
      !!a.boxFileId === !!a.fileName,
  )
  if (assignments.length === 0) {
    return NextResponse.json({ error: 'No assignments to apply' }, { status: 400 })
  }

  // Server-side restatement of the shape rule: a vertical story render or a PNG
  // must never reach a card, whatever the client posts.
  const offShape = assignments.filter((a) => a.fileName && !isAtlasAttachableFile(a.fileName))
  if (offShape.length > 0) {
    return NextResponse.json(
      { error: `Only square MP4s may be attached — refused: ${offShape.map((a) => a.fileName).join(', ')}` },
      { status: 400 },
    )
  }

  let token: string
  try {
    token = await getBoxToken()
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Box not connected' }, { status: 503 })
  }

  const admin = createAdminClient()

  // Every targeted card must be a live Atlas social card — never write to anything else.
  const allCardIds = [...new Set(assignments.flatMap((a) => a.cardIds))]
  const { data: cardRows } = await admin
    .from('cards')
    .select('id, title, atlas_location_id, archived, media_type, build_link, display_build_link')
    .in('id', allCardIds)

  type CardRow = {
    id: string; title: string; atlas_location_id: string | null; archived: boolean; media_type: string | null
    build_link: string | null; display_build_link: string | null
  }
  const validCards = new Map(
    ((cardRows ?? []) as CardRow[])
      .filter((c) => c.atlas_location_id !== null && !c.archived && c.media_type === 'Social Ad Request')
      .map((c) => [c.id, c]),
  )

  const results: ApplyResult[] = []
  const links = { created: 0, reused: 0 }

  for (const assignment of assignments) {
    const fail = (error: string, ids: string[] = assignment.cardIds) => {
      for (const cardId of ids) results.push({ rowKey: assignment.rowKey, cardId, ok: false, error })
    }

    // The folders' shared links first, once per folder (a ScanCo build fans out to
    // several cards but has one link). A failed link must not stop the attach — it
    // is reported on the cards instead.
    const folderLink = async (folderId: string | null): Promise<{ url: string | null; error: string | null }> => {
      if (!folderId) return { url: null, error: null }
      try {
        const l = await getOrCreateFolderSharedLink(folderId, token)
        if (l.created) links.created += 1
        else links.reused += 1
        return { url: l.url, error: null }
      } catch (e) {
        return { url: null, error: e instanceof Error ? e.message : 'Box shared link failed' }
      }
    }
    const social = await folderLink(assignment.buildFolderId)
    const display = await folderLink(assignment.displayFolderId)
    const linkError = social.error ?? display.error

    let fileBuffer: Buffer | null = null
    if (assignment.boxFileId) {
      try {
        const res = await downloadFile(assignment.boxFileId, token)
        fileBuffer = Buffer.from(await res.arrayBuffer())
      } catch (e) {
        fail(e instanceof Error ? e.message : 'Box download failed')
        continue
      }
    }

    const baseName = assignment.fileName?.replace(/\.[^.]+$/, '') ?? null

    for (const cardId of assignment.cardIds) {
      const card = validCards.get(cardId)
      if (!card) {
        fail('Not a live Atlas social card', [cardId])
        continue
      }

      if (fileBuffer && assignment.fileName && baseName) {
        const path = `cards/${cardId}/box_sync_${Date.now()}_${assignment.fileName}`
        const { error: uploadError } = await admin.storage
          .from('creative-files')
          .upload(path, fileBuffer, { contentType: 'video/mp4', upsert: true })

        if (uploadError) {
          fail(uploadError.message, [cardId])
          continue
        }

        // Replace any earlier row for the same creative so re-applying can't
        // stack duplicates. Mirrors the Box webhook's base-name replace, including
        // freezing any Adviewer round anchored to the outgoing file.
        const { data: existing } = await admin
          .from('card_files')
          .select('id, file_name, dimensions')
          .eq('card_id', cardId)

        type StaleFile = { id: string; file_name: string; dimensions: string | null }
        const stale = ((existing ?? []) as StaleFile[]).filter(
          (f) => f.file_name.replace(/\.[^.]+$/, '') === baseName,
        )
        for (const sf of stale) {
          try {
            await snapshotCardFileRound(admin, {
              cardId,
              fileId: sf.id,
              fileName: sf.file_name,
              dimensions: sf.dimensions,
              thumbUrl: null,
            })
          } catch { /* best-effort — never block the attach */ }
        }
        if (stale.length > 0) {
          await admin.from('card_files').delete().in('id', stale.map((f) => f.id))
        }

        const { error: insertError } = await admin.from('card_files').insert({
          card_id: cardId,
          file_name: assignment.fileName,
          file_url: path,
          file_type: 'video/mp4',
          approval_status: 'pending',
        })

        if (insertError) {
          fail(insertError.message, [cardId])
          continue
        }
      }

      // Hand future revisions of this creative to the Box webhook, and store the
      // folders' shared links for the Copy Plan sheet and Download all builds.
      const update: Record<string, string> = { updated_at: new Date().toISOString() }
      if (assignment.buildFolderId) update.box_folder_id = assignment.buildFolderId
      let socialOutcome: LinkOutcome | undefined
      let displayOutcome: LinkOutcome | undefined
      if (social.url) {
        socialOutcome = linkOutcome(card.build_link, social.url, !!assignment.replaceLinks)
        if (socialOutcome === 'filled' || socialOutcome === 'replaced') update.build_link = social.url
      }
      if (display.url) {
        displayOutcome = linkOutcome(card.display_build_link, display.url, !!assignment.replaceLinks)
        if (displayOutcome === 'filled' || displayOutcome === 'replaced') update.display_build_link = display.url
      }

      const { error: cardError } = await admin.from('cards').update(update).eq('id', cardId)
      if (cardError) {
        fail(cardError.message, [cardId])
        continue
      }
      // Later rows in this same request compare against what was just written,
      // so two rows aimed at one card can't silently overwrite each other.
      if (update.build_link) card.build_link = update.build_link
      if (update.display_build_link) card.display_build_link = update.display_build_link

      const did: string[] = []
      if (assignment.fileName) did.push(`attached ${assignment.fileName} from Box`)
      if (assignment.buildFolderId) did.push('linked the Build folder')
      if (update.build_link) did.push(`${socialOutcome} the Social build link`)
      if (update.display_build_link) did.push(`${displayOutcome} the Display build link`)
      await admin.from('card_activity').insert({
        card_id: cardId,
        actor: user?.email ?? 'Atlas Box sync',
        actor_email: user?.email ?? null,
        action: 'updated',
        detail: did.join(', '),
      })

      results.push(
        linkError
          ? { rowKey: assignment.rowKey, cardId, ok: false, error: `Saved, but a link failed: ${linkError}`, social: socialOutcome, display: displayOutcome }
          : { rowKey: assignment.rowKey, cardId, ok: true, social: socialOutcome, display: displayOutcome },
      )
    }
  }

  return NextResponse.json({
    applied: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    links,
    results,
  })
}
