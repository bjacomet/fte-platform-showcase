'use client'

import { memo, useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

// Cap the feed so cards with long histories don't render hundreds of DOM nodes
const FEED_LIMIT = 100

interface Comment {
  id: string
  type: 'comment'
  author: string
  body: string
  created_at: string
  is_change_request: boolean
  resolved: boolean
}

interface Activity {
  id: string
  type: 'activity'
  actor: string
  actor_email: string | null
  action: string
  detail: string | null
  created_at: string
}

type FeedItem = Comment | Activity

function getInitials(name: string): string {
  const parts = name.split(/[@.\s]/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function getAvatarColor(name: string): string {
  const colors = [
    'bg-blue-600', 'bg-violet-600', 'bg-green-600',
    'bg-rose-600', 'bg-amber-600', 'bg-cyan-600', 'bg-pink-600'
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

function formatTs(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function Avatar({ name }: { name: string }) {
  return (
    <div className={`w-8 h-8 rounded-full flex-none flex items-center justify-center text-[11px] font-bold text-white ${getAvatarColor(name)}`}>
      {getInitials(name)}
    </div>
  )
}

interface Props {
  cardId: string
  userEmail: string
}

// memo: parent CardDrawer re-renders on every keystroke — props here are stable,
// so memoizing keeps the feed from re-rendering while the user types
export default memo(function CardActivityPanel({ cardId, userEmail }: Props) {
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [comment, setComment] = useState('')
  const [mode, setMode] = useState<'comment' | 'change_request'>('comment')
  const [posting, setPosting] = useState(false)
  const [loading, setLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const firstScrollRef = useRef(true)
  const supabase = createClient()

  type CommentRow = { id: string; author: string; body: string; created_at: string; is_change_request: boolean | null; resolved: boolean | null }
  type ActivityRow = { id: string; actor: string; actor_email: string | null; action: string; detail: string | null; created_at: string }

  const loadFeed = async () => {
    // Fetch newest-first with a limit, then sort ascending for display
    const [{ data: comments }, { data: activity }] = await Promise.all([
      supabase.from('card_comments').select('*').eq('card_id', cardId).order('created_at', { ascending: false }).limit(FEED_LIMIT),
      supabase.from('card_activity').select('*').eq('card_id', cardId).in('action', ['created', 'updated', 'moved']).order('created_at', { ascending: false }).limit(FEED_LIMIT),
    ])

    const items: FeedItem[] = [
      ...(comments ?? []).map((c: CommentRow) => ({
        ...c,
        type: 'comment' as const,
        is_change_request: c.is_change_request ?? false,
        resolved: c.resolved ?? false,
      })),
      ...(activity ?? []).map((a: ActivityRow) => ({ ...a, type: 'activity' as const })),
    ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

    setFeed(items)
    setLoading(false)
  }

  useEffect(() => {
    void (async () => { await loadFeed() })()
  }, [cardId])

  // Real-time subscription — updates immediately when activity or comments are inserted
  useEffect(() => {
    const channel = supabase
      .channel(`card-feed-${cardId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'card_activity', filter: `card_id=eq.${cardId}` },
        () => loadFeed(),
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'card_comments', filter: `card_id=eq.${cardId}` },
        () => loadFeed(),
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [cardId])

  useEffect(() => {
    if (feed.length === 0) return
    // Jump instantly on first load — smooth-scrolling past a long feed is janky
    bottomRef.current?.scrollIntoView({ behavior: firstScrollRef.current ? 'auto' : 'smooth' })
    firstScrollRef.current = false
  }, [feed])

  const postComment = async () => {
    if (!comment.trim()) return
    setPosting(true)
    await supabase.from('card_comments').insert({
      card_id: cardId,
      author: userEmail,
      body: comment.trim(),
      is_change_request: mode === 'change_request',
    })
    setComment('')
    await loadFeed()
    setPosting(false)
  }

  const toggleResolved = async (id: string, resolved: boolean) => {
    setFeed((prev) => prev.map((it) => it.type === 'comment' && it.id === id ? { ...it, resolved } : it))
    const { error } = await supabase.from('card_comments').update({ resolved }).eq('id', id)
    if (error) setFeed((prev) => prev.map((it) => it.type === 'comment' && it.id === id ? { ...it, resolved: !resolved } : it))
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700/60 shrink-0">
        <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <span className="text-sm font-semibold text-gray-200">Comments & Activity</span>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto overscroll-y-contain px-4 py-3 space-y-4">
        {loading && <p className="text-xs text-gray-500">Loading...</p>}
        {!loading && feed.length === 0 && (
          <p className="text-xs text-gray-500 text-center py-4">No activity yet.</p>
        )}
        {feed.map((item) => (
          <div key={item.id} className="flex gap-2.5">
            <Avatar name={item.type === 'comment' ? item.author : (item.actor_email || item.actor || 'Team')} />
            <div className="flex-1 min-w-0">
              {item.type === 'comment' ? (
                <>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-gray-200">{item.author}</span>
                    {item.is_change_request && (
                      <span className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${
                        item.resolved
                          ? 'bg-green-500/15 text-green-400 border-green-500/25'
                          : 'bg-amber-500/15 text-amber-400 border-amber-500/25'
                      }`}>
                        {item.resolved ? '✓ Change request' : 'Change request'}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-500">{formatTs(item.created_at)}</span>
                  </div>
                  <div className={`mt-1 text-xs rounded-lg px-3 py-2 border ${
                    item.is_change_request
                      ? item.resolved
                        ? 'text-gray-500 line-through bg-gray-800/40 border-gray-700/40'
                        : 'text-amber-100 bg-amber-500/[0.07] border-amber-500/25'
                      : 'text-gray-300 bg-gray-800 border-gray-700/60'
                  }`}>
                    {item.body}
                  </div>
                  {item.is_change_request && (
                    <button
                      onClick={() => void toggleResolved(item.id, !item.resolved)}
                      className={`mt-1 text-[10px] font-medium transition-colors ${
                        item.resolved ? 'text-gray-500 hover:text-gray-300' : 'text-green-400 hover:text-green-300'
                      }`}
                    >
                      {item.resolved ? 'Reopen' : 'Mark addressed'}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-gray-200">
                      {item.actor_email || item.actor || 'Team'}
                    </span>
                    <span className="text-[10px] text-gray-500">{formatTs(item.created_at)}</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {item.detail || item.action}
                  </p>
                </>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Comment input */}
      <div className="px-4 py-3 border-t border-gray-700/60 shrink-0">
        {/* Mode toggle: plain comment vs internal change request */}
        <div className="flex items-center gap-1 mb-2">
          {([
            ['comment', 'Comment'],
            ['change_request', 'Change Requests (internal)'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              className={`text-[10px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
                mode === value
                  ? value === 'change_request'
                    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                    : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                  : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Avatar name={userEmail} />
          <div className="flex-1">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) postComment() }}
              placeholder={mode === 'change_request' ? 'Request a change or suggestion for the team…' : 'Write a comment...'}
              rows={2}
              className={`w-full text-xs bg-gray-800 border rounded-lg px-3 py-2 text-gray-200 placeholder-gray-500 focus:outline-none resize-none ${
                mode === 'change_request' ? 'border-amber-500/40 focus:border-amber-500' : 'border-gray-700 focus:border-blue-500'
              }`}
            />
            {comment.trim() && (
              <button
                onClick={postComment}
                disabled={posting}
                className={`mt-1.5 text-xs px-3 py-1.5 disabled:opacity-40 text-white rounded-lg transition-colors ${
                  mode === 'change_request' ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500'
                }`}
              >
                {posting ? 'Posting...' : mode === 'change_request' ? 'Add change request' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
