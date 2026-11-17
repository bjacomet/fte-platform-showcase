'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type {
  Card,
  Client,
  VideoApproval,
  VideoComment,
  VideoProject,
  VideoVersion,
} from '@/types'

interface Props {
  project: VideoProject
  versions: VideoVersion[]
  comments: VideoComment[]
  approvals: VideoApproval[]
  clients: Client[]
  currentUserId: string
  currentUserEmail: string | null
  linkedCard: Card | null
}

function formatTs(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return '--:--'
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

export default function VideoProjectView({
  project,
  versions,
  comments,
  approvals,
  clients,
  currentUserId,
  currentUserEmail,
  linkedCard,
}: Props) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const [activeVersionId, setActiveVersionId] = useState<string | null>(
    versions[0]?.id ?? null
  )
  const activeVersion = useMemo(
    () => versions.find((v) => v.id === activeVersionId) ?? versions[0] ?? null,
    [versions, activeVersionId]
  )

  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(activeVersion?.duration_sec ?? 0)
  const [showCommentDraft, setShowCommentDraft] = useState(false)
  const [draftBody, setDraftBody] = useState('')
  const [draftTimestamp, setDraftTimestamp] = useState<number | null>(null)
  const [shareCopied, setShareCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uploadUrl, setUploadUrl] = useState('')
  const [uploadNotes, setUploadNotes] = useState('')
  const [uploadBoxFileId, setUploadBoxFileId] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const shareLink = useMemo(
    () => typeof window !== 'undefined'
      ? `${window.location.origin}/videos/review/${project.share_token}`
      : '',
    [project.share_token]
  )
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(project.title)
  const [cardLinkDraft, setCardLinkDraft] = useState(project.card_id ?? '')
  const [clientDraft, setClientDraft] = useState(project.client_id ?? '')

  // Sync current playback time; set duration once loaded.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const onTime = () => setCurrentTime(el.currentTime)
    const onLoaded = () => {
      setDuration(el.duration)
      // Persist duration to the version if it's missing, once.
      if (activeVersion && activeVersion.duration_sec == null && Number.isFinite(el.duration)) {
        supabase
          .from('video_versions')
          .update({ duration_sec: el.duration })
          .eq('id', activeVersion.id)
      }
    }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onLoaded)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [activeVersion, supabase])

  const commentsForVersion = useMemo(() => {
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

  const approvalsForVersion = useMemo(() => {
    if (!activeVersion) return { internal: null as VideoApproval | null, client: null as VideoApproval | null }
    let internal: VideoApproval | null = null
    let client: VideoApproval | null = null
    for (const a of approvals) {
      if (a.version_id !== activeVersion.id) continue
      if (a.approver_kind === 'internal') internal = a
      else client = a
    }
    return { internal, client }
  }, [approvals, activeVersion])

  function seekTo(sec: number) {
    const el = videoRef.current
    if (!el) return
    el.currentTime = sec
    el.play().catch(() => {/* some browsers require user gesture; ignore */})
  }

  function openCommentAt(sec: number) {
    setDraftTimestamp(sec)
    setDraftBody('')
    setShowCommentDraft(true)
  }

  async function submitComment() {
    if (!activeVersion || !draftBody.trim()) return
    setBusy(true)
    try {
      const body = draftBody.trim()
      const ts = draftTimestamp
      const { error } = await supabase.from('video_comments').insert({
        version_id: activeVersion.id,
        author_kind: 'internal',
        author_user_id: currentUserId,
        author_name: currentUserEmail ?? 'Internal',
        timestamp_sec: ts,
        body,
      })
      if (error) throw error

      // Fire Slack notification (best effort).
      fetch('/api/videos/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'comment',
          projectId: project.id,
          versionId: activeVersion.id,
          body,
          timestampSec: ts,
          authorName: currentUserEmail ?? 'Internal',
          authorKind: 'internal',
        }),
      }).catch(() => {})

      setShowCommentDraft(false)
      setDraftBody('')
      setDraftTimestamp(null)
      router.refresh()
    } catch (err) {
      console.error('submit comment failed', err)
      alert('Could not save comment. Refresh and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function toggleAcknowledge(comment: VideoComment) {
    const next = !comment.acknowledged
    const { error } = await supabase
      .from('video_comments')
      .update({
        acknowledged: next,
        acknowledged_at: next ? new Date().toISOString() : null,
        acknowledged_by: next ? currentUserId : null,
      })
      .eq('id', comment.id)
    if (error) {
      console.error('acknowledge failed', error)
      return
    }
    router.refresh()
  }

  async function internalApprove() {
    if (!activeVersion) return
    setBusy(true)
    try {
      const { error } = await supabase
        .from('video_approvals')
        .upsert(
          {
            version_id: activeVersion.id,
            approver_kind: 'internal',
            approver_user_id: currentUserId,
            approver_name: currentUserEmail ?? 'Internal',
          },
          { onConflict: 'version_id,approver_kind' }
        )
      if (error) throw error

      fetch('/api/videos/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'internal_approved',
          projectId: project.id,
          versionId: activeVersion.id,
          approverName: currentUserEmail ?? 'Internal',
        }),
      }).catch(() => {})

      router.refresh()
    } catch (err) {
      console.error('internal approve failed', err)
      alert('Could not record approval.')
    } finally {
      setBusy(false)
    }
  }

  async function unApprove(kind: 'internal' | 'client') {
    if (!activeVersion) return
    const ok = confirm(`Remove ${kind} approval for V${activeVersion.version_number}?`)
    if (!ok) return
    setBusy(true)
    try {
      const { error } = await supabase
        .from('video_approvals')
        .delete()
        .match({ version_id: activeVersion.id, approver_kind: kind })
      if (error) throw error
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(shareLink)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 1800)
    } catch { /* non-fatal */ }
  }

  async function uploadVersion() {
    if (!uploadUrl.trim() && !uploadBoxFileId.trim()) return
    setBusy(true)
    try {
      const nextNumber = versions.length > 0
        ? Math.max(...versions.map((v) => v.version_number)) + 1
        : 1
      const { data, error } = await supabase
        .from('video_versions')
        .insert({
          project_id: project.id,
          version_number: nextNumber,
          video_url: uploadUrl.trim() || null,
          box_file_id: uploadBoxFileId.trim() || null,
          notes: uploadNotes.trim() || null,
          uploaded_by: currentUserId,
        })
        .select('id')
        .single()
      if (error) throw error

      fetch('/api/videos/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'new_version',
          projectId: project.id,
          versionNumber: nextNumber,
          uploadedBy: currentUserEmail ?? 'Internal',
        }),
      }).catch(() => {})

      setUploadOpen(false)
      setUploadUrl('')
      setUploadNotes('')
      setUploadBoxFileId('')
      setActiveVersionId(data.id)
      router.refresh()
    } catch (err) {
      console.error('upload failed', err)
      alert('Could not create version.')
    } finally {
      setBusy(false)
    }
  }

  async function saveProjectMeta() {
    setBusy(true)
    try {
      const { error } = await supabase
        .from('video_projects')
        .update({
          title: titleDraft.trim() || project.title,
          client_id: clientDraft || null,
          card_id: cardLinkDraft || null,
        })
        .eq('id', project.id)
      if (error) throw error
      setEditingTitle(false)
      router.refresh()
    } catch (err) {
      console.error('save project meta failed', err)
    } finally {
      setBusy(false)
    }
  }

  async function archiveProject() {
    const ok = confirm('Archive this project? It will be hidden from the list but data is kept.')
    if (!ok) return
    await supabase.from('video_projects').update({ archived: true }).eq('id', project.id)
    router.push('/videos')
  }

  const resolvedVideoSrc = useMemo(() => {
    if (!activeVersion) return null
    if (activeVersion.video_url) return activeVersion.video_url
    if (activeVersion.box_file_id) {
      // Proxy through our API route so Box credentials stay server-side.
      return `/api/videos/stream/${activeVersion.box_file_id}`
    }
    return null
  }, [activeVersion])

  // Build marker positions along the timeline.
  const markers = useMemo(() => {
    if (!duration || duration <= 0) return []
    return commentsForVersion
      .filter((c) => c.timestamp_sec != null && c.timestamp_sec <= duration)
      .map((c) => ({
        id: c.id,
        left: `${((c.timestamp_sec as number) / duration) * 100}%`,
        author: c.author_name ?? (c.author_kind === 'client' ? 'Client' : 'Internal'),
        body: c.body,
        timestamp: c.timestamp_sec as number,
        acknowledged: c.acknowledged,
        kind: c.author_kind,
      }))
  }, [commentsForVersion, duration])

  return (
    <div className="min-h-screen bg-[#0f1117] text-gray-100 flex flex-col">

      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-900 border-b border-gray-700/60 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap min-w-0">
          <Link href="/videos" className="text-xs text-gray-400 hover:text-white">← All projects</Link>

          {editingTitle ? (
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveProjectMeta}
              onKeyDown={(e) => { if (e.key === 'Enter') saveProjectMeta() }}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          ) : (
            <button
              onClick={() => { setTitleDraft(project.title); setEditingTitle(true) }}
              className="text-lg font-bold text-white tracking-tight hover:underline"
              title="Rename"
            >
              {project.title}
            </button>
          )}

          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
              project.status === 'approved'
                ? 'bg-green-900/40 text-green-300 border-green-700/60'
                : 'bg-amber-900/40 text-amber-300 border-amber-700/60'
            }`}
          >
            {project.status === 'approved' ? 'Approved' : 'In review'}
          </span>

          {project.clients?.name && (
            <span className="text-xs text-gray-400">{project.clients.name}</span>
          )}

          {linkedCard && (
            <span className="text-[11px] text-blue-400 bg-blue-950/40 border border-blue-800/50 rounded px-2 py-0.5">
              Linked card: {linkedCard.title.slice(0, 40)}{linkedCard.title.length > 40 ? '…' : ''}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setUploadOpen(true)}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium"
          >
            + Upload version
          </button>
          <button
            onClick={copyShareLink}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-100 font-medium"
          >
            {shareCopied ? 'Copied!' : 'Copy client share link'}
          </button>
          <button
            onClick={archiveProject}
            className="text-xs text-gray-500 hover:text-red-400"
            title="Archive project"
          >
            Archive
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_380px]">
        {/* Player column */}
        <div className="px-4 py-6 border-r border-gray-800/60">
          {!activeVersion ? (
            <div className="max-w-3xl mx-auto text-center text-gray-500 mt-16">
              <p className="text-sm">No versions uploaded yet.</p>
              <button
                onClick={() => setUploadOpen(true)}
                className="mt-3 text-sm text-blue-400 hover:underline"
              >
                Upload V1 →
              </button>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto">
              {/* Version selector */}
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className="text-xs text-gray-400">Version:</span>
                {versions.map((v) => (
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

              {/* Player */}
              <div className="bg-black rounded-lg overflow-hidden">
                {resolvedVideoSrc ? (
                  <video
                    ref={videoRef}
                    src={resolvedVideoSrc}
                    controls
                    preload="metadata"
                    className="w-full aspect-video"
                  />
                ) : (
                  <div className="aspect-video flex items-center justify-center text-gray-500 text-sm">
                    No playable URL set for this version
                  </div>
                )}
              </div>

              {/* Timeline with comment markers */}
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
                      title={`${formatTs(m.timestamp)} — ${m.author}: ${m.body.slice(0, 80)}`}
                      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group"
                      style={{ left: m.left }}
                    >
                      <span
                        className={`block w-3 h-3 rounded-full border-2 border-[#0f1117] ${
                          m.acknowledged
                            ? 'bg-green-500'
                            : m.kind === 'client'
                            ? 'bg-amber-400'
                            : 'bg-blue-400'
                        } group-hover:scale-125 transition-transform`}
                      />
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  {formatTs(currentTime)} / {formatTs(duration)}
                </p>
              </div>

              {/* Comment + approve toolbar */}
              <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
                <button
                  onClick={() => openCommentAt(currentTime)}
                  className="text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-100"
                >
                  + Comment at {formatTs(currentTime)}
                </button>

                <div className="flex items-center gap-2">
                  {approvalsForVersion.internal ? (
                    <button
                      onClick={() => unApprove('internal')}
                      className="text-xs px-2.5 py-1.5 rounded bg-green-900/60 border border-green-700/60 text-green-300 hover:bg-green-900"
                      title={`Approved by ${approvalsForVersion.internal.approver_name ?? 'Internal'}`}
                    >
                      ✓ Internal approved
                    </button>
                  ) : (
                    <button
                      onClick={internalApprove}
                      disabled={busy}
                      className="text-xs px-2.5 py-1.5 rounded bg-green-700 hover:bg-green-600 text-white font-medium disabled:opacity-60"
                    >
                      Approve (internal)
                    </button>
                  )}

                  {approvalsForVersion.client ? (
                    <span
                      className="text-xs px-2.5 py-1.5 rounded bg-green-900/60 border border-green-700/60 text-green-300"
                      title={`Approved by ${approvalsForVersion.client.approver_name ?? 'Client'}`}
                    >
                      ✓ Client approved
                    </span>
                  ) : (
                    <span className="text-xs px-2.5 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-400">
                      Client: awaiting
                    </span>
                  )}
                </div>
              </div>

              {/* Version notes */}
              {activeVersion.notes && (
                <p className="text-xs text-gray-400 mt-4 whitespace-pre-wrap">
                  <span className="text-gray-500">Notes: </span>{activeVersion.notes}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Comments column */}
        <aside className="bg-gray-900/40 flex flex-col">
          <div className="px-4 py-3 border-b border-gray-800 sticky top-0 bg-gray-900/90 backdrop-blur">
            <h2 className="text-sm font-semibold text-white">
              Comments {activeVersion ? `· V${activeVersion.version_number}` : ''}
            </h2>
            <p className="text-[11px] text-gray-500">
              Click a row to jump to its timestamp.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {commentsForVersion.length === 0 ? (
              <p className="text-xs text-gray-500 p-3">
                No comments yet. Play the video and click &quot;+ Comment&quot; to leave a timestamped note.
              </p>
            ) : (
              commentsForVersion.map((c) => (
                <div
                  key={c.id}
                  className={`bg-[#141820] border ${
                    c.acknowledged ? 'border-green-800/50' : 'border-gray-800'
                  } rounded-lg p-3 hover:border-gray-600 transition-colors`}
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
                    <span className="text-[10px] text-gray-500 ml-auto flex-none">
                      {new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  <p className="text-sm text-gray-100 whitespace-pre-wrap">{c.body}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => toggleAcknowledge(c)}
                      className={`text-[11px] ${
                        c.acknowledged
                          ? 'text-green-400 hover:text-green-300'
                          : 'text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {c.acknowledged ? '✓ Acknowledged' : 'Acknowledge'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Project settings */}
          <div className="px-3 py-3 border-t border-gray-800 space-y-2 bg-gray-900/60">
            <label className="block text-[11px] text-gray-500">Client</label>
            <select
              value={clientDraft}
              onChange={(e) => setClientDraft(e.target.value)}
              onBlur={saveProjectMeta}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
            >
              <option value="">— no client —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>

            <label className="block text-[11px] text-gray-500 mt-2">Linked board card id (optional)</label>
            <input
              value={cardLinkDraft}
              onChange={(e) => setCardLinkDraft(e.target.value)}
              onBlur={saveProjectMeta}
              placeholder="paste card UUID — when client approves, the card's approval_status flips to approved"
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 font-mono"
            />
          </div>
        </aside>
      </div>

      {/* Comment draft modal */}
      {showCommentDraft && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#141820] border border-gray-700 rounded-xl w-full max-w-md p-6">
            <h2 className="text-base font-semibold text-white mb-1">
              Comment at {formatTs(draftTimestamp ?? currentTime)}
            </h2>
            <p className="text-xs text-gray-400 mb-4">
              Leave a general comment instead?{' '}
              <button
                onClick={() => setDraftTimestamp(null)}
                className={`underline ${draftTimestamp == null ? 'text-blue-400' : 'text-gray-400'}`}
              >
                Remove timestamp
              </button>
            </p>
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
                onClick={() => setShowCommentDraft(false)}
                className="text-sm px-3 py-1.5 rounded text-gray-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={submitComment}
                disabled={!draftBody.trim() || busy}
                className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white font-medium"
              >
                {busy ? 'Saving…' : 'Post comment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload version modal */}
      {uploadOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#141820] border border-gray-700 rounded-xl w-full max-w-lg p-6">
            <h2 className="text-base font-semibold text-white mb-1">
              Upload V{versions.length + 1}
            </h2>
            <p className="text-xs text-gray-400 mb-4">
              Point at the video file. Prefer Box — paste either a Box file id or a direct playback URL.
            </p>

            <label className="block text-xs text-gray-400 mb-1">Box file id (preferred)</label>
            <input
              value={uploadBoxFileId}
              onChange={(e) => setUploadBoxFileId(e.target.value)}
              placeholder="e.g. 1234567890"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mb-3 font-mono"
            />

            <label className="block text-xs text-gray-400 mb-1">— or — direct video URL</label>
            <input
              value={uploadUrl}
              onChange={(e) => setUploadUrl(e.target.value)}
              placeholder="https://…/video.mp4"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mb-3"
            />

            <label className="block text-xs text-gray-400 mb-1">Version notes (optional)</label>
            <textarea
              value={uploadNotes}
              onChange={(e) => setUploadNotes(e.target.value)}
              rows={3}
              placeholder="e.g. Swapped music, added new logo at 0:42"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 mb-4"
            />

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setUploadOpen(false)}
                className="text-sm px-3 py-1.5 rounded text-gray-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={uploadVersion}
                disabled={busy || (!uploadUrl.trim() && !uploadBoxFileId.trim())}
                className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 text-white font-medium"
              >
                {busy ? 'Creating…' : `Create V${versions.length + 1}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
