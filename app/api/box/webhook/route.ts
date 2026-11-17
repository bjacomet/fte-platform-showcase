import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getBoxToken } from '@/lib/box'
import { isAtlasAttachableFile } from '@/lib/atlasBoxSync'
import { snapshotCardFileRound, snapshotCardPinRound } from '@/lib/adviewerHistory'
import crypto from 'crypto'

const BOX_API = 'https://api.box.com/2.0'

const MIME_MAP: Record<string, string> = {
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

interface BoxWebhookPayload {
  trigger: string
  source: {
    id: string
    name: string
    type: string
    parent: {
      id: string
      name: string
      type: string
    }
  }
}

function verifySignature(key: string, timestamp: string, body: string, signature: string): boolean {
  try {
    const hmac = crypto.createHmac('sha256', key)
    hmac.update(timestamp + body)
    const expected = Buffer.from(hmac.digest('base64'))
    const received = Buffer.from(signature)
    if (expected.length !== received.length) return false
    return crypto.timingSafeEqual(expected, received)
  } catch {
    return false
  }
}

/**
 * GET — Box webhook challenge verification.
 * During webhook registration Box sends a GET with ?challenge=<value>.
 * We must respond 200 with the challenge value as plain text.
 */
export async function GET(req: NextRequest) {
  const challenge = req.nextUrl.searchParams.get('challenge')
  if (challenge) {
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

/**
 * POST — Box webhook event handler.
 *
 * Processes FILE.UPLOADED events:
 * 1. Verifies Box HMAC-SHA256 signature
 * 2. Finds EVERY card whose box_folder_id matches the file's parent folder — one
 *    Build folder may feed several cards (the ScanCo centres share one video)
 * 3. Skips non-square renders for Atlas cards (story/PNG siblings never attach)
 * 4. Downloads the new file from Box once
 * 5. Per card: uploads to Supabase Storage and replaces the matching card_files
 *    row (delete old base-name match, insert new)
 * 6. Updates matching adviewer_campaign_files rows in place (keeps pins, resets status → pending)
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const timestamp = req.headers.get('box-delivery-timestamp') ?? ''
  const signaturePrimary = req.headers.get('box-signature-primary') ?? ''
  const signatureSecondary = req.headers.get('box-signature-secondary') ?? ''

  const primaryKey = process.env.BOX_WEBHOOK_SIGNATURE_KEY ?? ''
  const secondaryKey = process.env.BOX_WEBHOOK_SIGNATURE_KEY_SECONDARY ?? ''

  if (!primaryKey) {
    return NextResponse.json({ error: 'Webhook signature key not configured' }, { status: 503 })
  }

  const validPrimary = signaturePrimary && verifySignature(primaryKey, timestamp, rawBody, signaturePrimary)
  const validSecondary = secondaryKey && signatureSecondary && verifySignature(secondaryKey, timestamp, rawBody, signatureSecondary)

  if (!validPrimary && !validSecondary) {
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 })
  }

  let payload: BoxWebhookPayload
  try {
    payload = JSON.parse(rawBody) as BoxWebhookPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  // Only handle file uploads — ignore everything else
  if (payload.trigger !== 'FILE.UPLOADED') {
    return NextResponse.json({ ok: true })
  }

  const buildFolderId = payload.source?.parent?.id
  const newFileName = payload.source?.name
  const boxFileId = payload.source?.id

  if (!buildFolderId || !newFileName || !boxFileId || payload.source?.type !== 'file') {
    return NextResponse.json({ ok: true })
  }

  // Skip non-creative files (PSD, AI, etc.) — only process Build outputs
  const ext = newFileName.split('.').pop()?.toLowerCase() ?? ''
  const mimeType = MIME_MAP[ext]
  if (!mimeType) {
    return NextResponse.json({ ok: true })
  }

  const admin = createAdminClient()

  // Find every card whose Build folder matches.
  //
  // This is a multi-row select on purpose. It used to be `.maybeSingle()`, which
  // ERRORS when more than one row matches — so `card` came back null and the
  // handler returned {ok:true} having silently done nothing. The Atlas sync points
  // several cards at one Build folder by design (the ScanCo centres share one
  // video), and that shape would have failed with no error, no log and no file.
  const { data: cards } = await admin
    .from('cards')
    .select('id, atlas_location_id')
    .eq('box_folder_id', buildFolderId)

  type MatchedCard = { id: string; atlas_location_id: string | null }
  const matchedCards = (cards ?? []) as MatchedCard[]

  if (matchedCards.length === 0) {
    return NextResponse.json({ ok: true }) // Not one of our cards
  }

  // Atlas social creatives come in three renders per build and only the square MP4
  // may be attached (see lib/atlasBoxSync.ts). The filter is scoped to Atlas cards:
  // every other client's display banners are non-square by nature and must keep
  // syncing exactly as before.
  const atlasCards = matchedCards.filter((c) => c.atlas_location_id !== null)
  const targetCards = isAtlasAttachableFile(newFileName)
    ? matchedCards
    : matchedCards.filter((c) => c.atlas_location_id === null)

  if (targetCards.length === 0) {
    // An Atlas story/PNG render — deliberately not attached.
    return NextResponse.json({ ok: true, skipped: 'non-square render for Atlas card(s)', atlasCards: atlasCards.length })
  }

  // Download the new file from Box
  let token: string
  try {
    // No user session on a webhook call — anon can't read app_settings.
    token = await getBoxToken({ supabase: createAdminClient() })
  } catch {
    return NextResponse.json({ error: 'Box not connected' }, { status: 503 })
  }

  const fileRes = await fetch(`${BOX_API}/files/${boxFileId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  })
  if (!fileRes.ok) {
    return NextResponse.json({ error: 'Failed to download file from Box' }, { status: 502 })
  }

  const fileBuffer = Buffer.from(await fileRes.arrayBuffer())
  const baseName = newFileName.replace(/\.[^.]+$/, '')
  const ts = Date.now()

  // One upload can legitimately belong to several cards (ScanCo's shared video), so
  // the file is downloaded once above and the replace runs per card below.
  for (const card of targetCards) {
    // ── card_files: delete old matching row, insert new ──────────────────────
    const cardFilePath = `cards/${card.id}/box_sync_${ts}_${newFileName}`

    const { error: storageError } = await admin.storage
      .from('creative-files')
      .upload(cardFilePath, fileBuffer, { contentType: mimeType, upsert: true })

    if (!storageError) {
      // Find and delete existing card_files with the same base name
      const { data: existingCardFiles } = await admin
        .from('card_files')
        .select('id, file_name, dimensions')
        .eq('card_id', card.id)

      type StaleFile = { id: string; file_name: string; dimensions: string | null }
      const staleFiles = (existingCardFiles ?? [])
        .filter((f: StaleFile) => f.file_name.replace(/\.[^.]+$/, '') === baseName) as StaleFile[]

      if (staleFiles.length > 0) {
        // Freeze any Adviewer change-request round anchored to the outgoing file(s)
        // into history (auto-resolved) before the row is deleted, so per-size pins
        // don't orphan against a now-gone card_files id. No thumbnail on this path.
        for (const sf of staleFiles) {
          await snapshotCardFileRound(admin, {
            cardId: card.id,
            fileId: sf.id,
            fileName: sf.file_name,
            dimensions: sf.dimensions,
            thumbUrl: null,
          })
        }
        await admin.from('card_files').delete().in('id', staleFiles.map((f) => f.id))
      }

      await admin.from('card_files').insert({
        card_id: card.id,
        file_name: newFileName,
        file_url: cardFilePath,
        file_type: mimeType,
        approval_status: 'pending',
      })
    }

    // ── adviewer_campaign_files: update in place (keep pins) ─────────────────
    const { data: campaignLinks } = await admin
      .from('adviewer_campaign_cards')
      .select('campaign_id')
      .eq('card_id', card.id)

    if (campaignLinks && campaignLinks.length > 0) {
      const campaignIds = campaignLinks.map((l: { campaign_id: string }) => l.campaign_id)

      const { data: campaignFiles } = await admin
        .from('adviewer_campaign_files')
        .select('id, campaign_id, file_name, client_notes')
        .in('campaign_id', campaignIds)

      const matchingCampaignFiles = (campaignFiles ?? []).filter(
        (f: { id: string; campaign_id: string; file_name: string; client_notes: unknown }) =>
          f.file_name.replace(/\.[^.]+$/, '') === baseName
      )

      for (const cf of matchingCampaignFiles as { id: string; campaign_id: string; file_name: string; client_notes: unknown }[]) {
        const adviewerPath = `adviewer/${cf.campaign_id}/${ts}-box-${newFileName}`

        const { error: avUploadError } = await admin.storage
          .from('creative-files')
          .upload(adviewerPath, fileBuffer, { contentType: mimeType, upsert: true })

        if (!avUploadError) {
          const { data: urlData } = admin.storage
            .from('creative-files')
            .getPublicUrl(adviewerPath)

          await admin
            .from('adviewer_campaign_files')
            .update({
              file_name: newFileName,
              file_url: urlData.publicUrl,
              status: 'pending',
              updated_at: new Date().toISOString(),
            })
            .eq('id', cf.id)
        }
      }
    }

    // ── carousel_slides: update the slide whose position matches the filename's _NN ──
    // A revised "…_03.png" replaces Slide 3's graphic (position 2, 0-based) in place. Only
    // fires when the card is a carousel with a slide at that position; reuses the file already
    // uploaded above. Non-carousel cards have no slides, so this is a no-op for them.
    if (!storageError) {
      const slideMatch = newFileName.match(/_(\d+)\.[^.]+$/)
      if (slideMatch) {
        const position = parseInt(slideMatch[1], 10) - 1
        const { data: slide } = await admin
          .from('carousel_slides')
          .select('id, image_url')
          .eq('card_id', card.id)
          .eq('position', position)
          .maybeSingle()

        if (slide) {
          const { data: signed } = await admin.storage
            .from('creative-files')
            .createSignedUrl(cardFilePath, 3600 * 24 * 365)
          if (signed?.signedUrl) {
            // Replace lifecycle: the revised graphic supersedes the Adviewer round
            // anchored to this slide — freeze those pins into client_notes.history
            // before the new image_url lands. The old storage file is not deleted
            // here, so its URL doubles as the retained "old graphic" preview.
            if (slide.image_url && slide.image_url !== signed.signedUrl) {
              try {
                await snapshotCardPinRound(admin, {
                  cardId: card.id,
                  slideId: slide.id,
                  label: `Slide ${position + 1}`,
                  thumbUrl: slide.image_url,
                })
              } catch { /* best-effort — never block the sync */ }
            }
            await admin
              .from('carousel_slides')
              .update({ image_url: signed.signedUrl, updated_at: new Date().toISOString() })
              .eq('id', slide.id)
          }
        }
      }
    }
  }

  return NextResponse.json({ ok: true })
}
