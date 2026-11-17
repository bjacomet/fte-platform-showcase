'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

interface ProjectCard {
  id: string
  position: number
  card_id: string
  card: { id: string; title: string; media_type: string | null; client_portal_status: string | null }
}

interface AvailableCard {
  id: string
  title: string
  media_type: string | null
  client_portal_status: string | null
}

interface FeedbackRow {
  card_id: string
  decision: string | null
  created_at: string
}

interface Props {
  project: {
    id: string
    title: string
    description: string | null
    status: string
    client: { id: string; name: string } | null
  }
  projectCards: ProjectCard[]
  availableCards: AvailableCard[]
  addedCardIds: string[]
  feedback: FeedbackRow[]
}

const DECISION_STYLES: Record<string, string> = {
  approved:          'bg-green-50 text-green-700 border-green-200',
  changes_requested: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  rejected:          'bg-red-50 text-red-700 border-red-200',
}
const DECISION_LABELS: Record<string, string> = {
  approved:          '✓ Approved',
  changes_requested: 'Changes Requested',
  rejected:          'Rejected',
}

const STATUS_OPTIONS = ['draft', 'active', 'archived'] as const

export default function ProjectAdminClient({
  project,
  projectCards,
  availableCards,
  feedback,
}: Props) {
  const router = useRouter()
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const [cards, setCards] = useState(projectCards)
  const [available, setAvailable] = useState(availableCards)
  const [status, setStatus] = useState(project.status)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  const feedbackByCard: Record<string, FeedbackRow[]> = {}
  for (const f of feedback) {
    if (!feedbackByCard[f.card_id]) feedbackByCard[f.card_id] = []
    feedbackByCard[f.card_id].push(f)
  }

  async function handleAddCard(card: AvailableCard) {
    const position = cards.length
    const { data, error } = await supabase
      .from('adviewer_project_cards')
      .insert({ project_id: project.id, card_id: card.id, position })
      .select('id')
      .single()

    if (!error && data) {
      setCards((prev) => [...prev, {
        id: data.id, position, card_id: card.id,
        card: { id: card.id, title: card.title, media_type: card.media_type, client_portal_status: card.client_portal_status },
      }])
      setAvailable((prev) => prev.filter((c) => c.id !== card.id))
    }
  }

  async function handleRemoveCard(projectCardId: string, cardId: string) {
    const { error } = await supabase
      .from('adviewer_project_cards')
      .delete()
      .eq('id', projectCardId)

    if (!error) {
      const removed = cards.find((c) => c.id === projectCardId)
      setCards((prev) => prev.filter((c) => c.id !== projectCardId))
      if (removed) {
        setAvailable((prev) => [...prev, {
          id: cardId,
          title: removed.card.title,
          media_type: removed.card.media_type,
          client_portal_status: removed.card.client_portal_status,
        }].sort((a, b) => a.title.localeCompare(b.title)))
      }
    }
  }

  async function handleSaveStatus() {
    setSaving(true)
    await supabase
      .from('adviewer_projects')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', project.id)
    setSaving(false)
  }

  const filteredAvailable = available.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-[#001628] sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4">
          <button
            onClick={() => router.push('/adviewer/admin')}
            className="text-white/40 hover:text-white/70 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="w-8 h-8 bg-[#0075A9] rounded-lg flex items-center justify-center flex-none">
            <span className="text-white font-black text-xs uppercase">FTE</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white truncate">{project.title}</p>
            <p className="text-xs text-white/40">{project.client?.name ?? ''}</p>
          </div>
          {/* Status toggle */}
          <div className="flex items-center gap-2">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="text-xs bg-white/10 text-white border border-white/20 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#0075A9] appearance-none"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s} className="bg-[#001628] text-white">{s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
            <button
              onClick={handleSaveStatus}
              disabled={saving || status === project.status}
              className="text-xs bg-[#0075A9] hover:bg-[#005f8a] disabled:opacity-40 text-white font-bold px-3 py-1.5 rounded-lg transition-colors uppercase tracking-wide"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-2 gap-6">

        {/* LEFT — cards in this project */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-900">In This Project</h2>
            <span className="text-xs text-gray-400">{cards.length} {cards.length === 1 ? 'ad' : 'ads'}</span>
          </div>

          {cards.length === 0 ? (
            <div className="bg-white rounded-xl border border-dashed border-gray-200 p-8 text-center">
              <p className="text-sm text-gray-400">No ads yet. Add from the right →</p>
            </div>
          ) : (
            <div className="space-y-2">
              {cards.map((pc) => {
                const cardFeedback = feedbackByCard[pc.card_id] ?? []
                const latestDecision = cardFeedback[cardFeedback.length - 1]?.decision ?? null

                return (
                  <div key={pc.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-900 truncate">{pc.card.title}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{pc.card.media_type ?? 'No type'}</p>
                    </div>
                    {latestDecision && (
                      <span className={`flex-none text-xs font-semibold px-2 py-0.5 rounded-full border ${DECISION_STYLES[latestDecision]}`}>
                        {DECISION_LABELS[latestDecision]}
                      </span>
                    )}
                    <button
                      onClick={() => handleRemoveCard(pc.id, pc.card_id)}
                      className="flex-none text-gray-300 hover:text-red-400 transition-colors ml-1"
                      title="Remove from project"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* RIGHT — available cards to add */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-900">Available Ads</h2>
            <span className="text-xs text-gray-400">{available.length} cards</span>
          </div>

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ads…"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0075A9] placeholder-gray-400"
          />

          {filteredAvailable.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
              <p className="text-sm text-gray-400">
                {available.length === 0 ? 'All ads have been added.' : 'No matches.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {filteredAvailable.map((card) => (
                <div key={card.id} className="bg-white rounded-xl border border-gray-100 px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{card.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{card.media_type ?? 'No type'}</p>
                  </div>
                  <button
                    onClick={() => handleAddCard(card)}
                    className="flex-none text-xs text-[#0075A9] hover:text-[#005f8a] font-bold transition-colors uppercase tracking-wide"
                  >
                    + Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
