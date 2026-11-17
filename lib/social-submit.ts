import { createAdminClient } from '@/lib/supabase/server'
import { decryptToken, schedulePost, createIgContainer, publishIgContainer } from '@/lib/meta'
import { postSlackText } from '@/lib/slack'
import type { SocialPlatform } from '@/types'

interface LockedPost {
  id: string
  platform: SocialPlatform
  caption: string | null
  media_urls: string[]
  scheduled_for: string
  social_pages: {
    fb_page_id: string
    ig_account_id: string | null
    access_token_encrypted: string
  } | null
}

export interface SubmitPostResult {
  ok: boolean
  post?: {
    id: string
    status: 'scheduled' | 'published' | 'failed'
    fb_post_id: string | null
    ig_container_id: string | null
    error_message: string | null
    error_code: string | null
  }
  error?: string
  httpStatus?: number
}

/**
 * Atomically submits an approved social post to the Meta API.
 * Transitions: approved → submitting → scheduled/published/failed.
 * Returns null-safe — safe to call from both the approve route and the cron backstop.
 */
export async function submitSocialPost(postId: string): Promise<SubmitPostResult> {
  const admin = createAdminClient()
  const now = new Date().toISOString()

  // Atomic lock: only proceeds if status is exactly 'approved'.
  // Returns null if already grabbed by another call or in wrong state.
  const { data } = await admin
    .from('social_posts')
    .update({ status: 'submitting', submitted_at: now })
    .eq('id', postId)
    .eq('status', 'approved')
    .select('id, platform, caption, media_urls, scheduled_for, social_pages(fb_page_id, ig_account_id, access_token_encrypted)')
    .maybeSingle()

  const locked = data as LockedPost | null
  if (!locked) {
    return { ok: false, error: 'Post not found or not in approved state', httpStatus: 409 }
  }

  if (!locked.social_pages) {
    await admin.from('social_posts').update({
      status: 'failed',
      error_message: 'Page not found',
      error_code: 'page_missing',
    }).eq('id', postId)
    return { ok: false, error: 'Page not found', httpStatus: 422 }
  }

  const { fb_page_id, ig_account_id, access_token_encrypted } = locked.social_pages
  const pageToken = decryptToken(access_token_encrypted)
  const scheduledTime = new Date(locked.scheduled_for)
  const caption = locked.caption ?? ''
  const mediaUrl = locked.media_urls[0] ?? null

  try {
    if (locked.platform === 'facebook') {
      const fbPostId = await schedulePost(pageToken, fb_page_id, caption, mediaUrl, scheduledTime)
      await admin.from('social_posts').update({ status: 'scheduled', fb_post_id: fbPostId }).eq('id', postId)
      return {
        ok: true,
        post: { id: postId, status: 'scheduled', fb_post_id: fbPostId, ig_container_id: null, error_message: null, error_code: null },
      }
    }

    // Instagram — requires an image URL
    if (!mediaUrl) {
      throw Object.assign(new Error('Instagram posts require an image URL'), { code: 'ig_no_image' })
    }
    if (!ig_account_id) {
      throw Object.assign(new Error('No Instagram account linked to this page'), { code: 'ig_no_account' })
    }

    // Use Instagram native scheduling if > 5 min in the future; otherwise publish immediately
    const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000)
    const useNativeScheduling = scheduledTime > fiveMinFromNow

    const containerId = await createIgContainer(
      pageToken, ig_account_id, mediaUrl, caption,
      useNativeScheduling ? scheduledTime : undefined,
    )
    const publishedId = await publishIgContainer(pageToken, ig_account_id, containerId)
    const finalStatus = useNativeScheduling ? ('scheduled' as const) : ('published' as const)

    await admin.from('social_posts').update({
      status: finalStatus,
      ig_container_id: containerId,
      fb_post_id: publishedId,
      ...(finalStatus === 'published' ? { published_at: new Date().toISOString() } : {}),
    }).eq('id', postId)

    return {
      ok: true,
      post: { id: postId, status: finalStatus, fb_post_id: publishedId, ig_container_id: containerId, error_message: null, error_code: null },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown submission error'
    const code = (err as Record<string, unknown>).code as string | undefined ?? 'unknown'

    await admin.from('social_posts').update({
      status: 'failed',
      error_message: msg,
      error_code: code,
    }).eq('id', postId)

    postSlackText(`⚠️ Social post submission failed (${locked.platform}, post ${postId}): ${msg}`).catch(() => undefined)

    return { ok: false, error: msg, httpStatus: 502 }
  }
}
