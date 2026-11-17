/**
 * Box shared-link helpers for the Atlas sync.
 *
 * No imports from `lib/box.ts` (it pulls in the Supabase server client) so the
 * logic is unit-testable with a stubbed `fetch`.
 */

const BOX_API = 'https://api.box.com/2.0'

type FetchLike = typeof fetch

export interface FolderSharedLink {
  url: string
  /** True when this call created the link; false when the folder already had one. */
  created: boolean
}

/**
 * The folder's shared link — reused when it has one, created otherwise.
 *
 * Creating sends an empty `shared_link` object on purpose: that is exactly what
 * Box's own "Copy link" does, so the account's admin default for new links
 * applies (the same default every existing link in the Copy Plan sheet has).
 * Never force an `access` level here.
 */
export async function getOrCreateFolderSharedLink(
  folderId: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<FolderSharedLink> {
  const headers = { Authorization: `Bearer ${token}` }

  const read = await fetchImpl(`${BOX_API}/folders/${folderId}?fields=shared_link`, { headers })
  if (!read.ok) throw new Error(`Box folder ${folderId} could not be read (${read.status})`)
  const existing = (await read.json()) as { shared_link?: { url?: string } | null }
  if (existing.shared_link?.url) return { url: existing.shared_link.url, created: false }

  const write = await fetchImpl(`${BOX_API}/folders/${folderId}?fields=shared_link`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shared_link: {} }),
  })
  if (!write.ok) {
    const hint = write.status === 403
      ? ' — the Box app needs permission to create shared links, and the connected account must be able to share this folder'
      : ''
    throw new Error(`Could not create a shared link for Box folder ${folderId} (${write.status})${hint}`)
  }
  const created = (await write.json()) as { shared_link?: { url?: string } | null }
  if (!created.shared_link?.url) throw new Error(`Box returned no shared link for folder ${folderId}`)
  return { url: created.shared_link.url, created: true }
}

/**
 * A Box root given as a folder URL, a bare id, or a shared link
 * (`https://…box.com/s/<token>`) → the numeric folder id.
 */
export async function resolveRootFolderId(
  value: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const raw = value.trim()
  if (/^\d+$/.test(raw)) return raw
  const folder = raw.match(/\/folder\/(\d+)/)
  if (folder) return folder[1]

  const res = await fetchImpl(`${BOX_API}/shared_items?fields=id,type,name`, {
    headers: { Authorization: `Bearer ${token}`, BoxApi: `shared_link=${raw}` },
  })
  if (!res.ok) throw new Error(`Could not open Box root ${raw} (${res.status}) — is it shared with the connected Box account?`)
  const item = (await res.json()) as { id?: string; type?: string }
  if (item.type !== 'folder' || !item.id) throw new Error(`Box root ${raw} is not a folder`)
  return item.id
}

/**
 * The child folder called `name` (case-insensitive, trimmed) — used to descend
 * `<root>/<year>/<quarter>`. Returns undefined when absent so the caller decides
 * whether that is an error (Social) or just "not built yet" (Display).
 */
export function pickNamedFolder<T extends { type: string; name: string }>(
  items: T[],
  name: string,
): T | undefined {
  const want = name.trim().toLowerCase()
  return items.find((i) => i.type === 'folder' && i.name.trim().toLowerCase() === want)
}
