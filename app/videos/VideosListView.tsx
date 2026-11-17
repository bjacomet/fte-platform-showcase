'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { Client, VideoProject, VideoVersion, VideoProjectStatus } from '@/types'

interface Props {
  clients: Client[]
  projects: VideoProject[]
  latestVersionByProject: Record<string, VideoVersion>
}

const STATUS_STYLES: Record<VideoProjectStatus, string> = {
  in_review: 'bg-amber-900/40 text-amber-300 border-amber-700/60',
  approved:  'bg-green-900/40 text-green-300 border-green-700/60',
  archived:  'bg-gray-800 text-gray-400 border-gray-700',
}

const STATUS_LABEL: Record<VideoProjectStatus, string> = {
  in_review: 'In review',
  approved:  'Approved',
  archived:  'Archived',
}

export default function VideosListView({ clients, projects, latestVersionByProject }: Props) {
  const router = useRouter()
  const [clientFilter, setClientFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newClientId, setNewClientId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (clientFilter && p.client_id !== clientFilter) return false
      if (statusFilter && p.status !== statusFilter) return false
      return true
    })
  }, [projects, clientFilter, statusFilter])

  async function createProject() {
    if (!newTitle.trim()) return
    setBusy(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('video_projects')
        .insert({
          title: newTitle.trim(),
          client_id: newClientId || null,
        })
        .select('id')
        .single()
      if (error) throw error
      router.push(`/videos/${data.id}`)
    } catch (err) {
      console.error('create project failed', err)
      alert('Could not create project. Is the video_proofing SQL migration run?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#0f1117] text-gray-100">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-900 border-b border-gray-700/60 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-bold text-white tracking-tight">Video Proofing</h1>

          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="bg-gray-800 border border-gray-600 text-gray-200 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-gray-800 border border-gray-600 text-gray-200 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            <option value="">All statuses</option>
            <option value="in_review">In review</option>
            <option value="approved">Approved</option>
          </select>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setCreating(true)}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
          >
            + New project
          </button>
          <Link href="/board" className="text-xs text-gray-400 hover:text-white transition-colors">
            ← Board
          </Link>
        </div>
      </div>

      {/* Body */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {filtered.length === 0 ? (
          <div className="text-center text-gray-500 mt-16">
            <p className="text-sm">
              {projects.length === 0
                ? 'No video projects yet. Click "New project" to start one.'
                : 'No projects match these filters.'}
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((p) => {
              const latest = latestVersionByProject[p.id]
              const clientName = p.clients?.name ?? null
              return (
                <li
                  key={p.id}
                  className="bg-[#141820] border border-gray-800 rounded-xl overflow-hidden hover:border-gray-600 transition-colors"
                >
                  <Link href={`/videos/${p.id}`} className="block">
                    <div className="aspect-video bg-black flex items-center justify-center relative">
                      {latest?.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={latest.thumbnail_url} alt={p.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="text-gray-600">
                          <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </div>
                      )}
                      {latest && (
                        <span className="absolute bottom-2 left-2 bg-black/70 text-white text-[11px] px-1.5 py-0.5 rounded">
                          V{latest.version_number}
                        </span>
                      )}
                    </div>
                    <div className="p-4 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <h2 className="text-sm font-semibold text-white truncate">{p.title}</h2>
                        <span
                          className={`flex-none text-[10px] font-medium px-1.5 py-0.5 rounded border ${STATUS_STYLES[p.status]}`}
                        >
                          {STATUS_LABEL[p.status]}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 truncate">
                        {clientName ?? 'No client'}
                      </p>
                      <p className="text-[11px] text-gray-500">
                        Updated {new Date(p.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </main>

      {/* Create modal */}
      {creating && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#141820] border border-gray-700 rounded-xl w-full max-w-md p-6">
            <h2 className="text-base font-semibold text-white mb-4">New video proofing project</h2>

            <label className="block text-xs text-gray-400 mb-1">Title</label>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. RMS Summer Reel"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />

            <label className="block text-xs text-gray-400 mb-1">Client</label>
            <select
              value={newClientId}
              onChange={(e) => setNewClientId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mb-6 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">— no client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setCreating(false); setNewTitle(''); setNewClientId('') }}
                className="text-sm px-3 py-1.5 rounded text-gray-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={createProject}
                disabled={!newTitle.trim() || busy}
                className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium"
              >
                {busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
