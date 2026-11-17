import type { Client } from '@/types'
import { withHttpsScheme } from './url'

interface UtmChannelConfig {
  source: string
  medium: string
}

interface UtmConfig {
  channels?: Record<string, UtmChannelConfig>
  extra_params?: Record<string, string>
  campaign_presets?: string[]
}

function getUtmConfig(client: Client | null): UtmConfig | null {
  if (!client?.utm_config) return null
  return client.utm_config as UtmConfig
}

/** Return the channel options for the given client. */
export function getChannelOptions(client: Client | null): { value: string; label: string }[] {
  const config = getUtmConfig(client)
  if (config?.channels) {
    return Object.keys(config.channels).map((key) => ({
      value: key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
    }))
  }
  return [
    { value: 'facebook', label: 'Facebook / Social' },
    { value: 'display', label: 'Display' },
    { value: 'ctv', label: 'CTV / Streaming' },
    { value: 'audio', label: 'Audio' },
    { value: 'tiktok', label: 'TikTok' },
    { value: 'linkedin', label: 'LinkedIn' },
    { value: 'email', label: 'Email' },
    { value: 'seo', label: 'SEO' },
  ]
}

/** Return any campaign presets defined on the client's utm_config. */
export function getCampaignPresets(client: Client | null): string[] {
  return getUtmConfig(client)?.campaign_presets ?? []
}

/**
 * Build a full tracking URL from the given base URL + UTM parameters.
 *
 * Example Motors (clients with utm_config.channels):
 *   utm_source + utm_medium come from the channel config (e.g. display → ttd/display)
 *   extra_params (e.g. dealer_vendor=fte) are appended automatically
 *
 * All other clients:
 *   utm_source=FTE, utm_medium=channel value
 */
export function generateUtmUrl({
  baseUrl,
  campaign,
  channel,
  client,
}: {
  baseUrl: string
  campaign: string
  channel: string
  client: Client | null
}): string {
  const normalized = withHttpsScheme(baseUrl)
  if (!normalized) return ''

  let urlObj: URL
  try {
    urlObj = new URL(normalized)
  } catch {
    return ''
  }

  const config = getUtmConfig(client)

  if (config?.channels && channel && config.channels[channel]) {
    // Special client — use channel-specific source/medium
    const ch = config.channels[channel]
    urlObj.searchParams.set('utm_source', ch.source)
    urlObj.searchParams.set('utm_medium', ch.medium)
    if (campaign.trim()) urlObj.searchParams.set('utm_campaign', campaign.trim())
    // Append extra params (e.g. dealer_vendor=fte) last
    if (config.extra_params) {
      for (const [key, value] of Object.entries(config.extra_params)) {
        urlObj.searchParams.set(key, value)
      }
    }
  } else {
    // Standard FTE client
    urlObj.searchParams.set('utm_source', 'FTE')
    if (channel) urlObj.searchParams.set('utm_medium', channel)
    if (campaign.trim()) urlObj.searchParams.set('utm_campaign', campaign.trim())
  }

  return urlObj.toString()
}

/** Suggest a default channel value based on the card's media_type. */
export function defaultChannelForMediaType(mediaType: string | null): string {
  switch (mediaType) {
    case 'Social Ad Request':
    case 'Carousel Ad':
    case 'Organic Post':
    case 'FB Event Cover':
      return 'facebook'
    case 'Display Request':
    case 'Web Banner':
      return 'display'
    case 'Video Request':
    case 'Reel Request':
      return 'ctv'
    case 'Audio Request':
      return 'audio'
    default:
      return ''
  }
}
