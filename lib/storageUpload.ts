// Direct-to-Supabase-Storage upload with progress reporting.
//
// Uses XHR (not the supabase-js storage client) because only XHR exposes an
// upload-progress event and resolves deterministically on load / error / abort —
// the supabase-js `.upload()` promise was leaving editor busy states stuck.
//
// accessToken MUST be the user's live session JWT (from supabase.auth.getSession()),
// NOT the static anon key — storage RLS requires an authenticated session.
export async function uploadToStorageWithProgress(
  path: string,
  file: File,
  accessToken: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<{ error: Error | null }> {
  return new Promise((resolve) => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    const url = `${supabaseUrl}/storage/v1/object/creative-files/${path}`

    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total)
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ error: null })
      } else {
        let msg = `Upload failed: ${xhr.status}`
        try { msg = JSON.parse(xhr.responseText)?.error ?? msg } catch { /* ignore */ }
        resolve({ error: new Error(msg) })
      }
    })

    xhr.addEventListener('error', () => resolve({ error: new Error('Network error during upload') }))
    xhr.addEventListener('abort', () => resolve({ error: new Error('Upload cancelled') }))

    xhr.open('POST', url)
    // Use the session JWT so storage RLS treats the request as authenticated
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
    xhr.setRequestHeader('apikey', supabaseKey)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.send(file)
  })
}
