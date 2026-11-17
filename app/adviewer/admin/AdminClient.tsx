'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

interface Project {
  id: string
  title: string
  description: string | null
  status: 'draft' | 'active' | 'archived'
  created_at: string
  updated_at: string
  client: { id: string; name: string } | { id: string; name: string }[] | null
  cards: { id: string }[]
}

interface ClientRow {
  id: string
  name: string
}

interface AdviewerClientRow {
  id: string
  client_id: string
  email: string
  created_at: string
  last_login_at: string | null
}

interface Props {
  projects: Project[]
  clients: ClientRow[]
  adviewerClients: AdviewerClientRow[]
}

const STATUS_STYLES: Record<string, string> = {
  active:   'bg-green-50 text-green-700 border-green-200',
  draft:    'bg-gray-100 text-gray-500 border-gray-200',
  archived: 'bg-gray-100 text-gray-400 border-gray-200',
}

function getClientName(client: Project['client']): string {
  if (!client) return '—'
  if (Array.isArray(client)) return client[0]?.name ?? '—'
  return client.name
}

function getClientId(client: Project['client']): string {
  if (!client) return ''
  if (Array.isArray(client)) return client[0]?.id ?? ''
  return client.id
}

function fmt(d: string) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function AdminClient({ projects, clients, adviewerClients }: Props) {
  const router = useRouter()
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const [tab, setTab] = useState<'projects' | 'access'>('projects')

  // Create project form
  const [showCreate, setShowCreate] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newClientId, setNewClientId] = useState('')
  const [creating, setCreating] = useState(false)

  // Invite client form
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteClientId, setInviteClientId] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteSuccess, setInviteSuccess] = useState(false)

  async function handleCreateProject() {
    if (!newTitle.trim() || !newClientId) return
    setCreating(true)
    const { data, error } = await supabase
      .from('adviewer_projects')
      .insert({
        title: newTitle.trim(),
        description: newDesc.trim() || null,
        client_id: newClientId,
        status: 'draft',
      })
      .select('id')
      .single()

    setCreating(false)
    if (!error && data) {
      setShowCreate(false)
      setNewTitle('')
      setNewDesc('')
      setNewClientId('')
      router.push(`/adviewer/admin/projects/${data.id}`)
    }
  }

  async function handleInviteClient() {
    if (!inviteEmail.trim() || !inviteClientId) return
    setInviting(true)
    setInviteError(null)

    // Create adviewer_clients record
    const { error: insertError } = await supabase
      .from('adviewer_clients')
      .insert({
        client_id: inviteClientId,
        email: inviteEmail.trim().toLowerCase(),
      })

    if (insertError) {
      setInviting(false)
      setInviteError(
        insertError.message.includes('unique')
          ? 'That email already has access.'
          : insertError.message
      )
      return
    }

    // Send Supabase magic link invite
    const { error: inviteErr } = await supabase.auth.signInWithOtp({
      email: inviteEmail.trim().toLowerCase(),
      options: {
        emailRedirectTo: `${window.location.origin}/adviewer/auth/callback`,
        shouldCreateUser: true,
      },
    })

    setInviting(false)
    if (inviteErr) {
      setInviteError(inviteErr.message)
      return
    }

    setInviteSuccess(true)
    setInviteEmail('')
    setInviteClientId('')
    setTimeout(() => { setInviteSuccess(false); setShowInvite(false) }, 3000)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-[#001628] sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <div className="w-8 h-8 bg-[#0075A9] rounded-lg flex items-center justify-center flex-none">
            <span className="text-white font-black text-xs uppercase">FTE</span>
          </div>
          <div className="flex-1">
            <p className="text-sm font-bold text-white">Adviewer</p>
            <p className="text-xs text-white/40 uppercase tracking-widest">Admin</p>
          </div>
          <a href="/board" className="text-xs text-white/40 hover:text-white/70 transition-colors uppercase tracking-wide">
            ← Board
          </a>
        </div>
        {/* Tabs */}
        <div className="max-w-5xl mx-auto px-6 flex gap-1 pb-0">
          {(['projects', 'access'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs font-semibold uppercase tracking-wider px-4 py-2.5 border-b-2 transition-colors ${
                tab === t
                  ? 'border-[#0075A9] text-white'
                  : 'border-transparent text-white/40 hover:text-white/60'
              }`}
            >
              {t === 'projects' ? 'Projects' : 'Client Access'}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">

        {/* ── PROJECTS TAB ── */}
        {tab === 'projects' && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-bold text-gray-900">All Projects</h1>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 bg-[#0075A9] hover:bg-[#005f8a] text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors uppercase tracking-wide"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                New Project
              </button>
            </div>

            {/* Create project form */}
            {showCreate && (
              <div className="bg-white rounded-xl border border-[#0075A9]/30 p-6 space-y-4 shadow-sm">
                <h2 className="text-sm font-bold text-gray-900">New Project</h2>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Client</label>
                    <select
                      value={newClientId}
                      onChange={(e) => setNewClientId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0075A9] bg-white text-gray-900"
                    >
                      <option value="">Select a client…</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Project Title</label>
                    <input
                      type="text"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      placeholder="e.g. July Campaign Review"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0075A9] text-gray-900 placeholder-gray-400"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Description <span className="text-gray-400">(optional)</span></label>
                  <textarea
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    rows={2}
                    placeholder="Brief note for the client…"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0075A9] text-gray-900 placeholder-gray-400 resize-none"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleCreateProject}
                    disabled={creating || !newTitle.trim() || !newClientId}
                    className="bg-[#0075A9] hover:bg-[#005f8a] disabled:bg-gray-100 disabled:text-gray-400 text-white text-xs font-bold px-5 py-2 rounded-lg transition-colors uppercase tracking-wide"
                  >
                    {creating ? 'Creating…' : 'Create & Add Cards →'}
                  </button>
                  <button onClick={() => setShowCreate(false)} className="text-xs text-gray-400 hover:text-gray-600">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Project list */}
            {projects.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
                <p className="text-sm text-gray-400">No projects yet. Create one to get started.</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      <th className="text-left px-5 py-3">Project</th>
                      <th className="text-left px-5 py-3">Client</th>
                      <th className="text-left px-5 py-3">Ads</th>
                      <th className="text-left px-5 py-3">Status</th>
                      <th className="text-left px-5 py-3">Updated</th>
                      <th className="px-5 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {projects.map((p) => (
                      <tr key={p.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-5 py-3.5 font-semibold text-gray-900">{p.title}</td>
                        <td className="px-5 py-3.5 text-gray-500">{getClientName(p.client)}</td>
                        <td className="px-5 py-3.5 text-gray-500">{p.cards?.length ?? 0}</td>
                        <td className="px-5 py-3.5">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLES[p.status]}`}>
                            {p.status}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-gray-400 text-xs">{fmt(p.updated_at)}</td>
                        <td className="px-5 py-3.5 text-right">
                          <button
                            onClick={() => router.push(`/adviewer/admin/projects/${p.id}`)}
                            className="text-xs text-[#0075A9] hover:text-[#005f8a] font-semibold transition-colors"
                          >
                            Manage →
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── CLIENT ACCESS TAB ── */}
        {tab === 'access' && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-lg font-bold text-gray-900">Client Access</h1>
                <p className="text-sm text-gray-500 mt-0.5">Clients with a login to FTE Adviewer.</p>
              </div>
              <button
                onClick={() => setShowInvite(true)}
                className="flex items-center gap-1.5 bg-[#0075A9] hover:bg-[#005f8a] text-white text-xs font-bold px-4 py-2 rounded-lg transition-colors uppercase tracking-wide"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Add Client
              </button>
            </div>

            {/* Invite form */}
            {showInvite && (
              <div className="bg-white rounded-xl border border-[#0075A9]/30 p-6 space-y-4 shadow-sm">
                <h2 className="text-sm font-bold text-gray-900">Add Client Access</h2>
                <p className="text-xs text-gray-500">
                  This creates an Adviewer login for the client. They&apos;ll receive a magic link to sign in — no password needed.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Client</label>
                    <select
                      value={inviteClientId}
                      onChange={(e) => setInviteClientId(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0075A9] bg-white text-gray-900"
                    >
                      <option value="">Select a client…</option>
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Client Email</label>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="client@company.com"
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0075A9] text-gray-900 placeholder-gray-400"
                    />
                  </div>
                </div>
                {inviteError && (
                  <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-lg border border-red-100">{inviteError}</p>
                )}
                {inviteSuccess && (
                  <p className="text-xs text-green-700 bg-green-50 px-3 py-2 rounded-lg border border-green-100">
                    ✓ Access granted. They can now sign in at /adviewer/login.
                  </p>
                )}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleInviteClient}
                    disabled={inviting || !inviteEmail.trim() || !inviteClientId}
                    className="bg-[#0075A9] hover:bg-[#005f8a] disabled:bg-gray-100 disabled:text-gray-400 text-white text-xs font-bold px-5 py-2 rounded-lg transition-colors uppercase tracking-wide"
                  >
                    {inviting ? 'Adding…' : 'Grant Access'}
                  </button>
                  <button onClick={() => { setShowInvite(false); setInviteError(null) }} className="text-xs text-gray-400 hover:text-gray-600">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Access list */}
            {adviewerClients.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
                <p className="text-sm text-gray-400">No client logins yet.</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      <th className="text-left px-5 py-3">Email</th>
                      <th className="text-left px-5 py-3">Client</th>
                      <th className="text-left px-5 py-3">Added</th>
                      <th className="text-left px-5 py-3">Last Login</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {adviewerClients.map((ac) => {
                      const clientName = clients.find((c) => c.id === ac.client_id)?.name ?? '—'
                      return (
                        <tr key={ac.id} className="hover:bg-gray-50">
                          <td className="px-5 py-3.5 font-medium text-gray-900">{ac.email}</td>
                          <td className="px-5 py-3.5 text-gray-500">{clientName}</td>
                          <td className="px-5 py-3.5 text-gray-400 text-xs">{fmt(ac.created_at)}</td>
                          <td className="px-5 py-3.5 text-gray-400 text-xs">
                            {ac.last_login_at ? fmt(ac.last_login_at) : <span className="text-gray-300">Never</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
