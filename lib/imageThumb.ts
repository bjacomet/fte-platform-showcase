// Browser-only image thumbnailing for retained change-request history.
// Shared by FileUpload (file delete) and CardDrawer (carousel slide / social
// graphic replacement) so every replace path keeps the same small old-graphic
// preview in client_notes.history.

// Downscale an image URL to a small JPEG blob. Resolves null on any failure
// (e.g. a tainted canvas) so callers degrade gracefully.
export async function generateThumbnail(srcUrl: string, maxSize = 240): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) { resolve(null); return }
        ctx.drawImage(img, 0, 0, w, h)
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.7)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = srcUrl
  })
}
