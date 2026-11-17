'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Card, CardFlight, Client, TtdCampaign, TtdAdGroup } from '@/types'
import GanttChart from './GanttChart'
import MediaTypeBadge from './MediaTypeBadge'

interface Props {
  clientId: string | null
  clients: Client[]
  onClose: () => void
  onOpenCard?: (card: Card) => void
}

interface FlightWithCard extends CardFlight {
  cards: Card
}

type PanelTab = 'overview' | 'ttd'

export default function ClientPanel({ clientId, clients, onClose, onOpenCard }: Props) {
  const supabase = createClient()
  const client = clients.find((c) => c.id === clientId) ?? null

  const [panelTab, setPanelTab] = useState<PanelTab>('overview')
  const [liveCards, setLiveCards] = useState<Card[]>([])
  const [allFlights, setAllFlights] = useState<FlightWithCard[]>([])
  const [archivedCards, setArchivedCards] = useState<Card[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [loading, setLoading] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filterMediaType, setFilterMediaType] = useState('')

  // TTD campaign/ad group state
  const [ttdCampaigns, setTtdCampaigns] = useState<TtdCampaign[]>([])
  const [ttdLoading, setTtdLoading] = useState(false)
  const [addingCampaign, setAddingCampaign] = useState(false)
  const [newCampaignName, setNewCampaignName] = useState('')
  const [newCampaignId, setNewCampaignId] = useState('')
  const [addingAdGroupFor, setAddingAdGroupFor] = useState<string | null>(null)
  const [newAdGroupName, setNewAdGroupName] = useState('')
  const [newAdGroupId, setNewAdGroupId] = useState('')
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set())

  const fetchData = useCallback(async () => {
    if (!clientId) return
    setLoading(true)

    // ClientPanel reflects the paid-ads flow (live cards, Gantt, archive).
    // Organic content-calendar cards (calendar_only=true) live only on the
    // /calendar page and are deliberately excluded here.
    const { data: cards } = await supabase
      .from('cards')
      .select('*, clients(*)')
      .eq('client_id', clientId)
      .eq('archived', false)
      .eq('calendar_only', false)

    const { data: archived } = await supabase
      .from('cards')
      .select('*, clients(*)')
      .eq('client_id', clientId)
      .eq('archived', true)
      .eq('calendar_only', false)
      .order('updated_at', { ascending: false })
    setArchivedCards((archived ?? []) as Card[])

    const cardIds = (cards ?? []).map((c: Card) => c.id)

    if (cardIds.length === 0) {
      setLiveCards([])
      setAllFlights([])
      setLoading(false)
      return
    }

    const { data: flights } = await supabase
      .from('card_flights')
      .select('*')
      .in('card_id', cardIds)
      .eq('voided', false)
      .order('went_live_at', { ascending: true })

    const flightsWithCards = (flights ?? []).map((f: CardFlight) => ({
      ...f,
      cards: (cards ?? []).find((c: Card) => c.id === f.card_id) as Card,
    })).filter((f: FlightWithCard) => f.cards)

    const liveCardIds = new Set(
      flightsWithCards.filter((f: FlightWithCard) => !f.went_dark_at).map((f: FlightWithCard) => f.card_id)
    )
    setLiveCards((cards ?? []).filter((c: Card) => liveCardIds.has(c.id)))
    setAllFlights(flightsWithCards)
    setLoading(false)
  }, [clientId, supabase])

  const fetchTtdData = useCallback(async () => {
    if (!clientId) return
    setTtdLoading(true)
    const { data } = await supabase
      .from('ttd_campaigns')
      .select('*, ttd_ad_groups(*)')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true })
    setTtdCampaigns((data ?? []) as TtdCampaign[])
    setTtdLoading(false)
  }, [clientId, supabase])

  useEffect(() => {
    if (clientId) void (async () => { await fetchData() })()
  }, [clientId, fetchData])

  useEffect(() => {
    if (clientId && panelTab === 'ttd') void (async () => { await fetchTtdData() })()
  }, [clientId, panelTab, fetchTtdData])

  // Reset tab when panel opens for a different client
  const [trackedClientId, setTrackedClientId] = useState(clientId)
  if (trackedClientId !== clientId) {
    setTrackedClientId(clientId)
    setPanelTab('overview')
  }

  const addCampaign = async () => {
    if (!clientId || !newCampaignName.trim() || !newCampaignId.trim()) return
    const { data, error } = await supabase
      .from('ttd_campaigns')
      .insert({ client_id: clientId, name: newCampaignName.trim(), ttd_campaign_id: newCampaignId.trim() })
      .select('*, ttd_ad_groups(*)')
      .single()
    if (!error && data) {
      setTtdCampaigns((prev) => [...prev, data as TtdCampaign])
      setExpandedCampaigns((prev) => new Set([...prev, data.id]))
    }
    setNewCampaignName('')
    setNewCampaignId('')
    setAddingCampaign(false)
  }

  const deleteCampaign = async (campaignId: string) => {
    await supabase.from('ttd_campaigns').delete().eq('id', campaignId)
    setTtdCampaigns((prev) => prev.filter((c) => c.id !== campaignId))
  }

  const addAdGroup = async (campaignId: string) => {
    if (!newAdGroupName.trim() || !newAdGroupId.trim()) return
    const { data, error } = await supabase
      .from('ttd_ad_groups')
      .insert({ campaign_id: campaignId, name: newAdGroupName.trim(), ttd_ad_group_id: newAdGroupId.trim() })
      .select()
      .single()
    if (!error && data) {
      setTtdCampaigns((prev) => prev.map((c) =>
        c.id === campaignId
          ? { ...c, ttd_ad_groups: [...(c.ttd_ad_groups ?? []), data as TtdAdGroup] }
          : c
      ))
    }
    setNewAdGroupName('')
    setNewAdGroupId('')
    setAddingAdGroupFor(null)
  }

  const deleteAdGroup = async (campaignId: string, adGroupId: string) => {
    await supabase.from('ttd_ad_groups').delete().eq('id', adGroupId)
    setTtdCampaigns((prev) => prev.map((c) =>
      c.id === campaignId
        ? { ...c, ttd_ad_groups: (c.ttd_ad_groups ?? []).filter((g) => g.id !== adGroupId) }
        : c
    ))
  }

  const toggleExpanded = (campaignId: string) => {
    setExpandedCampaigns((prev) => {
      const next = new Set(prev)
      if (next.has(campaignId)) next.delete(campaignId)
      else next.add(campaignId)
      return next
    })
  }

  // Build Gantt rows filtered by date range and media type
  const ganttRows = (() => {
    const from = dateFrom ? new Date(dateFrom) : null
    const to = dateTo ? new Date(dateTo + 'T23:59:59') : null

    const filtered = allFlights.filter((f) => {
      if (filterMediaType && f.cards?.media_type !== filterMediaType) return false
      const liveAt = new Date(f.went_live_at)
      const darkAt = f.went_dark_at ? new Date(f.went_dark_at) : new Date()
      if (from && darkAt < from) return false
      if (to && liveAt > to) return false
      return true
    })

    const byCard = new Map<string, { card: Card; flights: CardFlight[] }>()
    for (const f of filtered) {
      if (!byCard.has(f.card_id)) byCard.set(f.card_id, { card: f.cards, flights: [] })
      byCard.get(f.card_id)!.flights.push(f)
    }
    return Array.from(byCard.values())
  })()

  const minDate = useMemo(() => {
    if (dateFrom) return new Date(dateFrom)
    // eslint-disable-next-line react-hooks/purity
    if (allFlights.length === 0) return new Date(Date.now() - 90 * 86400000)
    return new Date(Math.min(...allFlights.map((f) => new Date(f.went_live_at).getTime())))
  }, [dateFrom, allFlights])

  const maxDate = useMemo(() => {
    if (dateTo) return new Date(dateTo + 'T23:59:59')
    return new Date()
  }, [dateTo])

  const mediaTypes = [...new Set(allFlights.map((f) => f.cards?.media_type).filter(Boolean))] as string[]

  if (!clientId) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-30" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-3xl bg-[#141820] border-l border-gray-700/60 z-40 flex flex-col animate-slide-in shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-700/60 flex-none">
          {client?.fb_page_logo_url ? (
            <img src={client.fb_page_logo_url} alt={client.name} className="w-9 h-9 rounded-full object-cover flex-none" />
          ) : (
            <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm flex-none">
              {client?.name?.charAt(0) ?? '?'}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white truncate">{client?.name ?? 'Client'}</h2>
            {client?.abbreviation && (
              <p className="text-xs text-gray-400">{client.abbreviation}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-700/50 transition-colors flex-none"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-700/60 flex-none px-5">
          <button
            onClick={() => setPanelTab('overview')}
            className={`text-sm font-medium py-2.5 px-1 mr-5 border-b-2 transition-colors ${
              panelTab === 'overview'
                ? 'border-blue-500 text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setPanelTab('ttd')}
            className={`text-sm font-medium py-2.5 px-1 border-b-2 transition-colors ${
              panelTab === 'ttd'
                ? 'border-blue-500 text-white'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            TTD Campaigns
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* ── OVERVIEW TAB ── */}
          {panelTab === 'overview' && (
            loading ? (
              <div className="flex items-center justify-center h-40 text-sm text-gray-400">Loading…</div>
            ) : (
              <>
                {/* Currently Live */}
                <div className="px-5 pt-5 pb-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                    <h3 className="text-sm font-semibold text-white">Currently Live</h3>
                    <span className="text-xs text-gray-400 bg-gray-700/50 rounded-full px-2 py-0.5">{liveCards.length}</span>
                  </div>

                  {liveCards.length === 0 ? (
                    <p className="text-sm text-gray-500">No cards currently live for this client.</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2">
                      {liveCards.map((card) => (
                        <button
                          key={card.id}
                          onClick={() => onOpenCard?.(card)}
                          className="text-left bg-gray-800/60 border border-green-800/30 rounded-lg px-3 py-2.5 hover:border-green-600/50 hover:bg-gray-800 transition-colors"
                        >
                          <p className="text-sm text-gray-100 font-medium leading-snug">{card.title}</p>
                          <div className="flex items-center gap-1.5 mt-1">
                            {card.media_type && <MediaTypeBadge type={card.media_type} />}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-700/40 mx-5" />

                {/* Flight Timeline */}
                <div className="px-5 pt-4 pb-6">
                  <h3 className="text-sm font-semibold text-white mb-3">Flight Timeline</h3>

                  <div className="flex flex-wrap items-center gap-2 mb-4">
                    <div className="flex items-center gap-1.5">
                      <label className="text-xs text-gray-400">From</label>
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <label className="text-xs text-gray-400">To</label>
                      <input
                        type="date"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    {mediaTypes.length > 0 && (
                      <select
                        value={filterMediaType}
                        onChange={(e) => setFilterMediaType(e.target.value)}
                        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        <option value="">All types</option>
                        {mediaTypes.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    )}
                    {(dateFrom || dateTo || filterMediaType) && (
                      <button
                        onClick={() => { setDateFrom(''); setDateTo(''); setFilterMediaType('') }}
                        className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {allFlights.length === 0 ? (
                    <p className="text-sm text-gray-500">No flight history yet for this client.</p>
                  ) : (
                    <GanttChart
                      rows={ganttRows}
                      minDate={minDate}
                      maxDate={maxDate}
                      onOpenCard={onOpenCard}
                    />
                  )}
                </div>

                {/* Archived Cards */}
                {archivedCards.length > 0 && (
                  <>
                    <div className="border-t border-gray-700/40 mx-5" />
                    <div className="px-5 pt-4 pb-6">
                      <button
                        onClick={() => setShowArchived((v) => !v)}
                        className="flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-200 transition-colors w-full mb-3"
                      >
                        <svg className={`w-4 h-4 transition-transform ${showArchived ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                        Archived
                        <span className="text-xs text-gray-500 bg-gray-700/50 rounded-full px-2 py-0.5">{archivedCards.length}</span>
                      </button>

                      {showArchived && (
                        <div className="space-y-2">
                          {archivedCards.map((card) => (
                            <button
                              key={card.id}
                              onClick={() => onOpenCard?.(card)}
                              className="w-full text-left bg-gray-800/40 border border-gray-700/40 rounded-lg px-3 py-2.5 hover:bg-gray-800 hover:border-gray-600 transition-colors opacity-70 hover:opacity-100"
                            >
                              <p className="text-sm text-gray-300 font-medium leading-snug">{card.title}</p>
                              <div className="flex items-center gap-1.5 mt-1">
                                {card.media_type && <MediaTypeBadge type={card.media_type} />}
                                <span className="text-[10px] text-gray-500">
                                  Archived {new Date(card.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )
          )}

          {/* ── TTD TAB ── */}
          {panelTab === 'ttd' && (
            <div className="px-5 pt-5 pb-8">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-white">Campaigns &amp; Ad Groups</h3>
                {!addingCampaign && (
                  <button
                    onClick={() => setAddingCampaign(true)}
                    className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Add Campaign
                  </button>
                )}
              </div>

              {/* Add Campaign Form */}
              {addingCampaign && (
                <div className="mb-4 bg-gray-800/60 border border-gray-700/60 rounded-lg p-3 space-y-2">
                  <p className="text-xs font-medium text-gray-300 mb-2">New Campaign</p>
                  <input
                    type="text"
                    placeholder="Campaign name"
                    value={newCampaignName}
                    onChange={(e) => setNewCampaignName(e.target.value)}
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <input
                    type="text"
                    placeholder="TTD Campaign ID"
                    value={newCampaignId}
                    onChange={(e) => setNewCampaignId(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addCampaign()}
                    className="w-full bg-gray-900 border border-gray-600 rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                  />
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={addCampaign}
                      disabled={!newCampaignName.trim() || !newCampaignId.trim()}
                      className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-lg transition-colors"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setAddingCampaign(false); setNewCampaignName(''); setNewCampaignId('') }}
                      className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {ttdLoading ? (
                <div className="flex items-center justify-center h-24 text-sm text-gray-400">Loading…</div>
              ) : ttdCampaigns.length === 0 ? (
                <p className="text-sm text-gray-500">No campaigns yet. Add one above to get started.</p>
              ) : (
                <div className="space-y-3">
                  {ttdCampaigns.map((campaign) => {
                    const isExpanded = expandedCampaigns.has(campaign.id)
                    const adGroups = campaign.ttd_ad_groups ?? []
                    const isAddingHere = addingAdGroupFor === campaign.id

                    return (
                      <div key={campaign.id} className="bg-gray-800/50 border border-gray-700/60 rounded-lg overflow-hidden">
                        {/* Campaign row */}
                        <div className="flex items-center gap-2 px-3 py-2.5">
                          <button
                            onClick={() => toggleExpanded(campaign.id)}
                            className="flex items-center gap-2 flex-1 min-w-0 text-left"
                          >
                            <svg
                              className={`w-3.5 h-3.5 text-gray-400 flex-none transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                            <span className="text-sm font-medium text-white truncate">{campaign.name}</span>
                            <span className="text-[10px] text-gray-500 bg-gray-700/60 rounded px-1.5 py-0.5 font-mono flex-none">
                              {campaign.ttd_campaign_id}
                            </span>
                            <span className="text-[10px] text-gray-500 flex-none">
                              {adGroups.length} group{adGroups.length !== 1 ? 's' : ''}
                            </span>
                          </button>
                          <button
                            onClick={() => deleteCampaign(campaign.id)}
                            className="text-gray-600 hover:text-red-400 transition-colors p-1 flex-none"
                            title="Delete campaign"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>

                        {/* Ad Groups */}
                        {isExpanded && (
                          <div className="border-t border-gray-700/40 px-3 py-2 space-y-1.5">
                            {adGroups.length === 0 && !isAddingHere && (
                              <p className="text-xs text-gray-500 py-1">No ad groups yet.</p>
                            )}
                            {adGroups.map((group) => (
                              <div key={group.id} className="flex items-center gap-2 py-1">
                                <div className="w-1.5 h-1.5 rounded-full bg-gray-600 flex-none ml-1" />
                                <span className="text-xs text-gray-300 flex-1 truncate">{group.name}</span>
                                <span className="text-[10px] text-gray-500 font-mono bg-gray-700/50 rounded px-1.5 py-0.5 flex-none">
                                  {group.ttd_ad_group_id}
                                </span>
                                <button
                                  onClick={() => deleteAdGroup(campaign.id, group.id)}
                                  className="text-gray-600 hover:text-red-400 transition-colors p-0.5 flex-none"
                                  title="Delete ad group"
                                >
                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            ))}

                            {/* Add Ad Group Form */}
                            {isAddingHere ? (
                              <div className="pt-1 space-y-1.5">
                                <input
                                  type="text"
                                  placeholder="Ad group name"
                                  value={newAdGroupName}
                                  onChange={(e) => setNewAdGroupName(e.target.value)}
                                  autoFocus
                                  className="w-full bg-gray-900 border border-gray-600 rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                <input
                                  type="text"
                                  placeholder="TTD Ad Group ID"
                                  value={newAdGroupId}
                                  onChange={(e) => setNewAdGroupId(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && addAdGroup(campaign.id)}
                                  className="w-full bg-gray-900 border border-gray-600 rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                                />
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => addAdGroup(campaign.id)}
                                    disabled={!newAdGroupName.trim() || !newAdGroupId.trim()}
                                    className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1 rounded-lg transition-colors"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => { setAddingAdGroupFor(null); setNewAdGroupName(''); setNewAdGroupId('') }}
                                    className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 transition-colors"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  setAddingAdGroupFor(campaign.id)
                                  setNewAdGroupName('')
                                  setNewAdGroupId('')
                                }}
                                className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400 transition-colors pt-0.5"
                              >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                                </svg>
                                Add ad group
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
