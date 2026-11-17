'use client'

import { useEffect, useState } from 'react'
import type { ClientFbAdAccount } from '@/types'

interface FbCampaign { id: string; name: string; status: string }
interface FbAdSet { id: string; name: string; status: string }

interface Props {
  clientId: string
  cardTitle: string
  dailyBudgetCents: number
  onDailyBudgetChange: (cents: number) => void
  publishing: boolean
  publishError: string | null
  onConfirm: (opts: {
    adAccountId: string
    existingCampaignId?: string
    existingAdSetId?: string
    dailyBudgetCents: number
  }) => void
  onClose: () => void
}

export default function FbPublishModal({
  clientId,
  cardTitle,
  dailyBudgetCents,
  onDailyBudgetChange,
  publishing,
  publishError,
  onConfirm,
  onClose,
}: Props) {
  // ── Ad accounts ──────────────────────────────────────────────────────────
  const [accounts, setAccounts] = useState<ClientFbAdAccount[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [accountsError, setAccountsError] = useState<string | null>(null)

  // ── Campaigns ─────────────────────────────────────────────────────────────
  const [campaigns, setCampaigns] = useState<FbCampaign[]>([])
  const [adSets, setAdSets] = useState<FbAdSet[]>([])
  const [pageName, setPageName] = useState<string | null>(null)
  const [loadingCampaigns, setLoadingCampaigns] = useState(false)
  const [loadingAdSets, setLoadingAdSets] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const [selectedCampaignId, setSelectedCampaignId] = useState('')
  const [selectedAdSetId, setSelectedAdSetId] = useState('')

  // ── Step 1: Load ad accounts for this client ──────────────────────────────
  useEffect(() => {
    async function loadAccounts() {
      setLoadingAccounts(true)
      setAccountsError(null)
      try {
        const res = await fetch(`/api/clients/fb-ad-accounts?clientId=${encodeURIComponent(clientId)}`)
        const json = await res.json() as { accounts?: ClientFbAdAccount[]; error?: string }
        if (!res.ok) throw new Error(json.error ?? 'Failed to load ad accounts')
        const loaded = json.accounts ?? []
        setAccounts(loaded)
        if (loaded.length === 1) setSelectedAccountId(loaded[0].account_id)
      } catch (err) {
        setAccountsError(err instanceof Error ? err.message : 'Failed to load ad accounts')
      } finally {
        setLoadingAccounts(false)
      }
    }
    void loadAccounts()
  }, [clientId])

  // ── Step 2: Load campaigns once an account is selected ───────────────────
  useEffect(() => {
    if (!selectedAccountId) return
    async function loadCampaigns() {
      setLoadingCampaigns(true)
      setFetchError(null)
      setCampaigns([])
      setSelectedCampaignId('')
      setAdSets([])
      setSelectedAdSetId('')
      setPageName(null)
      try {
        const res = await fetch(
          `/api/facebook/campaigns?adAccountId=${encodeURIComponent(selectedAccountId)}&clientId=${encodeURIComponent(clientId)}`
        )
        const json = await res.json() as {
          campaigns?: FbCampaign[]
          page?: { fb_page_id: string; page_name: string } | null
          error?: string
        }
        if (!res.ok) throw new Error(json.error ?? 'Failed to load campaigns')
        setCampaigns(json.campaigns ?? [])
        setPageName(json.page?.page_name ?? null)
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : 'Failed to load campaigns')
      } finally {
        setLoadingCampaigns(false)
      }
    }
    void loadCampaigns()
  }, [selectedAccountId, clientId])

  // ── Step 3: Load ad sets when an existing campaign is selected ────────────
  useEffect(() => {
    if (!selectedCampaignId) return
    async function loadAdSets() {
      setLoadingAdSets(true)
      try {
        const res = await fetch(`/api/facebook/ad-sets?campaignId=${encodeURIComponent(selectedCampaignId)}`)
        const json = await res.json() as { adSets?: FbAdSet[]; error?: string }
        if (!res.ok) throw new Error(json.error ?? 'Failed to load ad sets')
        setAdSets(json.adSets ?? [])
      } catch {
        // non-fatal
      } finally {
        setLoadingAdSets(false)
      }
    }
    void loadAdSets()
  }, [selectedCampaignId])

  function handleConfirm() {
    onConfirm({
      adAccountId: selectedAccountId,
      existingCampaignId: selectedCampaignId || undefined,
      existingAdSetId: selectedAdSetId || undefined,
      dailyBudgetCents,
    })
  }

  const budgetDollars = (dailyBudgetCents / 100).toFixed(2)
  const canPublish = !loadingAccounts && !accountsError && !!selectedAccountId
    && !loadingCampaigns && !fetchError && !!pageName && !publishing

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget && !publishing) onClose() }}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-[#1a1d2e] border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-5">
          <div>
            <h2 className="text-white font-semibold text-base leading-tight">Publish to Facebook Ads</h2>
            <p className="text-gray-400 text-xs mt-0.5 truncate max-w-[320px]">{cardTitle}</p>
          </div>
          {!publishing && (
            <button
              type="button"
              onClick={onClose}
              className="text-gray-500 hover:text-white text-lg leading-none mt-0.5 flex-none"
            >
              ✕
            </button>
          )}
        </div>

        {/* Ad Account picker */}
        <div className="mb-4">
          <p className="text-[10px] font-bold text-gray-300 uppercase tracking-widest mb-1.5">Ad Account</p>
          {loadingAccounts ? (
            <div className="h-9 bg-[#0f1117] rounded-lg animate-pulse" />
          ) : accountsError ? (
            <p className="text-red-400 text-xs">{accountsError}</p>
          ) : accounts.length === 0 ? (
            <p className="text-red-400 text-xs">No ad accounts configured for this client. Add one in Settings → Facebook Ad Accounts.</p>
          ) : accounts.length === 1 ? (
            <div className="flex items-center gap-2 bg-[#0f1117] rounded-lg px-3 py-2">
              <div className="w-2 h-2 rounded-full bg-[#1877F2] flex-none" />
              <span className="text-sm text-gray-200 font-mono">{accounts[0].account_id}</span>
              {accounts[0].label && (
                <span className="text-xs text-gray-500">· {accounts[0].label}</span>
              )}
            </div>
          ) : (
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              disabled={publishing}
              className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#1877F2] disabled:opacity-50"
            >
              <option value="">Select an ad account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.account_id}>
                  {a.account_id}{a.label ? ` — ${a.label}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Facebook Page — only shown once account selected */}
        {selectedAccountId && (
          <div className="mb-4">
            <p className="text-[10px] font-bold text-gray-300 uppercase tracking-widest mb-1.5">Facebook Page</p>
            <div className="flex items-center gap-2 bg-[#0f1117] rounded-lg px-3 py-2">
              <div className="w-2 h-2 rounded-full bg-[#1877F2] flex-none" />
              <span className="text-sm text-gray-200">
                {loadingCampaigns ? (
                  <span className="text-gray-500 italic">Loading…</span>
                ) : pageName ?? (
                  <span className="text-red-400">No page connected for this client</span>
                )}
              </span>
            </div>
          </div>
        )}

        {/* Campaign selector — only shown once account selected */}
        {selectedAccountId && (
          <div className="mb-4">
            <p className="text-[10px] font-bold text-gray-300 uppercase tracking-widest mb-1.5">Campaign</p>
            {loadingCampaigns ? (
              <div className="h-9 bg-[#0f1117] rounded-lg animate-pulse" />
            ) : fetchError ? (
              <p className="text-red-400 text-xs">{fetchError}</p>
            ) : (
              <select
                value={selectedCampaignId}
                onChange={(e) => {
                  setSelectedCampaignId(e.target.value)
                  setAdSets([])
                  setSelectedAdSetId('')
                }}
                disabled={publishing}
                className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#1877F2] disabled:opacity-50"
              >
                <option value="">Create new campaign</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
                ))}
              </select>
            )}
            {!loadingCampaigns && campaigns.length === 0 && !fetchError && (
              <p className="text-gray-500 text-xs mt-1">No existing campaigns — a new one will be created.</p>
            )}
          </div>
        )}

        {/* Ad set selector */}
        {selectedCampaignId && (
          <div className="mb-4">
            <p className="text-[10px] font-bold text-gray-300 uppercase tracking-widest mb-1.5">Ad Set</p>
            {loadingAdSets ? (
              <div className="h-9 bg-[#0f1117] rounded-lg animate-pulse" />
            ) : (
              <select
                value={selectedAdSetId}
                onChange={(e) => setSelectedAdSetId(e.target.value)}
                disabled={publishing}
                className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#1877F2] disabled:opacity-50"
              >
                <option value="">Create new ad set</option>
                {adSets.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.status})</option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Daily Budget */}
        {selectedAccountId && (
          <div className="mb-4">
            <p className="text-[10px] font-bold text-gray-300 uppercase tracking-widest mb-1.5">Daily Budget</p>
            <div className="flex items-center gap-2">
              <span className="text-gray-400 text-sm">$</span>
              <input
                type="number"
                min="1"
                step="1"
                value={budgetDollars}
                onChange={(e) => {
                  const dollars = parseFloat(e.target.value)
                  if (!isNaN(dollars) && dollars > 0) {
                    onDailyBudgetChange(Math.round(dollars * 100))
                  }
                }}
                disabled={publishing}
                className="w-24 bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-[#1877F2] disabled:opacity-50"
              />
              <span className="text-gray-500 text-xs">/ day (paused — will not spend)</span>
            </div>
          </div>
        )}

        {/* Summary */}
        {selectedAccountId && !loadingCampaigns && !fetchError && (
          <div className="bg-[#0f1117] rounded-lg px-3 py-2.5 mb-4 space-y-1">
            <p className="text-[11px] text-gray-500">
              {selectedCampaignId
                ? <><span className="text-gray-300">Using existing campaign</span> — {campaigns.find(c => c.id === selectedCampaignId)?.name}</>
                : <><span className="text-gray-300">New campaign</span> will be created (PAUSED)</>
              }
            </p>
            <p className="text-[11px] text-gray-500">
              {selectedAdSetId
                ? <><span className="text-gray-300">Using existing ad set</span> — {adSets.find(s => s.id === selectedAdSetId)?.name}</>
                : <><span className="text-gray-300">New ad set</span> will be created (PAUSED, ${(dailyBudgetCents / 100).toFixed(2)}/day)</>
              }
            </p>
            <p className="text-[11px] text-gray-500">
              <span className="text-gray-300">Ad creative + ad</span> — always created new (PAUSED)
            </p>
          </div>
        )}

        {/* Error */}
        {publishError && (
          <p className="text-red-400 text-xs mb-4">{publishError}</p>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={publishing}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canPublish}
            className="px-5 py-2 bg-[#1877F2] hover:bg-[#166fe5] text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            {publishing && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            )}
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  )
}
