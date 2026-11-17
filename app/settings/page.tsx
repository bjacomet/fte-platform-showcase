import { redirect } from 'next/navigation'
import { createAdminClient, createClient } from '@/lib/supabase/server'
import SettingsClient from './SettingsClient'
import type { SlackConnection, Column, Client, SocialPage } from '@/types'

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ box?: string; detail?: string; slack?: string; meta?: string; pages?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const boxStatus = params.box ?? null
  const slackStatus = params.slack ?? null
  const metaStatus = params.meta ?? null
  const errorDetail = params.detail ?? null

  const [{ data: rows }, { data: slackRow }, { data: columns }, { data: clients }, { data: socialPages }, { data: emailPrefRow }] = await Promise.all([
    // Admin client: these are secret keys, unreadable by signed-in users. Only
    // booleans and ids leave this server component.
    createAdminClient().from('app_settings').select('key, value').in('key', ['box_access_token', 'box_token_expires_at', 'meta_ads_user_token_encrypted', 'box_root_folder_id', 'box_webhook_id']),
    supabase.from('slack_connections').select('*').eq('user_id', user.id).maybeSingle(),
    supabase.from('columns').select('id, title, position').order('position'),
    supabase.from('clients').select('id, name, fb_ad_account_id').eq('active', true).order('name'),
    supabase.from('social_pages').select('id, page_name, fb_page_id, ig_account_id, status, connected_at').order('page_name'),
    supabase.from('adviewer_email_prefs').select('notify_on_review').eq('user_id', user.id).maybeSingle(),
  ])

  const settings = Object.fromEntries((rows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]))
  const isBoxConnected = !!settings['box_access_token']
  const expiresAt = settings['box_token_expires_at'] ?? null
  const isMetaTokenConnected = !!settings['meta_ads_user_token_encrypted']
  const boxRootFolderId = settings['box_root_folder_id'] ?? null
  const boxWebhookId = settings['box_webhook_id'] ?? null

  return (
    <SettingsClient
      isConnected={isBoxConnected}
      expiresAt={expiresAt}
      boxRootFolderId={boxRootFolderId}
      boxWebhookId={boxWebhookId}
      boxStatus={boxStatus}
      errorDetail={errorDetail}
      slackStatus={slackStatus}
      slackConnection={slackRow as SlackConnection | null}
      allColumns={(columns ?? []) as Column[]}
      allClients={(clients ?? []) as Pick<Client, 'id' | 'name' | 'fb_ad_account_id'>[]}
      metaStatus={metaStatus}
      isMetaTokenConnected={isMetaTokenConnected}
      metaPages={(socialPages ?? []) as Pick<SocialPage, 'id' | 'page_name' | 'fb_page_id' | 'ig_account_id' | 'status' | 'connected_at'>[]}
      emailNotifyOnReview={emailPrefRow?.notify_on_review ?? false}
    />
  )
}
