'use client'

import { useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Card, Client, Column } from '@/types'
import ClientPanel from '@/components/ClientPanel'
import { VIDEO_DESIGNER_KEY, VIDEO_MEDIA_TYPES, type Designer } from '@/lib/designers'
import { saveStaffSetting } from '@/lib/staffSettings'
import CardDrawer from '@/components/CardDrawer'
import {
  BLANK_CLIENT_FORM,
  formFromClient,
  validateClientForm,
  type ClientAccountRow,
  type ClientFormInput,
  type FieldErrors,
} from '@/lib/clientAdmin'

interface ClientWithCount extends Client {
  active_live_count: number
}

interface Props {
  clients: ClientWithCount[]
  columns: Column[]
  userEmail: string
  videoDesigner: Designer | null
  /** ops.client_accounts rows, via the service-role RPC. */
  accounts: ClientAccountRow[]
  /** True when that RPC failed (migration not applied yet). */
  accountsUnavailable: boolean
}

// Designer dropdown value for "add someone not listed yet".
const NEW_DESIGNER = '__new__'

const INPUT = 'w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

export default function ClientsPageContent({ clients: initialClients, columns, userEmail, videoDesigner: initialVideoDesigner, accounts: initialAccounts, accountsUnavailable }: Props) {
  const supabase = createClient()

  const [clients, setClients] = useState(initialClients)
  const [accounts, setAccounts] = useState<Record<string, ClientAccountRow>>(
    () => Object.fromEntries(initialAccounts.map((a) => [a.client_id, a])),
  )
  const [videoDesigner, setVideoDesigner] = useState<Designer | null>(initialVideoDesigner)
  const [videoSaving, setVideoSaving] = useState(false)
  const [videoError, setVideoError] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [selectedCard, setSelectedCard] = useState<Card | null>(null)

  // Add/edit state
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ClientFormInput>(BLANK_CLIENT_FORM)
  const [designerChoice, setDesignerChoice] = useState('')
  const [newDesigner, setNewDesigner] = useState({ name: '', email: '' })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  // Delete state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Portal link state — tracks which client just had their link copied
  const [copiedPortalId, setCopiedPortalId] = useState<string | null>(null)

  const handlePortalLink = useCallback(async (client: ClientWithCount) => {
    let token = client.review_token
    if (!token) {
      token = crypto.randomUUID()
      const { error } = await supabase
        .from('clients')
        .update({ review_token: token })
        .eq('id', client.id)
      if (error) return
      setClients((prev) =>
        prev.map((c) => c.id === client.id ? { ...c, review_token: token } : c)
      )
    }
    await navigator.clipboard.writeText(`${window.location.origin}/review/${token}`)
    setCopiedPortalId(client.id)
    setTimeout(() => setCopiedPortalId((prev) => prev === client.id ? null : prev), 2000)
  }, [supabase])

  // Designers = every distinct name/email already assigned to a client. A new
  // designer is added by assigning them to a client ("+ New designer…"), so there
  // is no separate list to maintain.
  const designers = Array.from(
    new Map(
      clients
        .filter((c) => c.designer_name && c.designer_email)
        .map((c) => [c.designer_email!.toLowerCase(), { name: c.designer_name!, email: c.designer_email! }]),
    ).values(),
  ).sort((a, b) => a.name.localeCompare(b.name))

  // Video work (see lib/designers.ts) belongs to one designer whatever the client.
  // Stored in app_settings so it changes here, not in code. Saved through the
  // staff settings route: RLS keeps app_settings writes admin-only.
  const saveVideoDesigner = async (email: string) => {
    const d = email ? designers.find((x) => x.email.toLowerCase() === email.toLowerCase()) ?? null : null
    setVideoSaving(true)
    setVideoError('')
    const error = await saveStaffSetting(VIDEO_DESIGNER_KEY, d ? JSON.stringify(d) : null)
    if (error) setVideoError(error)
    else setVideoDesigner(d)
    setVideoSaving(false)
  }

  const resetForm = (next: ClientFormInput, designerEmail: string) => {
    setForm(next)
    setDesignerChoice(designerEmail)
    setNewDesigner({ name: '', email: '' })
    setFormError('')
    setFieldErrors({})
  }

  const openAdd = () => {
    setEditingId(null)
    resetForm(BLANK_CLIENT_FORM, '')
    setShowAddForm(true)
  }

  const openEdit = (client: ClientWithCount) => {
    setEditingId(client.id)
    resetForm(formFromClient(client, accounts[client.id] ?? null), client.designer_email ?? '')
    setShowAddForm(true)
  }

  const closeForm = () => {
    setShowAddForm(false)
    setEditingId(null)
    resetForm(BLANK_CLIENT_FORM, '')
  }

  const setField = <K extends keyof ClientFormInput>(key: K, value: ClientFormInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setFieldErrors((e) => (e[key] ? { ...e, [key]: undefined } : e))
  }

  const saveClient = async () => {
    let designer_name = ''
    let designer_email = ''
    if (designerChoice === NEW_DESIGNER) {
      designer_name = newDesigner.name
      designer_email = newDesigner.email
      if (!designer_name.trim() || !designer_email.trim()) {
        setFieldErrors({ designer_email: 'New designer needs a name and their login email.' })
        return
      }
    } else if (designerChoice) {
      const d = designers.find((x) => x.email.toLowerCase() === designerChoice.toLowerCase())
      designer_name = d?.name ?? ''
      designer_email = d?.email ?? ''
    }
    const input: ClientFormInput = { ...form, designer_name, designer_email }

    // Same checks the API runs, so most mistakes never leave the browser.
    const local = validateClientForm(input, clients, editingId)
    if (!local.client) {
      setFieldErrors(local.errors)
      setFormError('Fix the highlighted fields.')
      return
    }

    setSaving(true)
    setFormError('')
    setFieldErrors({})
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: editingId, form: input }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        client?: Client
        account?: ClientAccountRow | null
        error?: string
        fieldErrors?: FieldErrors
      }
      if (!res.ok || !body.client) {
        setFieldErrors(body.fieldErrors ?? {})
        setFormError(body.error ?? `Save failed (${res.status})`)
        return
      }
      const saved = body.client
      setClients((prev) => {
        const rest = prev.filter((c) => c.id !== saved.id)
        const count = prev.find((c) => c.id === saved.id)?.active_live_count ?? 0
        return [...rest, { ...saved, active_live_count: count }].sort((a, b) => a.name.localeCompare(b.name))
      })
      if (body.account) {
        const acct = body.account
        setAccounts((prev) => ({ ...prev, [acct.client_id]: acct }))
      }
      closeForm()
    } catch {
      setFormError('Save failed — check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const deactivateClient = async (clientId: string) => {
    setDeleting(true)
    const { error } = await supabase.from('clients').update({ active: false }).eq('id', clientId)
    if (!error) setClients((prev) => prev.map((c) => c.id === clientId ? { ...c, active: false } : c))
    setConfirmDeleteId(null)
    setDeleting(false)
  }

  const restoreClient = async (clientId: string) => {
    const { error } = await supabase.from('clients').update({ active: true }).eq('id', clientId)
    if (!error) setClients((prev) => prev.map((c) => c.id === clientId ? { ...c, active: true } : c))
  }

  return (
    <div className="min-h-screen bg-[#0f1117]">
      {/* Header */}
      <div className="border-b border-gray-700/60 bg-gray-900/50">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-white">Clients</h1>
            <p className="text-xs text-gray-400 mt-0.5">{clients.length} clients</p>
          </div>
          <div className="flex items-center gap-3">
            {clients.some(c => !c.active) && (
              <button
                onClick={() => setShowInactive(v => !v)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${showInactive ? 'border-gray-500 text-gray-200 bg-gray-700/50' : 'border-gray-700 text-gray-500 hover:text-gray-300'}`}
              >
                {showInactive ? 'Hide' : 'Show'} inactive ({clients.filter(c => !c.active).length})
              </button>
            )}
            <button
              onClick={openAdd}
              className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors font-medium"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Client
            </button>
            <a href="/board" className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back to Board
            </a>
          </div>
        </div>
      </div>

      {/* Client grid */}
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-gray-700/50 bg-gray-800/40 px-4 py-3">
          <p className="text-xs text-gray-300">
            <span className="font-semibold text-white">Video work</span> ({VIDEO_MEDIA_TYPES.join(' & ')}s) goes to
          </p>
          <select
            value={videoDesigner?.email ?? ''}
            onChange={(e) => void saveVideoDesigner(e.target.value)}
            disabled={videoSaving}
            className="bg-gray-900 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          >
            <option value="">the client&apos;s designer</option>
            {designers.map((d) => <option key={d.email} value={d.email}>{d.name}</option>)}
          </select>
          <p className="text-[11px] text-gray-500">whatever the client — their pill shows on those cards.</p>
          {videoError && <p className="text-[11px] text-red-400 w-full">{videoError}</p>}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {clients.filter(c => c.active || showInactive).map((client) => (
            <div
              key={client.id}
              className={`relative bg-gray-900 border rounded-xl p-4 transition-all group ${
                client.active
                  ? 'border-gray-700/60 hover:border-gray-500 hover:bg-gray-800/80'
                  : 'border-gray-700/30 opacity-50'
              }`}
            >
              {/* Edit / Deactivate / Restore buttons */}
              <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {client.active ? (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); openEdit(client) }}
                      className="p-1 text-gray-500 hover:text-gray-200 hover:bg-gray-700 rounded transition-colors"
                      title="Edit client"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(client.id) }}
                      className="p-1 text-gray-500 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                      title="Deactivate client"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                      </svg>
                    </button>
                  </>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); restoreClient(client.id) }}
                    className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1 hover:bg-gray-700 rounded transition-colors"
                    title="Restore client"
                  >
                    Restore
                  </button>
                )}
              </div>

              <button
                className="w-full text-left"
                onClick={() => client.active && setSelectedClientId(client.id)}
                disabled={!client.active}
              >
                <div className="flex items-center gap-3 mb-3">
                  {client.fb_page_logo_url ? (
                    <img src={client.fb_page_logo_url} alt={client.name} className="w-10 h-10 rounded-full object-cover flex-none" />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold flex-none">
                      {client.name.charAt(0)}
                    </div>
                  )}
                  <div className="min-w-0 pr-10">
                    <p className="text-sm font-semibold text-white truncate">{client.name}</p>
                    {client.abbreviation && (
                      <p className="text-xs text-gray-400">{client.abbreviation}</p>
                    )}
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      {client.designer_name ? <span className="text-[#e9c6f5]">{client.designer_name}</span> : 'No designer'}
                      {client.tier && <span className="ml-1.5 text-gray-400">· {client.tier}</span>}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  {client.active_live_count > 0 ? (
                    <span className="flex items-center gap-1.5 text-xs text-green-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
                      {client.active_live_count} live
                    </span>
                  ) : (
                    <span className="text-xs text-gray-500">{client.active ? 'No live cards' : 'Inactive'}</span>
                  )}
                  {client.active && (
                    <span className="text-xs text-gray-400 group-hover:text-blue-400 transition-colors">
                      View timeline →
                    </span>
                  )}
                </div>
              </button>

              {/* Portal link row */}
              {client.active && (
                <div className="mt-3 pt-3 border-t border-gray-700/40 flex items-center gap-2">
                  <button
                    onClick={(e) => { e.stopPropagation(); handlePortalLink(client) }}
                    className="flex-1 flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-300 transition-colors truncate"
                    title={client.review_token ? `${window?.location?.origin ?? ''}/review/${client.review_token}` : 'Generate portal link'}
                  >
                    <svg className="w-3.5 h-3.5 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span className="truncate">
                      {copiedPortalId === client.id
                        ? '✓ Link copied!'
                        : client.review_token
                        ? 'Copy portal link'
                        : 'Generate portal link'}
                    </span>
                  </button>
                  {client.review_token && (
                    <a
                      href={`/review/${client.review_token}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex-none text-xs text-gray-500 hover:text-blue-300 transition-colors"
                      title="Open portal"
                    >
                      Open ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {clients.length === 0 && (
          <div className="text-center py-20 text-gray-500">
            <p className="text-sm">No clients yet.</p>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      {showAddForm && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={closeForm} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-[#141820] border border-gray-700/60 rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">
              <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700/40">
                <h2 className="text-sm font-semibold text-white">{editingId ? 'Edit Client' : 'Add Client'}</h2>
                <button onClick={closeForm} className="text-gray-400 hover:text-white p-1" aria-label="Close">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="px-5 py-4 space-y-5 overflow-y-auto">
                <Section title="Client">
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Client name" required error={fieldErrors.name} className="col-span-2">
                      <input type="text" value={form.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. Community Fund of Greater Springfield" autoFocus className={INPUT} />
                    </Field>
                    <Field label="Abbreviation" required error={fieldErrors.abbreviation} hint="File naming: SKY-M4-Name-300x250.gif">
                      <input type="text" value={form.abbreviation} onChange={(e) => setField('abbreviation', e.target.value)} placeholder="e.g. ACME" className={`${INPUT} uppercase`} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Designer" error={fieldErrors.designer_email} className="col-span-2">
                      <select value={designerChoice} onChange={(e) => { setDesignerChoice(e.target.value); setFieldErrors((x) => ({ ...x, designer_email: undefined })) }} className={INPUT}>
                        <option value="">No designer</option>
                        {designers.map((d) => <option key={d.email} value={d.email}>{d.name}</option>)}
                        <option value={NEW_DESIGNER}>+ New designer…</option>
                      </select>
                    </Field>
                    <Field label="Tier" error={fieldErrors.tier}>
                      <select value={form.tier} onChange={(e) => setField('tier', e.target.value)} className={INPUT}>
                        <option value="">—</option>
                        <option value="T1">T1</option>
                        <option value="T2">T2</option>
                        <option value="T3">T3</option>
                      </select>
                    </Field>
                  </div>
                  {designerChoice === NEW_DESIGNER && (
                    <div className="grid grid-cols-2 gap-3">
                      <input type="text" value={newDesigner.name} onChange={(e) => setNewDesigner((d) => ({ ...d, name: e.target.value }))} placeholder="Name on the pill, e.g. Alex" className={INPUT} />
                      <input type="email" value={newDesigner.email} onChange={(e) => setNewDesigner((d) => ({ ...d, email: e.target.value }))} placeholder="Their board login email" className={INPUT} />
                    </div>
                  )}
                  <p className="text-[11px] text-gray-500 -mt-1">Changing the designer moves every card for this client to them — the pill on the board reads from here.</p>
                  {editingId && (
                    <label className="flex items-center gap-2 text-xs text-gray-300">
                      <input type="checkbox" checked={form.active} onChange={(e) => setField('active', e.target.checked)} className="accent-blue-500" />
                      Active (unticked = hidden from the board and dropdowns)
                    </label>
                  )}
                </Section>

                <Section title="Brand" subtitle="Brenda reads these when reviewing copy and creative.">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Website" error={fieldErrors.brand_website_url}>
                      <input type="text" value={form.brand_website_url} onChange={(e) => setField('brand_website_url', e.target.value)} placeholder="https://example.org" className={INPUT} />
                    </Field>
                    <Field label="Logo URL" error={fieldErrors.fb_page_logo_url}>
                      <input type="text" value={form.fb_page_logo_url} onChange={(e) => setField('fb_page_logo_url', e.target.value)} placeholder="https://..." className={INPUT} />
                    </Field>
                  </div>
                  <Field label="Brand notes">
                    <textarea value={form.brand_notes} onChange={(e) => setField('brand_notes', e.target.value)} rows={3} placeholder="Voice, audience, words to avoid…" className={INPUT} />
                  </Field>
                  <Field label="Adviewer campaign code">
                    <input type="text" value={form.adpiler_campaign_code} onChange={(e) => setField('adpiler_campaign_code', e.target.value)} placeholder="e.g. T4XOPHIC9W" className={`${INPUT} font-mono`} />
                  </Field>
                </Section>

                <Section title="Ad platform accounts" subtitle="The campaign-ops record. Saved with an audit entry under your email.">
                  {accountsUnavailable && (
                    <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                      Couldn&apos;t load the existing account record, so these fields start blank and saving will fail until supabase/add_client_admin_rpc.sql has been run.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="TTD advertiser id" error={fieldErrors.ttd_advertiser_id}>
                      <input type="text" value={form.ttd_advertiser_id} onChange={(e) => setField('ttd_advertiser_id', e.target.value)} placeholder="e.g. 9zzzz9z" className={`${INPUT} font-mono`} />
                    </Field>
                    <Field label="Meta ad account id" error={fieldErrors.fb_ad_account_id}>
                      <input type="text" value={form.fb_ad_account_id} onChange={(e) => setField('fb_ad_account_id', e.target.value)} placeholder="act_… or digits" className={`${INPUT} font-mono`} />
                    </Field>
                    <Field label="Facebook Page id" error={fieldErrors.fb_page_id}>
                      <input type="text" value={form.fb_page_id} onChange={(e) => setField('fb_page_id', e.target.value)} placeholder="digits" className={`${INPUT} font-mono`} />
                    </Field>
                    <Field label="Meta pixel / dataset id" error={fieldErrors.fb_pixel_id}>
                      <input type="text" value={form.fb_pixel_id} onChange={(e) => setField('fb_pixel_id', e.target.value)} placeholder="digits" className={`${INPUT} font-mono`} />
                    </Field>
                    <Field label="Instagram account" error={fieldErrors.ig_account}>
                      <input type="text" value={form.ig_account} onChange={(e) => setField('ig_account', e.target.value)} placeholder="@handle" className={INPUT} />
                    </Field>
                  </div>
                  <Field label="Copy tracker" error={fieldErrors.copy_tracker_sheet_id} hint="Paste the sheet URL; the id is pulled out of it.">
                    <input type="text" value={form.copy_tracker_sheet_id} onChange={(e) => setField('copy_tracker_sheet_id', e.target.value)} placeholder="External Google Sheet link" className={INPUT} />
                  </Field>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Display tab gid" error={fieldErrors.tab_display}>
                      <input type="text" value={form.tab_display} onChange={(e) => setField('tab_display', e.target.value)} placeholder="digits after gid=" className={`${INPUT} font-mono`} />
                    </Field>
                    <Field label="Social tab gid" error={fieldErrors.tab_social}>
                      <input type="text" value={form.tab_social} onChange={(e) => setField('tab_social', e.target.value)} className={`${INPUT} font-mono`} />
                    </Field>
                    <Field label="CTV/Audio tab gid" error={fieldErrors.tab_ctv_audio}>
                      <input type="text" value={form.tab_ctv_audio} onChange={(e) => setField('tab_ctv_audio', e.target.value)} className={`${INPUT} font-mono`} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Budget feed (ABW) names" error={fieldErrors.abw_names} hint="One per line, as on the ABW / TapClicks budget feed.">
                      <textarea value={form.abw_names} onChange={(e) => setField('abw_names', e.target.value)} rows={2} placeholder="e.g. Sample Ford" className={INPUT} />
                    </Field>
                    <Field label="TTD advertiser names" error={fieldErrors.ttd_advertiser_names} hint="One per line, as Kokai shows the advertiser.">
                      <textarea value={form.ttd_advertiser_names} onChange={(e) => setField('ttd_advertiser_names', e.target.value)} rows={2} placeholder="e.g. Sample Ford" className={INPUT} />
                    </Field>
                  </div>
                  <p className="text-[11px] text-gray-500 -mt-1">The TTD coverage check uses these two lists to tie budget-feed lines and TTD campaigns to this client.</p>
                  <Field label="Standing client rules" hint="One per line, e.g. “No location names in copy”.">
                    <textarea value={form.rules} onChange={(e) => setField('rules', e.target.value)} rows={3} className={INPUT} />
                  </Field>
                  <Field label="Ops notes">
                    <textarea value={form.notes} onChange={(e) => setField('notes', e.target.value)} rows={2} className={INPUT} />
                  </Field>
                </Section>

                <details className="group">
                  <summary className="text-xs font-semibold text-gray-300 cursor-pointer select-none">Advanced: UTM settings</summary>
                  <div className="mt-3 space-y-3">
                    <Field label="UTM rules (ops)" hint="Plain-language UTM conventions for this client.">
                      <textarea value={form.utm_rules} onChange={(e) => setField('utm_rules', e.target.value)} rows={2} className={INPUT} />
                    </Field>
                    <Field label="UTM builder config (JSON)" error={fieldErrors.utm_config} hint="Leave blank for the default builder. See docs/features/utm-builder.md.">
                      <textarea value={form.utm_config} onChange={(e) => setField('utm_config', e.target.value)} rows={4} spellCheck={false} placeholder='{"campaign_presets": ["used"]}' className={`${INPUT} font-mono text-xs`} />
                    </Field>
                  </div>
                </details>
              </div>

              <div className="px-5 py-4 border-t border-gray-700/40 space-y-2">
                {formError && <p className="text-xs text-red-400">{formError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={saveClient}
                    disabled={saving}
                    className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors"
                  >
                    {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add Client'}
                  </button>
                  <button onClick={closeForm} className="px-4 text-sm text-gray-400 hover:text-gray-200 transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Delete Confirm Modal */}
      {confirmDeleteId && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setConfirmDeleteId(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-[#141820] border border-gray-700/60 rounded-xl w-full max-w-sm shadow-2xl p-5">
              <h2 className="text-sm font-semibold text-white mb-2">Deactivate client?</h2>
              <p className="text-xs text-gray-400 mb-4">
                <strong className="text-gray-200">{clients.find((c) => c.id === confirmDeleteId)?.name}</strong> will be hidden from the board and all dropdowns. All cards, flights, and history are preserved. You can restore them at any time.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => deactivateClient(confirmDeleteId)}
                  disabled={deleting}
                  className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition-colors"
                >
                  {deleting ? 'Deactivating…' : 'Deactivate'}
                </button>
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  className="flex-1 border border-gray-600 text-gray-300 hover:text-white text-sm py-2 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <ClientPanel
        clientId={selectedClientId}
        clients={clients}
        onClose={() => setSelectedClientId(null)}
        onOpenCard={(card) => {
          setSelectedClientId(null)
          setSelectedCard(card)
        }}
      />

      {selectedCard && (
        <CardDrawer
          card={selectedCard}
          columns={columns}
          clients={clients}
          doneColumnId={columns.find((c) => c.title === 'Done')?.id ?? null}
          onClose={() => setSelectedCard(null)}
          onUpdated={(updated) => setSelectedCard(updated)}
          onDeleted={() => setSelectedCard(null)}
          onColumnChanged={() => {}}
          userEmail={userEmail}
        />
      )}
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">{title}</h3>
        {subtitle && <p className="text-[11px] text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, required, error, hint, className, children }: {
  label: string
  required?: boolean
  error?: string
  hint?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={className}>
      <label className="block text-xs text-gray-400 mb-1">
        {label} {required && <span className="text-red-400">*</span>}
      </label>
      {children}
      {error ? <p className="text-[11px] text-red-400 mt-1">{error}</p> : hint ? <p className="text-[11px] text-gray-500 mt-1">{hint}</p> : null}
    </div>
  )
}
