'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import type { SlackConnection, Column, Client, SocialPage, ClientFbAdAccount } from '@/types'

interface Props {
  isConnected: boolean
  expiresAt: string | null
  boxRootFolderId: string | null
  boxWebhookId: string | null
  boxStatus: string | null
  errorDetail?: string | null
  slackStatus: string | null
  slackConnection: SlackConnection | null
  allColumns: Column[]
  allClients: Pick<Client, 'id' | 'name' | 'fb_ad_account_id'>[]
  metaStatus: string | null
  isMetaTokenConnected: boolean
  metaPages: Pick<SocialPage, 'id' | 'page_name' | 'fb_page_id' | 'ig_account_id' | 'status' | 'connected_at'>[]
  emailNotifyOnReview: boolean
}

export default function SettingsClient({
  isConnected,
  expiresAt,
  boxRootFolderId,
  boxWebhookId,
  boxStatus,
  errorDetail,
  slackStatus,
  slackConnection,
  allColumns,
  allClients,
  metaStatus,
  isMetaTokenConnected,
  metaPages,
  emailNotifyOnReview,
}: Props) {
  const [showBoxSuccess, setShowBoxSuccess] = useState(boxStatus === 'connected')
  const [showBoxError, setShowBoxError] = useState(boxStatus === 'error')
  const [webhookFolderId, setWebhookFolderId] = useState(boxRootFolderId ?? '')
  const [registeredWebhookId, setRegisteredWebhookId] = useState(boxWebhookId)
  const [registeringWebhook, setRegisteringWebhook] = useState(false)
  const [webhookError, setWebhookError] = useState<string | null>(null)
  const [showSlackSuccess, setShowSlackSuccess] = useState(slackStatus === 'connected')
  const [showSlackError, setShowSlackError] = useState(slackStatus === 'error')
  const [showMetaSuccess, setShowMetaSuccess] = useState(metaStatus === 'connected')
  const [showMetaError, setShowMetaError] = useState(metaStatus === 'error')

  // Slack preferences state — initialised from the server-fetched connection
  const [watchedColumns, setWatchedColumns] = useState<string[]>(
    slackConnection?.watched_columns ?? []
  )
  const [watchAllClients, setWatchAllClients] = useState<boolean>(
    slackConnection?.watch_all_clients ?? true
  )
  const [watchedClients, setWatchedClients] = useState<string[]>(
    slackConnection?.watched_clients ?? []
  )
  const [prefSaving, setPrefSaving] = useState(false)
  const [prefSaved, setPrefSaved] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [slackConn, setSlackConn] = useState<SlackConnection | null>(slackConnection)

  // Email notification opt-in (per-user; default off)
  const [emailNotify, setEmailNotify] = useState(emailNotifyOnReview)
  const [emailSaving, setEmailSaving] = useState(false)

  const toggleEmailNotify = useCallback(async () => {
    const next = !emailNotify
    setEmailNotify(next)
    setEmailSaving(true)
    try {
      const res = await fetch('/api/adviewer/email-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notify_on_review: next }),
      })
      if (!res.ok) setEmailNotify(!next) // revert on failure
    } catch {
      setEmailNotify(!next)
    } finally {
      setEmailSaving(false)
    }
  }, [emailNotify])

  useEffect(() => {
    if (showBoxSuccess) {
      const t = setTimeout(() => setShowBoxSuccess(false), 5000)
      return () => clearTimeout(t)
    }
  }, [showBoxSuccess])

  useEffect(() => {
    if (showSlackSuccess) {
      const t = setTimeout(() => setShowSlackSuccess(false), 5000)
      return () => clearTimeout(t)
    }
  }, [showSlackSuccess])

  useEffect(() => {
    if (prefSaved) {
      const t = setTimeout(() => setPrefSaved(false), 3000)
      return () => clearTimeout(t)
    }
  }, [prefSaved])

  useEffect(() => {
    if (showMetaSuccess) {
      const t = setTimeout(() => setShowMetaSuccess(false), 5000)
      return () => clearTimeout(t)
    }
  }, [showMetaSuccess])

  // Multi-account: keyed by client ID, loaded from junction table
  const [clientAccounts, setClientAccounts] = useState<Record<string, ClientFbAdAccount[]>>({})
  const [addingFor, setAddingFor] = useState<string | null>(null)
  const [newAccountId, setNewAccountId] = useState('')
  const [newAccountLabel, setNewAccountLabel] = useState('')
  const [savingAccount, setSavingAccount] = useState(false)
  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null)

  useEffect(() => {
    async function loadAllAccounts() {
      const results = await Promise.all(
        allClients.map(async (c) => {
          const res = await fetch(`/api/clients/fb-ad-accounts?clientId=${c.id}`)
          if (!res.ok) return [c.id, []] as [string, ClientFbAdAccount[]]
          const json = await res.json() as { accounts: ClientFbAdAccount[] }
          return [c.id, json.accounts] as [string, ClientFbAdAccount[]]
        })
      )
      setClientAccounts(Object.fromEntries(results))
    }
    void loadAllAccounts()
  }, [allClients])

  async function handleRegisterWebhook() {
    const folderId = webhookFolderId.trim()
    if (!folderId) return
    setRegisteringWebhook(true)
    setWebhookError(null)
    try {
      const res = await fetch('/api/box/webhook/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootFolderId: folderId }),
      })
      const data = await res.json() as { webhookId?: string; error?: string }
      if (!res.ok || !data.webhookId) {
        setWebhookError(data.error ?? 'Registration failed')
      } else {
        setRegisteredWebhookId(data.webhookId)
      }
    } catch {
      setWebhookError('Request failed')
    } finally {
      setRegisteringWebhook(false)
    }
  }

  async function handleAddAccount(clientId: string) {
    const accountId = newAccountId.trim()
    if (!accountId) return
    setSavingAccount(true)
    try {
      const res = await fetch('/api/clients/fb-ad-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, accountId, label: newAccountLabel.trim() || undefined }),
      })
      if (res.ok) {
        const json = await res.json() as { account: ClientFbAdAccount }
        setClientAccounts(prev => ({
          ...prev,
          [clientId]: [...(prev[clientId] ?? []), json.account],
        }))
        setNewAccountId('')
        setNewAccountLabel('')
        setAddingFor(null)
      }
    } finally {
      setSavingAccount(false)
    }
  }

  async function handleDeleteAccount(clientId: string, id: string) {
    setDeletingAccountId(id)
    try {
      await fetch('/api/clients/fb-ad-accounts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      setClientAccounts(prev => ({
        ...prev,
        [clientId]: (prev[clientId] ?? []).filter(a => a.id !== id),
      }))
    } finally {
      setDeletingAccountId(null)
    }
  }

  const toggleColumn = useCallback((colId: string) => {
    setWatchedColumns((prev) =>
      prev.includes(colId) ? prev.filter((id) => id !== colId) : [...prev, colId]
    )
  }, [])

  const toggleClient = useCallback((clientId: string) => {
    setWatchedClients((prev) =>
      prev.includes(clientId) ? prev.filter((id) => id !== clientId) : [...prev, clientId]
    )
  }, [])

  const savePreferences = useCallback(async () => {
    setPrefSaving(true)
    try {
      const res = await fetch('/api/slack/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ watched_columns: watchedColumns, watch_all_clients: watchAllClients, watched_clients: watchedClients }),
      })
      if (res.ok) setPrefSaved(true)
    } finally {
      setPrefSaving(false)
    }
  }, [watchedColumns, watchAllClients, watchedClients])

  const disconnectSlack = useCallback(async () => {
    setDisconnecting(true)
    try {
      const res = await fetch('/api/slack/disconnect', { method: 'DELETE' })
      if (res.ok) {
        setSlackConn(null)
        setWatchedColumns([])
        setWatchAllClients(true)
        setWatchedClients([])
      }
    } finally {
      setDisconnecting(false)
    }
  }, [])

  return (
    <div className="min-h-screen bg-[#0f1117] text-white">
      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Link href="/board" className="text-gray-400 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </Link>
          <h1 className="text-xl font-semibold">Settings</h1>
        </div>

        {/* Box notifications */}
        {showBoxSuccess && (
          <div className="mb-6 flex items-center gap-2 bg-green-900/40 border border-green-700/60 rounded-lg px-4 py-3 text-green-300 text-sm">
            <svg className="w-4 h-4 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Box connected successfully.
          </div>
        )}
        {showBoxError && (
          <div className="mb-6 bg-red-900/40 border border-red-700/60 rounded-lg px-4 py-3 text-red-300 text-sm">
            <div className="flex items-center gap-2">
              <span>Box connection failed. Please try again.</span>
              <button onClick={() => setShowBoxError(false)} className="ml-auto text-red-400 hover:text-red-200">✕</button>
            </div>
            {errorDetail && (
              <p className="mt-1.5 text-xs text-red-400/80 font-mono break-all">{errorDetail}</p>
            )}
          </div>
        )}

        {/* Slack notifications */}
        {showSlackSuccess && (
          <div className="mb-6 flex items-center gap-2 bg-green-900/40 border border-green-700/60 rounded-lg px-4 py-3 text-green-300 text-sm">
            <svg className="w-4 h-4 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Slack connected successfully.
          </div>
        )}
        {showSlackError && (
          <div className="mb-6 bg-red-900/40 border border-red-700/60 rounded-lg px-4 py-3 text-red-300 text-sm">
            <div className="flex items-center gap-2">
              <span>Slack connection failed. {errorDetail ? `(${errorDetail})` : 'Please try again.'}</span>
              <button onClick={() => setShowSlackError(false)} className="ml-auto text-red-400 hover:text-red-200">✕</button>
            </div>
          </div>
        )}

        {/* Meta notifications */}
        {showMetaSuccess && (
          <div className="mb-6 flex items-center gap-2 bg-green-900/40 border border-green-700/60 rounded-lg px-4 py-3 text-green-300 text-sm">
            <svg className="w-4 h-4 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Facebook pages connected successfully.
          </div>
        )}
        {showMetaError && (
          <div className="mb-6 bg-red-900/40 border border-red-700/60 rounded-lg px-4 py-3 text-red-300 text-sm">
            <div className="flex items-center gap-2">
              <span>Facebook connection failed. Please try again.</span>
              <button onClick={() => setShowMetaError(false)} className="ml-auto text-red-400 hover:text-red-200">✕</button>
            </div>
            {errorDetail && (
              <p className="mt-1.5 text-xs text-red-400/80 font-mono break-all">{errorDetail}</p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-5">
          {/* Email notifications (per-user, all staff) */}
          <div className="bg-[#141820] border border-gray-700/60 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-purple-600 flex items-center justify-center flex-none">
                  <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">Email notifications</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Email me when a client approves or requests changes on a review</p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void toggleEmailNotify()}
                disabled={emailSaving}
                role="switch"
                aria-checked={emailNotify}
                className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors disabled:opacity-50 ${emailNotify ? 'bg-purple-600' : 'bg-gray-600'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${emailNotify ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-3 pt-3 border-t border-gray-700/40">
              Off by default. Only staff who turn this on receive review-submission emails.
            </p>
          </div>

          {/* Box Integration */}
          <div className="bg-[#141820] border border-gray-700/60 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center flex-none">
                  <span className="text-white font-bold text-sm">Box</span>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">Box</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Connect Box to enable creative file downloads for TTD exports</p>
                </div>
              </div>

              {isConnected ? (
                <div className="flex items-center gap-2 flex-none">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  <span className="text-xs text-green-400 font-medium">Connected</span>
                </div>
              ) : null}
            </div>

            {isConnected ? (
              <div className="mt-4 pt-4 border-t border-gray-700/40 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-gray-400">
                      Token expires: {expiresAt ? new Date(expiresAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown'}
                    </p>
                    <p className="text-[11px] text-gray-500 mt-0.5">Refreshes automatically on export</p>
                  </div>
                  <a
                    href="/api/box/auth"
                    className="text-xs text-gray-400 hover:text-white transition-colors border border-gray-600 hover:border-gray-400 rounded-lg px-3 py-1.5"
                  >
                    Reconnect
                  </a>
                </div>

                {/* Webhook registration */}
                <div className="pt-3 border-t border-gray-700/40">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-gray-300">File Sync Webhook</p>
                    {registeredWebhookId && (
                      <span className="flex items-center gap-1 text-[10px] text-green-400 font-medium">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        Registered
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-500 mb-3">
                    Paste your Box &ldquo;Client Projects&rdquo; folder ID. When a designer saves a new file to any Build folder, it auto-syncs to the board card and Adviewer.
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={webhookFolderId}
                      onChange={(e) => setWebhookFolderId(e.target.value)}
                      placeholder="Box folder ID (e.g. 123456789)"
                      className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={() => void handleRegisterWebhook()}
                      disabled={registeringWebhook || !webhookFolderId.trim()}
                      className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white rounded-lg transition-colors whitespace-nowrap"
                    >
                      {registeringWebhook ? 'Registering…' : registeredWebhookId ? 'Re-register' : 'Register'}
                    </button>
                  </div>
                  {registeredWebhookId && (
                    <p className="mt-1.5 text-[10px] text-gray-600 font-mono">Webhook ID: {registeredWebhookId}</p>
                  )}
                  {webhookError && (
                    <p className="mt-1.5 text-[10px] text-red-400">{webhookError}</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-4 pt-4 border-t border-gray-700/40">
                <a
                  href="/api/box/auth"
                  className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  Connect Box Account
                </a>
                <p className="text-[11px] text-gray-500 mt-2">You&apos;ll be redirected to Box to authorize access. Only one person needs to connect.</p>
              </div>
            )}
          </div>

          {/* Slack Integration */}
          <div className="bg-[#141820] border border-gray-700/60 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                {/* Slack logo */}
                <div className="w-10 h-10 rounded-lg bg-[#4A154B] flex items-center justify-center flex-none">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="white"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">Slack</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Get personal DMs when cards move to columns you&apos;re watching</p>
                </div>
              </div>

              {slackConn ? (
                <div className="flex items-center gap-2 flex-none">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  <span className="text-xs text-green-400 font-medium">Connected</span>
                </div>
              ) : null}
            </div>

            {slackConn ? (
              <div className="mt-4 pt-4 border-t border-gray-700/40 space-y-5">
                {/* Connected as */}
                <div className="flex items-center justify-between">
                  <p className="text-xs text-gray-400">
                    Connected as <span className="text-white font-medium">{slackConn.slack_user_name ?? slackConn.slack_user_id}</span>
                    {slackConn.slack_team_name ? <span className="text-gray-500"> · {slackConn.slack_team_name}</span> : null}
                  </p>
                  <button
                    onClick={disconnectSlack}
                    disabled={disconnecting}
                    className="text-xs text-gray-400 hover:text-red-400 transition-colors border border-gray-600 hover:border-red-700/60 rounded-lg px-3 py-1.5 disabled:opacity-50"
                  >
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </div>

                {/* Column preferences */}
                <div>
                  <p className="text-xs font-medium text-gray-300 mb-2">Notify me when a card moves to:</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {allColumns.map((col) => (
                      <label key={col.id} className="flex items-center gap-2 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={watchedColumns.includes(col.id)}
                          onChange={() => toggleColumn(col.id)}
                          className="w-3.5 h-3.5 accent-[#4A154B] cursor-pointer"
                        />
                        <span className="text-xs text-gray-400 group-hover:text-white transition-colors">{col.title}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Client preferences */}
                <div>
                  <p className="text-xs font-medium text-gray-300 mb-2">Watch:</p>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="client_scope"
                        checked={watchAllClients}
                        onChange={() => setWatchAllClients(true)}
                        className="accent-[#4A154B]"
                      />
                      <span className="text-xs text-gray-400">All clients</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="client_scope"
                        checked={!watchAllClients}
                        onChange={() => setWatchAllClients(false)}
                        className="accent-[#4A154B]"
                      />
                      <span className="text-xs text-gray-400">Specific clients only</span>
                    </label>
                  </div>

                  {!watchAllClients && (
                    <div className="mt-3 grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto pr-1">
                      {allClients.map((client) => (
                        <label key={client.id} className="flex items-center gap-2 cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={watchedClients.includes(client.id)}
                            onChange={() => toggleClient(client.id)}
                            className="w-3.5 h-3.5 accent-[#4A154B] cursor-pointer"
                          />
                          <span className="text-xs text-gray-400 group-hover:text-white transition-colors truncate">{client.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {/* Save button */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={savePreferences}
                    disabled={prefSaving}
                    className="bg-[#4A154B] hover:bg-[#611f69] text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {prefSaving ? 'Saving…' : 'Save preferences'}
                  </button>
                  {prefSaved && (
                    <span className="text-xs text-green-400">Saved</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-4 pt-4 border-t border-gray-700/40">
                <a
                  href="/api/slack/oauth/start"
                  className="inline-flex items-center gap-2 bg-[#4A154B] hover:bg-[#611f69] text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
                  </svg>
                  Connect Slack
                </a>
                <p className="text-[11px] text-gray-500 mt-2">
                  Each person connects their own Slack account. You&apos;ll only receive DMs — no shared channels.
                </p>
              </div>
            )}
          </div>
          {/* Facebook & Instagram */}
          <div className="bg-[#141820] border border-gray-700/60 rounded-xl p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-[#1877F2] flex items-center justify-center flex-none">
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
                    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white">Facebook &amp; Instagram</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Connect to enable the social post scheduler</p>
                </div>
              </div>

              {isMetaTokenConnected ? (
                <div className="flex items-center gap-2 flex-none">
                  <span className="w-2 h-2 rounded-full bg-green-400" />
                  <span className="text-xs text-green-400 font-medium">
                    {metaPages.length > 0 ? `${metaPages.length} page${metaPages.length !== 1 ? 's' : ''} connected` : 'Connected'}
                  </span>
                </div>
              ) : null}
            </div>

            <div className="mt-4 pt-4 border-t border-gray-700/40 space-y-4">
              {isMetaTokenConnected ? (
                <div className="space-y-2">
                  {metaPages.map((page) => (
                    <div key={page.id} className="flex items-center justify-between py-1.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full flex-none ${page.status === 'active' ? 'bg-green-400' : 'bg-yellow-400'}`} />
                        <span className="text-xs text-white font-medium truncate">{page.page_name}</span>
                        {page.ig_account_id ? (
                          <span className="text-[10px] bg-pink-900/40 text-pink-300 border border-pink-700/40 rounded px-1.5 py-0.5 flex-none">IG</span>
                        ) : null}
                      </div>
                      <span className="text-[11px] text-gray-500 flex-none ml-3">
                        {new Date(page.connected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex items-center gap-3">
                <a
                  href="/api/meta/auth"
                  className="inline-flex items-center gap-2 bg-[#1877F2] hover:bg-[#166fe5] text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
                    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                  </svg>
                  {isMetaTokenConnected ? 'Reconnect' : 'Connect Facebook'}
                </a>
                {isMetaTokenConnected ? (
                  <span className="text-[11px] text-gray-500">Re-run to pick up newly added pages.</span>
                ) : (
                  <span className="text-[11px] text-gray-500">Log in with the FTE Facebook account that has Page Admin access.</span>
                )}
              </div>
            </div>
          </div>

          {/* ── Facebook Ad Accounts ─────────────────────────────────────────── */}
          <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold text-white">Facebook Ad Accounts</h2>
              <span className="text-[11px] text-gray-500">Multiple accounts per client supported</span>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Add the ad account ID(s) for each client (format: <span className="font-mono text-gray-300">act_123456789</span>). Required to publish ads via the Marketing API.
            </p>
            <div className="space-y-3">
              {allClients.map((client) => {
                const accounts = clientAccounts[client.id] ?? []
                const isAdding = addingFor === client.id
                return (
                  <div key={client.id} className="rounded-lg border border-gray-700/60 overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-gray-900/40">
                      <span className="text-xs font-medium text-gray-300">{client.name}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setAddingFor(isAdding ? null : client.id)
                          setNewAccountId('')
                          setNewAccountLabel('')
                        }}
                        className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        {isAdding ? 'Cancel' : '+ Add account'}
                      </button>
                    </div>
                    {accounts.length > 0 && (
                      <div className="divide-y divide-gray-700/40">
                        {accounts.map((acc) => (
                          <div key={acc.id} className="flex items-center gap-2 px-3 py-2">
                            <span className="font-mono text-xs text-gray-200 flex-1">{acc.account_id}</span>
                            {acc.label && (
                              <span className="text-[11px] text-gray-500 truncate max-w-[120px]">{acc.label}</span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteAccount(client.id, acc.id)}
                              disabled={deletingAccountId === acc.id}
                              className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-40 transition-colors ml-1"
                            >
                              {deletingAccountId === acc.id ? '…' : '✕'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {isAdding && (
                      <div className="px-3 py-2 bg-gray-900/20 border-t border-gray-700/40 space-y-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={newAccountId}
                            onChange={(e) => setNewAccountId(e.target.value)}
                            placeholder="act_123456789"
                            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 font-mono focus:outline-none focus:border-blue-500"
                          />
                          <input
                            type="text"
                            value={newAccountLabel}
                            onChange={(e) => setNewAccountLabel(e.target.value)}
                            placeholder="Label (optional)"
                            className="w-32 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() => handleAddAccount(client.id)}
                            disabled={savingAccount || !newAccountId.trim()}
                            className="px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded disabled:opacity-40 transition-colors flex-none"
                          >
                            {savingAccount ? '…' : 'Add'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
