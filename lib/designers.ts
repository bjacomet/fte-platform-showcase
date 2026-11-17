// Who a card's designer pill names.
//
// Normally the client's designer (clients.designer_name). Video work is the
// exception: one designer handles every video request whatever the client
// (team decision, 2026-10-05: "the video designer handles anything related to Video even if it's
// my client"). That rule lives in app_settings under VIDEO_DESIGNER_KEY as
// {"name","email"} so it can be changed on the Clients page without a deploy.

export type Designer = { name: string; email: string }

export const VIDEO_DESIGNER_KEY = 'video_designer'

// Card types that count as video work for the rule above.
export const VIDEO_MEDIA_TYPES: readonly string[] = ['Video Request', 'Reel Request']

export function parseDesigner(value: string | null | undefined): Designer | null {
  if (!value) return null
  try {
    const d = JSON.parse(value) as Partial<Designer>
    return d.name && d.email ? { name: d.name, email: d.email } : null
  } catch {
    return null
  }
}

export function isVideoWork(mediaType: string | null | undefined): boolean {
  return !!mediaType && VIDEO_MEDIA_TYPES.includes(mediaType)
}
