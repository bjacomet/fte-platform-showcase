import { createAdminClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { clientFacingFiles } from '@/lib/adviewerFiles'
import PreviewClient from './PreviewClient'
import type { AdviewerToken } from '@/types'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ token: string }>
}

export default async function AdviewerPreviewPage({ params }: Props) {
  const { token } = await params
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('adviewer_tokens')
    .select(`
      id, token, title, status, client_notes, created_at, updated_at, card_id, client_id,
      card:cards(
        id, title, media_type, client_id, preview_image_url,
        fb_page_name, fb_body_text, fb_headline, fb_link_description, fb_cta,
        landing_page_url, adpiler_preview_url,
        card_files(id, file_name, file_url, file_type, dimensions, created_at),
        carousel_slides(id, position, image_url, headline, link_description, landing_page_url)
      ),
      client:clients(id, name, fb_page_logo_url)
    `)
    .eq('token', token)
    .single()

  if (error || !data) {
    notFound()
  }

  // Legacy per-card link: same client-facing file rule as the campaign review
  // page (lib/adviewerFiles.ts), so source photos and logos stay on the board.
  const card = (data as { card?: { media_type?: string | null; preview_image_url?: string | null; card_files?: { file_name: string; file_url: string; file_type: string | null; created_at?: string }[] } | null }).card
  const tokenData = card?.card_files?.length
    ? { ...data, card: { ...card, card_files: clientFacingFiles(card.card_files, card.media_type, card.preview_image_url) } }
    : data

  return <PreviewClient tokenData={tokenData as unknown as AdviewerToken} />
}
