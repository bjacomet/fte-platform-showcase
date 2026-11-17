// TapClicks TapAPI (read-only). TTD delivery lives in service 61, "Digital
// (display, pre-roll, CTV)" — not a service named after The Trade Desk.
// The feed carries impressions and clicks but no spend/cost field.

const API = 'https://api.tapclicks.com'
// Cloudflare in front of the API rejects requests with no User-Agent.
const HEADERS = { 'User-Agent': 'fte-platform/1.0' }
export const TTD_SERVICE_ID = 61

let cached: { token: string; expiresAt: number } | null = null

export async function getTapClicksToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token
  const id = process.env.TAPCLICKS_CLIENT_ID
  const secret = process.env.TAPCLICKS_CLIENT_SECRET
  if (!id || !secret) throw new Error('TapClicks not configured (TAPCLICKS_CLIENT_ID / TAPCLICKS_CLIENT_SECRET)')
  const res = await fetch(`${API}/oauth/accesstoken`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
    cache: 'no-store',
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
  if (!res.ok || !body.access_token) throw new Error(`TapClicks token request failed (${res.status})`)
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  return body.access_token
}

async function tcGet<T>(path: string): Promise<T> {
  const token = await getTapClicksToken()
  const res = await fetch(`${API}/v2${path}`, {
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`TapClicks GET ${path.split('?')[0]} failed (${res.status})`)
  return res.json() as Promise<T>
}

interface CampaignDayRow {
  client_name?: string
  name?: string
  Impression_wonCount?: string | number
  ClickCount?: string | number
  log_date?: number
}

export interface TtdCampaignMtd {
  advertiser: string
  campaign: string
  impressions: number
  clicks: number
}

/**
 * Month-to-date TTD delivery per campaign, summed from daily rows.
 * The account-level /daterange setting does not filter data queries and date
 * query params are rejected, so rows are paged newest-first and cut at the
 * month start. `fields` must be listed explicitly or rows come back empty.
 */
export async function fetchTtdCampaignsMtd(year: number, month: number): Promise<TtdCampaignMtd[]> {
  const start = Date.UTC(year, month - 1, 1) / 1000
  const end = Date.UTC(year, month, 1) / 1000
  const base = `/services/${TTD_SERVICE_ID}/data/cgn?groupby=campaign_id&timegrouping=daily&sort=-log_date` +
    '&fields=client_name,name,campaign_id,Impression_wonCount,ClickCount,log_date'
  const totals = new Map<string, TtdCampaignMtd>()
  const PAGE = 1000
  for (let page = 0; page < 50; page++) {
    const { data } = await tcGet<{ data?: CampaignDayRow[] }>(`${base}&page=${page},${PAGE}`)
    const rows = data ?? []
    if (!rows.length) break
    for (const r of rows) {
      const day = r.log_date ?? 0
      // log_date is the UTC midnight of the reporting day; widen by a few
      // hours so a timezone-shifted first day of the month is not dropped.
      if (day < start - 6 * 3600 || day >= end) continue
      const advertiser = (r.client_name ?? '').trim()
      const campaign = (r.name ?? '').trim()
      if (!campaign) continue
      const key = `${advertiser}||${campaign}`
      const t = totals.get(key) ?? { advertiser, campaign, impressions: 0, clicks: 0 }
      t.impressions += Number(r.Impression_wonCount) || 0
      t.clicks += Number(r.ClickCount) || 0
      totals.set(key, t)
    }
    const oldest = Math.min(...rows.map(r => r.log_date ?? 0))
    if (oldest < start - 6 * 3600 || rows.length < PAGE) break
  }
  return Array.from(totals.values())
}
