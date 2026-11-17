'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

interface ProjectShape {
  id: string
  title: string
  status: 'in_review' | 'approved' | 'archived'
  created_at: string
  client: { id: string; name: string; fb_page_logo_url: string | null } | null
}

interface VersionShape {
  id: string
  version_number: number
  box_file_id: string | null
  video_url: string | null
  thumbnail_url: string | null
  duration_sec: number | null
  notes: string | null
  created_at: string
}

interface CommentShape {
  id: string
  version_id: string
  author_kind: 'internal' | 'client'
  author_name: string | null
  timestamp_sec: number | null
  body: string
  acknowledged: boolean
  created_at: string
}

interface ApprovalShape {
  id: string
  version_id: string
  approver_kind: 'internal' | 'client'
  approver_name: string | null
  note: string | null
  created_at: string
}

interface Props {
  token: string
  project: ProjectShape
  versions: VersionShape[]
  comments: CommentShape[]
  approvals: ApprovalShape[]
}

function formatTs(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '--:--'
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

export default function VideoReviewClient({
  token,
  project,
  versions,
  comments: initialComments,
  approvals: initialApprovals,
}: Props) {
  const supabase = useRef(createClient()).current
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const sortedVersions = useMemo(
    () => versions.slice().sort((a, b) => b.version_number - a.version_number),
    [versions]
  )

  const [activeVersionId, setActiveVersionId] = useState<string | null>(
    sortedVersions[0]?.id ?? null
  )
  const activeVersion = useMemo(
    () => sortedVersions.find((v) => v.id === activeVersionId) ?? sortedVersions[0] ?? null,
    [sortedVersions, activeVersionId]
  )

  const [comments, setComments] = useState<CommentShape[]>(initialComments)
  const [approvals, setApprovals] = useState<ApprovalShape[]>(initialApprovals)

  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(activeVersion?.duration_sec ?? 0)
  const [authorName, setAuthorName] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [draftTimestamp, setDraftTimestamp] = useState<number | null>(null)
  const [showDraft, setShowDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [approveBusy, setApproveBusy] = useState(false)
  const [approveName, setApproveName] = useState('')
  const [approveNote, setApproveNote] = useState('')
  const [showApprove, setShowApprove] = useState(false)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const onTime = () => setCurrentTime(el.currentTime)
    const onLoaded = () => setDuration(el.duration)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onLoaded)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [activeVersion])

  const versionComments = useMemo(() => {
    if (!activeVersion) return []
    return comments
      .filter((c) => c.version_id === activeVersion.id)
      .slice()
      .sort((a, b) => {
        const at = a.timestamp_sec ?? Number.POSITIVE_INFINITY
        const bt = b.timestamp_sec ?? Number.POSITIVE_INFINITY
        if (at !== bt) return at - bt
        return a.created_at.localeCompare(b.created_at)
      })
  }, [comments, activeVersion])

  const versionApproval = useMemo(() => {
    if (!activeVersion) return null
    return approvals.find((a) => a.version_id === activeVersion.id && a.approver_kind === 'client') ?? null
  }, [approvals, activeVersion])

  const src = useMemo(() => {
    if (!activeVersion) return null
    if (activeVersion.video_url) return activeVersion.video_url
    if (activeVersion.box_file_id) return `/api/videos/stream/${activeVersion.box_file_id}?token=${encodeURIComponent(token)}`
    return null
  }, [activeVersion, token])

  function seekTo(sec: number) {
    const el = videoRef.current
    if (!el) return
    el.currentTime = sec
    el.play().catch(() => {})
  }

  async function submitComment() {
    if (!activeVersion || !draftBody.trim()) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('add_client_video_comment', {
        p_token: token,
        p_version_id: activeVersion.id,
        p_timestamp: draftTimestamp,
        p_body: draftBody.trim(),
        p_author_name: authorName.trim() || 'Client',
      })
      if (error) throw error
      if (!data) throw new Error('RPC returned no id — bad token?')

      const newRow: CommentShape = {
        id: (data as { id: string }).id,
        version_id: activeVersion.id,
        author_kind: 'client',
        author_name: authorName.trim() || 'Client',
        timestamp_sec: draftTimestamp,
        body: draftBody.trim(),
        acknowledged: false,
        created_at: new Date().toISOString(),
      }
      setComments((prev) => [...prev, newRow])

      fetch('/api/videos/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'comment',
          projectId: project.id,
          versionId: activeVersion.id,
          body: draftBody.trim(),
          timestampSec: draftTimestamp,
          authorName: authorName.trim() || 'Client',
          authorKind: 'client',
        }),
      }).catch(() => {})

      setShowDraft(false)
      setDraftBody('')
      setDraftTimestamp(null)
    } catch (err) {
      console.error(err)
      alert('Could not post comment. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function submitApproval() {
    if (!activeVersion) return
    if (!approveName.trim()) {
      alert('Please enter your name so your team knows who approved.')
      return
    }
    setApproveBusy(true)
    try {
      const { data, error } = await supabase.rpc('client_approve_video_version', {
        p_token: token,
        p_version_id: activeVersion.id,
        p_approver_name: approveName.trim(),
        p_note: approveNote.trim() || null,
      })
      if (error) throw error
      if (!data) throw new Error('RPC returned no id — bad token?')

      const newApproval: ApprovalShape = {
        id: (data as { id: string }).id,
        version_id: activeVersion.id,
        approver_kind: 'client',
        approver_name: approveName.trim(),
        note: approveNote.trim() || null,
        created_at: new Date().toISOString(),
      }
      setApprovals((prev) => {
        const filtered = prev.filter(
          (a) => !(a.version_id === activeVersion.id && a.approver_kind === 'client')
        )
        return [...filtered, newApproval]
      })

      fetch('/api/videos/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'client_approved',
          projectId: project.id,
          versionId: activeVersion.id,
          approverName: approveName.trim(),
        }),
      }).catch(() => {})

      setShowApprove(false)
    } catch (err) {
      console.error(err)
      alert('Could not record your approval. Please try again.')
    } finally {
      setApproveBusy(false)
    }
  }

  const markers = useMemo(() => {
    if (!duration || duration <= 0) return []
    return versionComments
      .filter((c) => c.timestamp_sec != null && (c.timestamp_sec as number) <= duration)
      .map((c) => ({
        id: c.id,
        left: `${((c.timestamp_sec as number) / duration) * 100}%`,
        timestamp: c.timestamp_sec as number,
        kind: c.author_kind,
      }))
  }, [versionComments, duration])

  return (
    <div className="min-h-screen bg-[#0f1117] text-gray-100 flex flex-col">
      <header className="bg-white border-b border-gray-200 text-gray-900">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          {project.client?.fb_page_logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={project.client.fb_page_logo_url}
              alt={project.client.name}
              className="w-10 h-10 rounded-full object-cover border border-gray-200"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-[#1877F2] text-white font-bold flex items-center justify-center text-xs">
              {(project.client?.name ?? 'FTE').slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold truncate">{project.title}</h1>
            <p className="text-xs text-gray-500 truncate">
              {project.client?.name ?? 'Follow The Eyes'} · Video Proof
            </p>
          </div>
          <span
            className={`text-[11px] font-medium px-2 py-0.5 rounded border ${
              project.status === 'approved'
                ? 'bg-green-100 text-green-700 border-green-300'
                : 'bg-amber-100 text-amber-700 border-amber-300'
            }`}
          >
            {project.status === 'approved' ? 'Approved' : 'In review'}
          </span>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 grid grid-cols-1 md:grid-cols-[1fr_340px] gap-6">
        <div>
          {!activeVersion ? (
            <p className="text-sm text-gray-500">No versions uploaded yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className="text-xs text-gray-400">Version:</span>
                {sortedVersions.map((v) => (
                  <button
                    key={v.id}
                    onClick={() => setActiveVersionId(v.id)}
                    className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                      v.id === activeVersion.id
                        ? 'bg-blue-600/30 border-blue-500 text-white'
                        : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    V{v.version_number}
                  </button>
                ))}
              </div>

              <div className="bg-black rounded-lg overflow-hidden">
                {src ? (
                  <video
                    ref={videoRef}
                    src={src}
                    controls
                    preload="metadata"
                    className="w-full aspect-video"
                  />
                ) : (
                  <div className="aspect-video flex items-center justify-center text-gray-500 text-sm">
                    Video not ready yet.
                  </div>
                )}
              </div>

              <div className="mt-3">
                <div className="relative h-6">
                  <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-gray-800 rounded" />
                  {duration > 0 && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 h-1 bg-blue-600 rounded"
                      style={{ width: `${(currentTime / duration) * 100}%` }}
                    />
                  )}
                  {markers.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => seekTo(m.timestamp)}
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group"
                      style={{ left: m.left }}
                    >
                      <span
                        className={`block w-3 h-3 rounded-full border-2 border-[#0f1117] ${
                          m.kind === 'client' ? 'bg-amber-400' : 'bg-blue-400'
                        } group-hover:scale-125 transition-transform`}
                      />
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  {formatTs(currentTime)} / {formatTs(duration)}
                </p>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
                <button
                  onClick={() => {
                    setDraftTimestamp(currentTime)
                    setDraftBody('')
                    setShowDraft(true)
                  }}
                  className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-100"
                >
                  + Leave comment at {formatTs(currentTime)}
                </button>

                {versionApproval ? (
                  <span className="text-sm px-3 py-1.5 rounded-lg bg-green-900/50 border border-green-700 text-green-300 font-medium">
                    ✓ Approved by {versionApproval.approver_name ?? 'Client'}
                  </span>
                ) : (
                  <button
                    onClick={() => { setApproveName(''); setApproveNote(''); setShowApprove(true) }}
                    className="text-sm px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white font-semibold"
                  >
                    Approve V{activeVersion.version_number}
                  </button>
                )}
              </div>

              {activeVersion.notes && (
                <p className="text-xs text-gray-400 mt-4 whitespace-pre-wrap">
                  <span className="text-gray-500">Notes: </span>{activeVersion.notes}
                </p>
              )}
            </>
          )}
        </div>

        <aside>
          <div className="bg-gray-900/60 border border-gray-800 rounded-xl">
            <div className="px-4 py-3 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-white">
                Comments {activeVersion ? `· V${activeVersion.version_number}` : ''}
              </h2>
            </div>
            <div className="p-3 space-y-2 max-h-[500px] overflow-y-auto">
              {versionComments.length === 0 ? (
                <p className="text-xs text-gray-500 p-3">
                  No comments yet. Click a point on the timeline or use &quot;Leave comment&quot; to add feedback.
                </p>
              ) : (
                versionComments.map((c) => (
                  <div
                    key={c.id}
                    className="bg-[#141820] border border-gray-800 rounded-lg p-3"
                  >
                    <div className="flex items-start gap-2 mb-1">
                      {c.timestamp_sec != null ? (
                        <button
                          onClick={() => seekTo(c.timestamp_sec as number)}
                          className={`text-[11px] font-semibold px-1.5 py-0.5 rounded hover:opacity-80 ${
                            c.author_kind === 'client'
                              ? 'bg-amber-900/50 text-amber-300'
                              : 'bg-blue-900/50 text-blue-300'
                          }`}
                        >
                          {formatTs(c.timestamp_sec)}
                        </button>
                      ) : (
                        <span className="text-[10px] text-gray-500 uppercase tracking-wide">General</span>
                      )}
                      <span className="text-xs text-gray-300 truncate">
                        {c.author_name ?? (c.author_kind === 'client' ? 'Client' : 'Internal')}
                      </span>
                    </div>
                    <p className="text-sm text-gray-100 whitespace-pre-wrap">{c.body}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <p className="text-[11px] text-gray-500 mt-3">
            Your feedback is visible to the Follow The Eyes team. Click &quot;Approve&quot; when you&apos;re ready to sign off on this version.
          </p>
        </aside>
      </main>

      {/* Comment draft */}
      {showDraft && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#141820] border border-gray-700 rounded-xl w-full max-w-md p-6">
            <h2 className="text-base font-semibold text-white mb-1">
              Comment at {formatTs(draftTimestamp ?? currentTime)}
            </h2>
            <p className="text-xs text-gray-400 mb-4">
              <button
                onClick={() => setDraftTimestamp(null)}
                className={`underline ${draftTimestamp == null ? 'text-blue-400' : 'text-gray-400'}`}
              >
                Remove timestamp
              </button>
              {' '}to leave a general comment.
            </p>

            <label className="block text-xs text-gray-400 mb-1">Your name</label>
            <input
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              placeholder="e.g. Sarah M."
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mb-3"
            />

            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="Feedback for this moment…"
              rows={5}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowDraft(false)}
                className="text-sm px-3 py-1.5 rounded text-gray-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={submitComment}
                disabled={!draftBody.trim() || busy}
                className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white font-medium"
              >
                {busy ? 'Posting…' : 'Post'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Approve modal */}
      {showApprove && activeVersion && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#141820] border border-gray-700 rounded-xl w-full max-w-md p-6">
            <h2 className="text-base font-semibold text-white mb-1">
              Approve V{activeVersion.version_number}?
            </h2>
            <p className="text-xs text-gray-400 mb-4">
              This lets the team know this version is cleared for delivery.
            </p>

            <label className="block text-xs text-gray-400 mb-1">Your name (required)</label>
            <input
              value={approveName}
              onChange={(e) => setApproveName(e.target.value)}
              placeholder="e.g. Sarah M."
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mb-3"
              autoFocus
            />

            <label className="block text-xs text-gray-400 mb-1">Note (optional)</label>
            <textarea
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
              rows={3}
              placeholder="e.g. Looks great, ship it."
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mb-4"
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowApprove(false)}
                className="text-sm px-3 py-1.5 rounded text-gray-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={submitApproval}
                disabled={!approveName.trim() || approveBusy}
                className="text-sm px-4 py-2 rounded bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white font-semibold"
              >
                {approveBusy ? 'Approving…' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
