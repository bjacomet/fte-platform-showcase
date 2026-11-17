'use client'

import { useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { SocialPage, SocialPost, SocialPostStatus, SocialPlatform } from '@/types'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const STATUS_STYLES: Record<SocialPostStatus, { dot: string; label: string; text: string }> = {
  draft:      { dot: 'bg-gray-500',   label: 'Draft',      text: 'text-gray-400' },
  approved:   { dot: 'bg-blue-400',   label: 'Approved',   text: 'text-blue-400' },
  submitting: { dot: 'bg-yellow-400 animate-pulse', label: 'Submitting', text: 'text-yellow-400' },
  scheduled:  { dot: 'bg-green-400',  label: 'Scheduled',  text: 'text-green-400' },
  published:  { dot: 'bg-emerald-400',label: 'Published',  text: 'text-emerald-400' },
  failed:     { dot: 'bg-red-400',    label: 'Failed',     text: 'text-red-400' },
}

interface CalendarCell {
  day: number
  dateStr: string
  posts: SocialPost[]
}

function buildCalendar(year: number, month: number, posts: SocialPost[]): (CalendarCell | null)[] {
  const firstDay = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells: (CalendarCell | null)[] = []

  for (let i = 0; i < firstDay; i++) cells.push(null)

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({
      day: d,
      dateStr,
      posts: posts.filter((p) => p.scheduled_for.startsWith(dateStr)),
    })
  }

  return cells
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

interface ComposerState {
  platform: SocialPlatform
  caption: string
  mediaUrl: string
  scheduledFor: string
}

const EMPTY_COMPOSER: ComposerState = {
  platform: 'facebook',
  caption: '',
  mediaUrl: '',
  scheduledFor: '',
}

interface Props {
  pages: SocialPage[]
  posts: SocialPost[]
  activePage: SocialPage | null
  year: number
  month: number
}

export default function SocialClient({ pages, posts: initialPosts, activePage, year, month }: Props) {
  const router = useRouter()

  const [posts, setPosts] = useState<SocialPost[]>(initialPosts)
  const [composerOpen, setComposerOpen] = useState(false)
  const [editingPost, setEditingPost] = useState<SocialPost | null>(null)
  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER)
  const [saving, setSaving] = useState(false)
  const [approving, setApproving] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [detailPost, setDetailPost] = useState<SocialPost | null>(null)

  const calendarCells = useMemo(() => buildCalendar(year, month, posts), [year, month, posts])
  const today = useMemo(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, [])

  const navigate = useCallback((newYear: number, newMonth: number, pageId?: string) => {
    const id = pageId ?? activePage?.id ?? ''
    router.push(`/social?page_id=${id}&year=${newYear}&month=${newMonth}`)
  }, [router, activePage])

  const prevMonth = useCallback(() => {
    if (month === 1) navigate(year - 1, 12)
    else navigate(year, month - 1)
  }, [month, year, navigate])

  const nextMonth = useCallback(() => {
    if (month === 12) navigate(year + 1, 1)
    else navigate(year, month + 1)
  }, [month, year, navigate])

  const openComposerForDay = useCallback((dateStr: string) => {
    const defaultTime = `${dateStr}T09:00`
    setComposer({ ...EMPTY_COMPOSER, scheduledFor: defaultTime })
    setEditingPost(null)
    setComposerOpen(true)
  }, [])

  const openEditPost = useCallback((post: SocialPost) => {
    setDetailPost(null)
    setEditingPost(post)
    setComposer({
      platform: post.platform,
      caption: post.caption ?? '',
      mediaUrl: post.media_urls[0] ?? '',
      scheduledFor: post.scheduled_for.slice(0, 16),
    })
    setComposerOpen(true)
  }, [])

  const closeComposer = useCallback(() => {
    setComposerOpen(false)
    setEditingPost(null)
    setComposer(EMPTY_COMPOSER)
  }, [])

  const savePost = useCallback(async () => {
    if (!activePage || !composer.scheduledFor) return
    setSaving(true)
    try {
      const body = {
        page_id: activePage.id,
        platform: composer.platform,
        caption: composer.caption || null,
        media_urls: composer.mediaUrl ? [composer.mediaUrl] : [],
        scheduled_for: new Date(composer.scheduledFor).toISOString(),
      }

      if (editingPost) {
        const res = await fetch(`/api/social/posts/${editingPost.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.ok) {
          const updated = await res.json() as SocialPost
          setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
        }
      } else {
        const res = await fetch('/api/social/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.ok) {
          const created = await res.json() as SocialPost
          setPosts((prev) => [...prev, created])
        }
      }
      closeComposer()
    } finally {
      setSaving(false)
    }
  }, [activePage, composer, editingPost, closeComposer])

  const approvePost = useCallback(async (postId: string) => {
    setApproving(postId)
    try {
      const res = await fetch(`/api/social/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      })
      if (!res.ok) return
      const approved = await res.json() as SocialPost
      setPosts((prev) => prev.map((p) => (p.id === approved.id ? approved : p)))
      setDetailPost(approved)

      if (approved.platform === 'facebook') {
        const submitting = { ...approved, status: 'submitting' as SocialPostStatus }
        setPosts((prev) => prev.map((p) => (p.id === postId ? submitting : p)))
        setDetailPost(submitting)

        const submitRes = await fetch('/api/social/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postId }),
        })
        const submitData = await submitRes.json() as {
          post?: { id: string; status: SocialPostStatus; fb_post_id: string | null; ig_container_id: string | null; error_message: string | null; error_code: string | null }
          error?: string
        }
        if (submitData.post) {
          const final = { ...submitting, ...submitData.post }
          setPosts((prev) => prev.map((p) => (p.id === postId ? final : p)))
          setDetailPost(final)
        }
      }
    } finally {
      setApproving(null)
    }
  }, [])

  const unapprovePost = useCallback(async (postId: string) => {
    setApproving(postId)
    try {
      const res = await fetch(`/api/social/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'draft' }),
      })
      if (res.ok) {
        const updated = await res.json() as SocialPost
        setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
        setDetailPost(updated)
      }
    } finally {
      setApproving(null)
    }
  }, [])

  const deletePost = useCallback(async (postId: string) => {
    setDeleting(postId)
    try {
      const res = await fetch(`/api/social/posts/${postId}`, { method: 'DELETE' })
      if (res.ok) {
        setPosts((prev) => prev.filter((p) => p.id !== postId))
        setDetailPost(null)
      }
    } finally {
      setDeleting(null)
    }
  }, [])

  const approvedCount = posts.filter((p) => p.status === 'approved').length
  const draftCount = posts.filter((p) => p.status === 'draft').length

  if (pages.length === 0) {
    return (
      <div className="min-h-screen bg-[#0f1117] text-white flex items-center justify-center">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-[#1877F2]/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-[#1877F2]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>
          </div>
          <h2 className="text-lg font-semibold mb-2">No pages connected</h2>
          <p className="text-sm text-gray-400 mb-5">Connect your Facebook account in Settings to start scheduling posts.</p>
          <Link href="/settings" className="inline-flex items-center gap-2 bg-[#1877F2] hover:bg-[#166fe5] text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">
            Go to Settings
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0f1117] text-white">
      {/* Top bar */}
      <div className="border-b border-gray-800 px-5 py-3 flex items-center gap-4">
        <Link href="/board" className="text-gray-400 hover:text-white transition-colors flex-none">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </Link>
        <h1 className="text-sm font-semibold text-white">Social Scheduler</h1>

        {/* Page selector */}
        <select
          value={activePage?.id ?? ''}
          onChange={(e) => navigate(year, month, e.target.value)}
          className="ml-2 bg-[#1a1f2e] border border-gray-700 text-sm text-white rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500"
        >
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.page_name}{p.ig_account_id ? ' (FB + IG)' : ' (FB)'}
            </option>
          ))}
        </select>

        {/* Month nav */}
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={prevMonth} className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-sm font-medium w-32 text-center">{MONTH_NAMES[month - 1]} {year}</span>
          <button onClick={nextMonth} className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Stats */}
        {posts.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-gray-500">
            {draftCount > 0 && <span>{draftCount} draft{draftCount !== 1 ? 's' : ''}</span>}
            {approvedCount > 0 && <span className="text-blue-400">{approvedCount} approved</span>}
          </div>
        )}

        {/* New Post button */}
        {activePage && (
          <button
            onClick={() => { setComposer(EMPTY_COMPOSER); setEditingPost(null); setComposerOpen(true) }}
            className="flex items-center gap-1.5 bg-[#1877F2] hover:bg-[#166fe5] text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Post
          </button>
        )}
      </div>

      {/* Calendar */}
      <div className="p-5">
        {/* Day-of-week headers */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {DOW.map((d) => (
            <div key={d} className="text-[11px] font-medium text-gray-500 uppercase text-center py-1">{d}</div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-1">
          {calendarCells.map((cell, i) => {
            if (!cell) {
              return <div key={`empty-${i}`} className="aspect-[4/3] min-h-[90px]" />
            }
            const isToday = cell.dateStr === today
            const hasPosts = cell.posts.length > 0
            const PREVIEW_CAP = 3
            const overflow = cell.posts.length - PREVIEW_CAP

            return (
              <div
                key={cell.dateStr}
                onClick={() => activePage && openComposerForDay(cell.dateStr)}
                className={`
                  aspect-[4/3] min-h-[90px] rounded-lg border p-1.5 flex flex-col cursor-pointer group transition-colors
                  ${isToday ? 'border-blue-600/60 bg-blue-950/20' : 'border-gray-800 hover:border-gray-700 bg-[#141820] hover:bg-[#1a1f2e]'}
                `}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className={`text-xs font-medium ${isToday ? 'text-blue-400' : 'text-gray-400'}`}>
                    {cell.day}
                  </span>
                  {activePage && (
                    <span className="text-[10px] text-gray-600 group-hover:text-gray-500 transition-colors opacity-0 group-hover:opacity-100">+</span>
                  )}
                </div>

                <div className="flex flex-col gap-0.5 flex-1 overflow-hidden">
                  {cell.posts.slice(0, PREVIEW_CAP).map((post) => {
                    const s = STATUS_STYLES[post.status]
                    return (
                      <button
                        key={post.id}
                        onClick={(e) => { e.stopPropagation(); setDetailPost(post) }}
                        className="w-full text-left px-1.5 py-0.5 rounded bg-gray-800/60 hover:bg-gray-700/60 transition-colors group/post"
                      >
                        <div className="flex items-center gap-1 min-w-0">
                          <span className={`w-1.5 h-1.5 rounded-full flex-none ${s.dot}`} />
                          <span className="text-[10px] text-gray-300 truncate leading-tight">{post.caption ?? '(no caption)'}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className={`text-[9px] ${post.platform === 'facebook' ? 'text-blue-400' : 'text-pink-400'}`}>
                            {post.platform === 'facebook' ? 'FB' : 'IG'}
                          </span>
                          <span className="text-[9px] text-gray-500">{fmtTime(post.scheduled_for)}</span>
                        </div>
                      </button>
                    )
                  })}

                  {overflow > 0 && (
                    <span className="text-[9px] text-gray-500 px-1">+{overflow} more</span>
                  )}
                </div>

                {!hasPosts && activePage && (
                  <div className="flex-1 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[10px] text-gray-600">Add post</span>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Empty state */}
        {posts.length === 0 && activePage && (
          <div className="mt-8 text-center text-gray-500 text-sm">
            No posts scheduled for {MONTH_NAMES[month - 1]} {year}. Click any day or use the <strong>New Post</strong> button to add posts.
          </div>
        )}
      </div>

      {/* Post Detail Modal */}
      {detailPost && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
          onClick={() => setDetailPost(null)}
        >
          <div
            className="bg-[#141820] border border-gray-700/60 rounded-xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs border ${
                  detailPost.platform === 'facebook'
                    ? 'bg-blue-900/30 text-blue-400 border-blue-700/40'
                    : 'bg-pink-900/30 text-pink-400 border-pink-700/40'
                }`}>
                  {detailPost.platform === 'facebook' ? 'Facebook' : 'Instagram'}
                </span>
                <span className={`flex items-center gap-1 text-xs ${STATUS_STYLES[detailPost.status].text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_STYLES[detailPost.status].dot}`} />
                  {STATUS_STYLES[detailPost.status].label}
                </span>
              </div>
              <button onClick={() => setDetailPost(null)} className="text-gray-500 hover:text-white transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mb-4">
              <p className="text-xs text-gray-400 mb-1">Scheduled for</p>
              <p className="text-sm text-white font-medium">
                {new Date(detailPost.scheduled_for).toLocaleString('en-US', {
                  weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
                  hour: 'numeric', minute: '2-digit',
                })}
              </p>
            </div>

            {detailPost.caption && (
              <div className="mb-4">
                <p className="text-xs text-gray-400 mb-1">Caption</p>
                <p className="text-sm text-white whitespace-pre-wrap">{detailPost.caption}</p>
              </div>
            )}

            {detailPost.media_urls.length > 0 && (
              <div className="mb-4">
                <p className="text-xs text-gray-400 mb-1">Media</p>
                {detailPost.media_urls.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline block truncate">{url}</a>
                ))}
              </div>
            )}

            {detailPost.error_message && (
              <div className="mb-4 bg-red-900/30 border border-red-700/40 rounded-lg px-3 py-2">
                <p className="text-xs text-red-400">{detailPost.error_message}</p>
              </div>
            )}

            <div className="flex items-center gap-2 mt-2 pt-4 border-t border-gray-700/40">
              {detailPost.status === 'draft' && (
                <>
                  <button
                    onClick={() => approvePost(detailPost.id)}
                    disabled={approving === detailPost.id}
                    className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors"
                  >
                    {approving === detailPost.id ? 'Approving…' : 'Approve'}
                  </button>
                  <button
                    onClick={() => openEditPost(detailPost)}
                    className="px-3 py-2 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deletePost(detailPost.id)}
                    disabled={deleting === detailPost.id}
                    className="px-3 py-2 text-xs text-red-500 hover:text-red-400 border border-gray-700 hover:border-red-800 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {deleting === detailPost.id ? '…' : 'Delete'}
                  </button>
                </>
              )}

              {detailPost.status === 'approved' && (
                <>
                  <span className="flex-1 text-xs text-gray-400">
                    {detailPost.platform === 'facebook' ? 'Queued for Facebook scheduling…' : 'Approved. Will publish at scheduled time.'}
                  </span>
                  <button
                    onClick={() => unapprovePost(detailPost.id)}
                    disabled={approving === detailPost.id}
                    className="px-3 py-2 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {approving === detailPost.id ? '…' : 'Un-approve'}
                  </button>
                </>
              )}

              {detailPost.status === 'submitting' && (
                <span className="flex-1 text-xs text-gray-400">Submitting to Meta…</span>
              )}

              {(detailPost.status === 'scheduled' || detailPost.status === 'published') && (
                <span className="text-xs text-gray-400">
                  {detailPost.status === 'published' ? 'Published successfully.' : 'Scheduled with Facebook.'}
                </span>
              )}

              {detailPost.status === 'failed' && (
                <>
                  <button
                    onClick={() => { if (detailPost) { const reset = { ...detailPost, status: 'draft' as SocialPostStatus }; setPosts(prev => prev.map(p => p.id === detailPost.id ? reset : p)); setDetailPost(reset) } }}
                    className="flex-1 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium px-3 py-2 rounded-lg transition-colors"
                  >
                    Reset to Draft
                  </button>
                  <button
                    onClick={() => deletePost(detailPost.id)}
                    disabled={deleting === detailPost.id}
                    className="px-3 py-2 text-xs text-red-500 hover:text-red-400 border border-gray-700 hover:border-red-800 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Composer Modal */}
      {composerOpen && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4"
          onClick={closeComposer}
        >
          <div
            className="bg-[#141820] border border-gray-700/60 rounded-xl w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-700/40">
              <h2 className="text-sm font-semibold">{editingPost ? 'Edit Post' : 'New Post'}</h2>
              <button onClick={closeComposer} className="text-gray-500 hover:text-white transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-6 space-y-4">
              {/* Platform selector */}
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Platform</label>
                <div className="flex gap-2">
                  {(['facebook', 'instagram'] as SocialPlatform[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setComposer((c) => ({ ...c, platform: p }))}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        composer.platform === p
                          ? p === 'facebook'
                            ? 'bg-blue-900/40 text-blue-400 border-blue-600/60'
                            : 'bg-pink-900/40 text-pink-400 border-pink-600/60'
                          : 'bg-transparent text-gray-400 border-gray-700 hover:border-gray-500'
                      }`}
                    >
                      {p === 'facebook' ? 'Facebook' : 'Instagram'}
                    </button>
                  ))}
                  {activePage?.ig_account_id === null && composer.platform === 'instagram' && (
                    <span className="text-[11px] text-yellow-400 self-center">No IG account linked to this page</span>
                  )}
                </div>
              </div>

              {/* Caption */}
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Caption</label>
                <textarea
                  value={composer.caption}
                  onChange={(e) => setComposer((c) => ({ ...c, caption: e.target.value }))}
                  rows={4}
                  placeholder="Write your post caption…"
                  className="w-full bg-[#0f1117] border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 resize-none focus:outline-none"
                />
              </div>

              {/* Media URL */}
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Media URL <span className="text-gray-600">(optional)</span></label>
                <input
                  type="url"
                  value={composer.mediaUrl}
                  onChange={(e) => setComposer((c) => ({ ...c, mediaUrl: e.target.value }))}
                  placeholder="Paste image URL from Supabase Storage or Box"
                  className="w-full bg-[#0f1117] border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none"
                />
              </div>

              {/* Schedule date/time */}
              <div>
                <label className="text-xs font-medium text-gray-400 block mb-1.5">Schedule for</label>
                <input
                  type="datetime-local"
                  value={composer.scheduledFor}
                  onChange={(e) => setComposer((c) => ({ ...c, scheduledFor: e.target.value }))}
                  className="w-full bg-[#0f1117] border border-gray-700 focus:border-blue-500 rounded-lg px-3 py-2 text-sm text-white focus:outline-none [color-scheme:dark]"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-6 pb-5">
              <button
                onClick={closeComposer}
                className="px-4 py-2 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={savePost}
                disabled={saving || !composer.scheduledFor}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
              >
                {saving ? 'Saving…' : editingPost ? 'Save Changes' : 'Save as Draft'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
