'use client'

import { memo } from 'react'
import dynamic from 'next/dynamic'
import type { Card } from '@/types'
import { drawerInputClass, drawerLabelClass } from '@/lib/formStyles'

// Lazy-loaded so date-fns (bundled by react-day-picker) is code-split from the drawer's initial load
const DatePickerInput = dynamic(() => import('./DatePickerInput'), {
  ssr: false,
  loading: () => (
    <div className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg h-9" />
  ),
})

interface ChannelOption { value: string; label: string }

interface Props {
  card: Pick<Card, 'created_at'>
  firstDraftDeadline: string
  onFirstDraftDeadlineChange: (v: string) => void
  flightStartDate: string
  onFlightStartDateChange: (v: string) => void
  flightEndDate: string
  onFlightEndDateChange: (v: string) => void
  landingPageUrl: string
  onLandingPageUrlChange: (v: string) => void
  utmCampaign: string
  onUtmCampaignChange: (v: string) => void
  utmChannel: string
  onUtmChannelChange: (v: string) => void
  showUtm: boolean
  onToggleUtm: () => void
  utmCopied: boolean
  onCopyUtm: () => void
  generatedUtmUrl: string
  channelOptions: ChannelOption[]
  campaignPresets: string[]
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">{title}</span>
      <div className="flex-1 h-px bg-gray-700/60" />
    </div>
  )
}

export default memo(function DrawerDetailsSection({
  card,
  firstDraftDeadline, onFirstDraftDeadlineChange,
  flightStartDate, onFlightStartDateChange,
  flightEndDate, onFlightEndDateChange,
  landingPageUrl, onLandingPageUrlChange,
  utmCampaign, onUtmCampaignChange,
  utmChannel, onUtmChannelChange,
  showUtm, onToggleUtm,
  utmCopied, onCopyUtm,
  generatedUtmUrl,
  channelOptions, campaignPresets,
}: Props) {
  const lbl = drawerLabelClass
  const inp = drawerInputClass

  return (
    <div>
      <SectionHeader title="Details" />
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Date Received</label>
            <input
              value={new Date(card.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              readOnly
              className={`${inp} opacity-50 cursor-default`}
            />
          </div>
          <div>
            <label className={lbl}>First Draft Deadline</label>
            <DatePickerInput value={firstDraftDeadline} onChange={onFirstDraftDeadlineChange} className={inp} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={lbl}>Flight Start</label>
            <DatePickerInput value={flightStartDate} onChange={onFlightStartDateChange} className={inp} />
          </div>
          <div>
            <label className={lbl}>Flight End</label>
            <DatePickerInput value={flightEndDate} onChange={onFlightEndDateChange} className={inp} />
          </div>
        </div>

        <div>
          <label className={lbl}>Landing Page URL</label>
          <input
            value={landingPageUrl}
            onChange={(e) => onLandingPageUrlChange(e.target.value)}
            className={inp}
            placeholder="https://…"
          />
        </div>
        <div className="pl-3 border-l-2 border-gray-700/60 space-y-3">
          <button
            type="button"
            onClick={onToggleUtm}
            className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors font-medium"
          >
            {showUtm ? '▾ Hide UTM parameters' : '▸ Add UTM parameters'}
          </button>
          {showUtm && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={lbl}>UTM Campaign</label>
                  {campaignPresets.length > 0 ? (
                    <select value={utmCampaign} onChange={(e) => onUtmCampaignChange(e.target.value)} className={inp}>
                      <option value="">Select…</option>
                      {campaignPresets.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={utmCampaign} onChange={(e) => onUtmCampaignChange(e.target.value)} className={inp} placeholder="campaign-name" />
                  )}
                </div>
                <div>
                  <label className={lbl}>UTM Channel</label>
                  <select value={utmChannel} onChange={(e) => onUtmChannelChange(e.target.value)} className={inp}>
                    <option value="">Select…</option>
                    {channelOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              {generatedUtmUrl && (
                <div className="flex items-center gap-2">
                  <input
                    value={generatedUtmUrl}
                    readOnly
                    className={`${inp} flex-1 text-[10px] opacity-60`}
                  />
                  <button
                    type="button"
                    onClick={onCopyUtm}
                    className="text-xs text-blue-400 hover:text-blue-300 shrink-0 font-medium"
                  >
                    {utmCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
