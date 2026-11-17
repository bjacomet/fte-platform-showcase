import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/writers'
import {
  exchangeCodeForToken,
  getLongLivedToken,
  getManagedPages,
  encryptToken,
} from '@/lib/meta'

export async function GET(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://your-app.vercel.app'

  const errorParam = req.nextUrl.searchParams.get('error')
  if (errorParam) {
    const desc = req.nextUrl.searchParams.get('error_description') ?? errorParam
    return NextResponse.redirect(
      new URL(`/settings?meta=error&detail=${encodeURIComponent(desc)}`, appUrl)
    )
  }

  const code = req.nextUrl.searchParams.get('code')
  const returnedState = req.nextUrl.searchParams.get('state')
  const savedState = req.cookies.get('meta_oauth_state')?.value

  if (!code) {
    return NextResponse.redirect(new URL('/settings?meta=error&detail=no_code', appUrl))
  }
  if (!savedState || savedState !== returnedState) {
    return NextResponse.redirect(new URL('/settings?meta=error&detail=state_mismatch', appUrl))
  }

  const supabaseAuth = await createClient()
  const { data: { user } } = await supabaseAuth.auth.getUser()
  if (!user) return NextResponse.redirect(new URL('/login', appUrl))
  if (!isAdminEmail(user.email)) return NextResponse.redirect(new URL('/settings?meta=error&detail=forbidden', appUrl))

  try {
    const shortToken = await exchangeCodeForToken(code)
    const longToken = await getLongLivedToken(shortToken)

    const supabase = createAdminClient()

    // Store the user-level long-lived token so the Marketing API (ads_management)
    // can be called later without requiring the user to re-authenticate.
    await supabase.from('app_settings').upsert(
      { key: 'meta_ads_user_token_encrypted', value: encryptToken(longToken) },
      { onConflict: 'key' }
    )

    // Attempt to fetch managed pages for social scheduling (requires pages_show_list scope).
    // Optional — the Marketing API app only has ads_management/ads_read, so pages will be
    // empty. Store them if present; skip silently if not.
    let pageCount = 0
    try {
      const pages = await getManagedPages(longToken)
      pageCount = pages.length
      for (const page of pages) {
        await supabase.from('social_pages').upsert(
          {
            fb_page_id: page.fb_page_id,
            page_name: page.page_name,
            ig_account_id: page.ig_account_id,
            access_token_encrypted: encryptToken(page.access_token),
            status: 'active',
            connected_by: user?.id ?? null,
            connected_at: new Date().toISOString(),
          },
          { onConflict: 'fb_page_id' }
        )
      }
    } catch {
      // No pages scope — expected for Marketing API-only app
    }

    const res = NextResponse.redirect(
      new URL(`/settings?meta=connected&pages=${pageCount}`, appUrl)
    )
    res.cookies.delete('meta_oauth_state')
    return res
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    console.error('Meta OAuth callback error:', err)
    return NextResponse.redirect(
      new URL(`/settings?meta=error&detail=${encodeURIComponent(msg.slice(0, 200))}`, appUrl)
    )
  }
}
