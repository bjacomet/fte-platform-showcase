// next.config.ts only whitelists *.supabase.co for next/image optimization.
// Preview/slide images can also come from Box links or dealer CDN URLs, which
// next/image throws on if passed through unoptimized={false}.
export function isSupabaseImageHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.supabase.co')
  } catch {
    return false
  }
}
