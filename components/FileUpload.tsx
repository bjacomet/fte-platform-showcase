'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { CardFile } from '@/types'
import { createClient } from '@/lib/supabase/client'
import { generateThumbnail } from '@/lib/imageThumb'
import { uploadToStorageWithProgress } from '@/lib/storageUpload'
import { isCreativeFileName, looksLikeMisnamedCreative } from '@/lib/adviewerFiles'
import { AUDIO_SCRIPT_ACCEPT, isAudioType, isScriptType, isUnplayableAudio, resolveMimeType } from '@/lib/fileTypes'

interface Props {
  cardId: string
  onFilesChanged?: () => void
  pendingFiles?: File[] | null
  onPendingFilesConsumed?: () => void
  currentPreviewImageUrl?: string | null
  onPreviewImageChanged?: (url: string) => void
  // Card's media_type — lets uploads on single-social cards snapshot the Adviewer
  // round anchored to the replaced graphic (cards.preview_image_url).
  mediaType?: string | null
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']
const HTML_TYPES = ['text/html']
// Single-social media types — card-level Adviewer pins anchor to the one graphic.
const SOCIAL_TYPES = ['Social Ad Request', 'Organic Post', 'Reel Request']

// Client-side upload ceiling. The hard cap is Supabase's Free-plan 50 MB GLOBAL
// storage limit (effective = min(global 50 MB, creative-files bucket 200 MB) = 50 MB),
// so anything larger 413s mid-PUT with an opaque error. Pre-flight it here and flag
// the size inline instead of letting the upload start. Raise to match the bucket if
// the project moves to Supabase Pro.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50 MB

const APPROVAL_COLORS: Record<string, string> = {
  pending:           'bg-yellow-900/50 text-yellow-300 border-yellow-700/50',
  approved:          'bg-green-900/50 text-green-300 border-green-700/50',
  rejected:          'bg-red-900/50 text-red-300 border-red-700/50',
  changes_requested: 'bg-orange-900/50 text-orange-300 border-orange-700/50',
}

function FileIcon({ type }: { type: string | null }) {
  const t = type ?? ''
  if (t.startsWith('image/')) return <span className="text-lg">🖼️</span>
  if (t.startsWith('video/')) return <span className="text-lg">🎬</span>
  if (t === 'application/pdf') return <span className="text-lg">📄</span>
  if (t.includes('zip')) return <span className="text-lg">📦</span>
  if (t === 'text/html') return <span className="text-lg">🌐</span>
  if (t.startsWith('audio/')) return <span className="text-lg">🎵</span>
  if (isScriptType(t)) return <span className="text-lg">📝</span>
  return <span className="text-lg">📎</span>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Per-file upload progress state ──────────────────────────────────────────
interface UploadItem {
  name: string
  type: string
  size: number
  previewUrl: string | null
  loaded: number   // bytes uploaded so far
  total: number    // total bytes
  done: boolean
  error: string | null
}

export default function FileUpload({ cardId, onFilesChanged, pendingFiles, onPendingFilesConsumed, currentPreviewImageUrl, onPreviewImageChanged, mediaType }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [files, setFiles] = useState<CardFile[]>([])
  // Carousel slide graphics live in `carousel_slides`, not `card_files`. We surface them here
  // (read-only) so the Files tab isn't empty for carousel cards — they're edited in the Creative tab.
  const [slideImages, setSlideImages] = useState<{ id: string; position: number; image_url: string; headline: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const processedPendingRef = useRef<File[] | null>(null)
  const previewUrlRef = useRef(currentPreviewImageUrl)
  useEffect(() => { previewUrlRef.current = currentPreviewImageUrl }, [currentPreviewImageUrl])

  const isUploading = uploadQueue.some((u) => !u.done && !u.error)

  useEffect(() => { loadFiles() }, [cardId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadFiles() {
    setLoading(true)
    const { data } = await supabase
      .from('card_files')
      .select('*')
      .eq('card_id', cardId)
      .order('created_at', { ascending: true })
    const list = (data as CardFile[]) ?? []
    setFiles(list)

    // Carousel slide graphics (read-only mirror so the Files tab isn't empty for carousels).
    const { data: slideData } = await supabase
      .from('carousel_slides')
      .select('id, position, image_url, headline')
      .eq('card_id', cardId)
      .not('image_url', 'is', null)
      .order('position', { ascending: true })
    setSlideImages((slideData as { id: string; position: number; image_url: string; headline: string | null }[]) ?? [])

    // Batch-sign all paths in a single request (was one request per file — N+1)
    const urls: Record<string, string> = {}
    const pathById = list
      .map((f) => ({ id: f.id, path: filePathFromUrl(f.file_url) }))
      .filter((p): p is { id: string; path: string } => !!p.path)
    if (pathById.length > 0) {
      const { data: signedList } = await supabase.storage
        .from('creative-files')
        .createSignedUrls(pathById.map((p) => p.path), 3600)
      signedList?.forEach((s: { signedUrl: string | null }, i: number) => {
        if (s.signedUrl) urls[pathById[i].id] = s.signedUrl
      })
    }
    setSignedUrls(urls)
    setLoading(false)

    // Auto-set cover from the first image if none is set
    if (!previewUrlRef.current) {
      const firstImage = list.find((f) => IMAGE_TYPES.includes(f.file_type ?? ''))
      if (firstImage) {
        const imgPath = filePathFromUrl(firstImage.file_url)
        if (imgPath) {
          const { data: pub } = supabase.storage.from('creative-files').getPublicUrl(imgPath)
          if (pub?.publicUrl) {
            await supabase.from('cards').update({ preview_image_url: pub.publicUrl }).eq('id', cardId)
            onPreviewImageChanged?.(pub.publicUrl)
          }
        }
      }
    }
  }

  function filePathFromUrl(url: string): string | null {
    if (!url) return null
    const match = url.match(/creative-files\/(.+)/)
    // Old records: full Supabase URL containing "creative-files/" → extract path after it
    // New records: already stored as bare path (e.g. "cards/cardId/file.png") → use as-is
    return match ? match[1] : url
  }

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const list = Array.from(fileList)
    if (!list.length) return

    const BLOB_PREVIEW_TYPES = [...IMAGE_TYPES, ...HTML_TYPES, 'video/mp4', 'video/quicktime', 'application/pdf']

    // Build initial queue entries with preview URLs
    const initialQueue: UploadItem[] = list.map((f) => {
      const oversize = f.size > MAX_UPLOAD_BYTES
      return {
        name: f.name,
        type: f.type,
        size: f.size,
        // Skip building a preview blob for a file we won't upload anyway.
        previewUrl: !oversize && BLOB_PREVIEW_TYPES.includes(f.type) ? URL.createObjectURL(f) : null,
        loaded: 0,
        total: f.size,
        done: oversize,
        error: oversize
          ? `${Math.round(f.size / 1024 / 1024)} MB — over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`
          : null,
      }
    })
    setUploadQueue(initialQueue)

    // Get the live session JWT — required for authenticated storage uploads
    const { data: { session } } = await supabase.auth.getSession()
    const accessToken = session?.access_token ?? ''
    if (!accessToken) {
      console.error('No active session — cannot upload files')
      setUploadQueue([])
      return
    }

    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      // Oversize files were flagged in the queue above; never attempt the PUT.
      if (file.size > MAX_UPLOAD_BYTES) continue
      const mime = resolveMimeType(file)
      const typedFile = mime === file.type ? file : new File([file], file.name, { type: mime })
      const timestamp = Date.now()
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `cards/${cardId}/${timestamp}_${safeName}`

      const { error: uploadError } = await uploadToStorageWithProgress(
        path,
        typedFile,
        accessToken,
        (loaded, total) => {
          setUploadQueue((prev) =>
            prev.map((u, idx) => idx === i ? { ...u, loaded, total } : u)
          )
        }
      )

      if (uploadError) {
        setUploadQueue((prev) =>
          prev.map((u, idx) => idx === i ? { ...u, done: true, error: uploadError.message } : u)
        )
        console.error('Upload error:', uploadError.message)
        continue
      }

      await supabase.from('card_files').insert({
        card_id: cardId,
        file_name: file.name,
        file_url: path,
        file_type: mime || null,
        approval_status: 'pending',
      })

      setUploadQueue((prev) =>
        prev.map((u, idx) => idx === i ? { ...u, loaded: u.total, done: true } : u)
      )

      // Always update the card cover when an image is uploaded
      if (IMAGE_TYPES.includes(file.type)) {
        const { data: pub } = supabase.storage.from('creative-files').getPublicUrl(path)
        if (pub?.publicUrl) {
          // Single-social replace lifecycle: a new graphic supersedes the round of
          // Adviewer pins anchored to the OLD preview graphic — freeze them into
          // client_notes.history (with a small old-graphic thumbnail) before the
          // cover switches. Best-effort; never blocks the upload.
          const oldPreview = previewUrlRef.current
          if (SOCIAL_TYPES.includes(mediaType ?? '') && oldPreview && oldPreview !== pub.publicUrl) {
            let thumbUrl: string | null = null
            const blob = await generateThumbnail(oldPreview)
            if (blob) {
              const thumbPath = `history/${cardId}/card-${timestamp}.jpg`
              const { error: thumbErr } = await supabase.storage
                .from('creative-files')
                .upload(thumbPath, blob, { contentType: 'image/jpeg', upsert: true })
              if (!thumbErr) {
                const { data: tp } = supabase.storage.from('creative-files').getPublicUrl(thumbPath)
                thumbUrl = tp?.publicUrl ?? null
              }
            }
            try {
              await fetch('/api/adviewer/snapshot-card-round', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cardId, slideId: null, label: 'Ad graphic', thumbUrl }),
              })
            } catch { /* snapshot is best-effort */ }
          }
          await supabase.from('cards').update({ preview_image_url: pub.publicUrl }).eq('id', cardId)
          previewUrlRef.current = pub.publicUrl
          onPreviewImageChanged?.(pub.publicUrl)
        }
      }
    }

    // Revoke blob URLs
    initialQueue.forEach((u) => { if (u.previewUrl) URL.revokeObjectURL(u.previewUrl) })

    await loadFiles()
    // Keep the queue on screen if anything failed (oversize flag or upload error) so the
    // message stays readable; clear it only when every file uploaded cleanly.
    setUploadQueue((prev) => (prev.some((u) => u.error) ? prev : []))
    onFilesChanged?.()
  }, [cardId, supabase, onFilesChanged, mediaType]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pendingFiles || pendingFiles === processedPendingRef.current || pendingFiles.length === 0) return
    processedPendingRef.current = pendingFiles
    onPendingFilesConsumed?.()
    handleFiles(pendingFiles)
  }, [pendingFiles, handleFiles, onPendingFilesConsumed])

  async function handleDelete(file: CardFile) {
    // Before the file is gone, snapshot any Adviewer change-request round anchored
    // to it so the client's comments survive as resolved history — full file deleted
    // to free storage, a small thumbnail retained for images.
    let thumbUrl: string | null = null
    if (IMAGE_TYPES.includes(file.file_type ?? '')) {
      const src = signedUrls[file.id]
      if (src) {
        const blob = await generateThumbnail(src)
        if (blob) {
          const thumbPath = `history/${cardId}/${file.id}.jpg`
          const { error: thumbErr } = await supabase.storage
            .from('creative-files')
            .upload(thumbPath, blob, { contentType: 'image/jpeg', upsert: true })
          if (!thumbErr) {
            const { data: pub } = supabase.storage.from('creative-files').getPublicUrl(thumbPath)
            thumbUrl = pub?.publicUrl ?? null
          }
        }
      }
    }
    try {
      await fetch('/api/adviewer/snapshot-round', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardId,
          fileId: file.id,
          fileName: file.file_name,
          dimensions: file.dimensions,
          thumbUrl,
        }),
      })
    } catch {
      // Snapshot is best-effort — never block the delete on it.
    }

    const path = filePathFromUrl(file.file_url)
    if (path) await supabase.storage.from('creative-files').remove([path])
    await supabase.from('card_files').delete().eq('id', file.id)
    // If this file was the card's preview image, clear it
    const isPreview = currentPreviewImageUrl && (
      file.file_url === currentPreviewImageUrl ||
      currentPreviewImageUrl.includes(file.file_url)
    )
    if (isPreview) {
      await supabase.from('cards').update({ preview_image_url: null }).eq('id', cardId)
      onPreviewImageChanged?.('')
    }
    setFiles((prev) => prev.filter((f) => f.id !== file.id))
    setConfirmDelete(null)
    onFilesChanged?.()
  }

  async function handleApprovalChange(fileId: string, status: string) {
    await supabase.from('card_files').update({ approval_status: status }).eq('id', fileId)
    setFiles((prev) => prev.map((f) => f.id === fileId ? { ...f, approval_status: status } : f))
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files)
  }

  return (
    <div className="space-y-3">
      {/* Drop zone */}
      <div
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onClick={() => !isUploading && inputRef.current?.click()}
        className={`
          border-2 border-dashed rounded-lg px-4 py-5 text-center transition-colors
          ${isUploading ? 'cursor-default border-gray-600' : 'cursor-pointer'}
          ${dragOver
            ? 'border-blue-500 bg-blue-950/30'
            : 'border-gray-600 hover:border-gray-400 hover:bg-gray-800/50'}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          // Audio by extension only (AUDIO_SCRIPT_ACCEPT), not audio/*: audio/* offered
          // .aiff, .opus and others the bucket rejects (supabase/add_audio_mime_types.sql).
          accept={`image/*,video/mp4,video/quicktime,application/pdf,application/zip,text/html,.html,${AUDIO_SCRIPT_ACCEPT}`}
          onChange={(e) => { if (e.target.files) handleFiles(e.target.files) }}
        />

        {uploadQueue.length > 0 ? (
          <div className="space-y-3">
            {uploadQueue.map((item, i) => {
              const percent = item.total > 0 ? Math.round((item.loaded / item.total) * 100) : 0
              const isLarge = item.size > 5 * 1024 * 1024 // show byte count for files > 5 MB

              return (
                <div key={i} className="space-y-1.5">
                  {/* Thumbnail / icon */}
                  <div className="flex items-center gap-3">
                    {item.previewUrl && IMAGE_TYPES.includes(item.type) ? (
                      <img src={item.previewUrl} alt={item.name}
                        className="w-12 h-12 object-cover rounded border border-gray-600 flex-none" />
                    ) : item.previewUrl && (item.type === 'video/mp4' || item.type === 'video/quicktime') ? (
                      <video src={item.previewUrl} muted playsInline preload="metadata"
                        className="w-12 h-12 object-cover rounded border border-gray-600 bg-black flex-none" />
                    ) : (
                      <div className="w-12 h-12 flex items-center justify-center rounded border border-gray-600 bg-gray-800/60 flex-none">
                        <FileIcon type={item.type} />
                      </div>
                    )}

                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-xs text-gray-300 font-medium truncate">{item.name}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">
                        {item.error
                          ? <span className="text-red-400">{item.error}</span>
                          : item.done
                          ? <span className="text-green-400">✓ Done</span>
                          : isLarge
                          ? `${formatBytes(item.loaded)} / ${formatBytes(item.size)}`
                          : `${percent}%`
                        }
                      </p>
                    </div>

                    <span className="flex-none text-xs font-semibold text-gray-400 tabular-nums w-9 text-right">
                      {item.done ? '' : `${percent}%`}
                    </span>
                  </div>

                  {/* Progress bar */}
                  {!item.done && !item.error && (
                    <div className="w-full bg-gray-700 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-blue-500 h-1.5 rounded-full transition-all duration-150"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  )}
                  {item.error && (
                    <div className="w-full bg-red-900/40 rounded-full h-1.5" />
                  )}
                  {item.done && !item.error && (
                    <div className="w-full bg-green-700/50 rounded-full h-1.5" />
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-300">Drop files here or <span className="text-blue-400">browse</span></p>
            <p className="text-xs text-gray-500 mt-1">Images, video, audio, scripts (PDF, Word, TXT), ZIP — up to 50MB each</p>
          </>
        )}
      </div>

      {/* File list */}
      {loading ? (
        <p className="text-xs text-gray-500">Loading files…</p>
      ) : files.length === 0 && slideImages.length === 0 ? (
        <p className="text-xs text-gray-500">No files attached yet.</p>
      ) : (
        <>
        {(() => {
          // A misnamed SIZE is the dangerous case: once other files on the card are
          // named, it's hidden from the client, who can then approve without seeing
          // it. Source photos and logos are hidden on purpose and don't trigger this.
          if (!files.some((f) => isCreativeFileName(f.file_name))) return null
          const misnamed = files.filter((f) => looksLikeMisnamedCreative(f.file_name, f.file_type))
          if (misnamed.length === 0) return null
          return (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {misnamed.length === 1 ? '1 file looks like a finished size' : `${misnamed.length} files look like finished sizes`} but
              {misnamed.length === 1 ? " isn't" : " aren't"} named like EXU-M10-…, so the client won&apos;t see {misnamed.length === 1 ? 'it' : 'them'} in Adviewer:{' '}
              <span className="text-amber-100">{misnamed.map((f) => f.file_name).join(', ')}</span>. Re-upload {misnamed.length === 1 ? 'it' : 'them'} with the month in the name (EXU-M10-…) so the client sees {misnamed.length === 1 ? 'it' : 'them'}.
            </div>
          )
        })()}
        {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((file, _i, all) => {
            // Mirrors lib/adviewerFiles.clientFacingFiles: once any file on the card
            // follows the creative naming convention, the unnamed ones (source photos,
            // logos) are hidden from the client. Say so here, where the team uploads.
            const hiddenFromAdviewer = !isCreativeFileName(file.file_name) && all.some((f) => isCreativeFileName(f.file_name))
            const isImage = IMAGE_TYPES.includes(file.file_type ?? '')
            const isHtml = HTML_TYPES.includes(file.file_type ?? '')
            // MP4/MOV on an Audio Request card is an audio spot delivered in a video
            // container; <audio> plays its soundtrack without a black video box.
            const isAudioCardVideo = mediaType === 'Audio Request'
              && (file.file_type === 'video/mp4' || file.file_type === 'video/quicktime')
            const isAudio = isAudioType(file.file_type) || isAudioCardVideo
            const unplayable = isUnplayableAudio(file.file_type)
            const signedUrl = signedUrls[file.id]
            const approvalColor = APPROVAL_COLORS[file.approval_status] ?? APPROVAL_COLORS.pending

            return (
              <li
                key={file.id}
                className="bg-gray-800/60 border border-gray-700/60 rounded-lg overflow-hidden"
              >
                {isImage && signedUrl && (
                  <a href={signedUrl} target="_blank" rel="noopener noreferrer">
                    <img src={signedUrl} alt={file.file_name}
                      loading="lazy" decoding="async"
                      className="w-full max-h-48 object-cover border-b border-gray-700/60" />
                  </a>
                )}
                {isHtml && signedUrl && (
                  <div className="border-b border-gray-700/60 bg-white relative" style={{ height: 200 }}>
                    <iframe src={signedUrl} title={file.file_name} loading="lazy"
                      className="w-full h-full" sandbox="allow-scripts allow-same-origin" />
                    <a href={signedUrl} target="_blank" rel="noopener noreferrer"
                      className="absolute top-1.5 right-1.5 bg-gray-900/80 text-gray-300 text-[10px] px-2 py-0.5 rounded hover:bg-gray-900 transition-colors">
                      Open ↗
                    </a>
                  </div>
                )}

                <div className="p-2.5 flex items-center gap-2.5">
                  {!isImage && <FileIcon type={isAudioCardVideo ? 'audio/mp4' : file.file_type} />}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-200 font-medium truncate">{file.file_name}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">
                      {new Date(file.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      {hiddenFromAdviewer && (
                        <span className="ml-1.5 text-gray-400" title="Only files named like EXU-M10-… are shown to the client. This one stays on the board.">· Source file, not shown in Adviewer</span>
                      )}
                    </p>
                  </div>

                  <select
                    value={file.approval_status}
                    onChange={(e) => handleApprovalChange(file.id, e.target.value)}
                    className={`text-[10px] font-medium px-1.5 py-0.5 rounded border bg-transparent cursor-pointer focus:outline-none ${approvalColor}`}
                  >
                    <option value="pending">pending</option>
                    <option value="approved">approved</option>
                    <option value="rejected">rejected</option>
                    <option value="changes_requested">changes requested</option>
                  </select>

                  {signedUrl && (
                    <a href={signedUrl} download={file.file_name} target="_blank" rel="noopener noreferrer"
                      className="text-gray-400 hover:text-gray-200 transition-colors" title="Download">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    </a>
                  )}

                  {confirmDelete === file.id ? (
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => handleDelete(file)} className="text-[10px] text-red-400 hover:text-red-300">Delete</button>
                      <button onClick={() => setConfirmDelete(null)} className="text-[10px] text-gray-500 hover:text-gray-300">Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmDelete(file.id)}
                      className="text-gray-600 hover:text-red-400 transition-colors" title="Delete">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
                {isAudio && signedUrl && !unplayable && (
                  <div className="px-2.5 pb-2.5">
                    <audio controls preload="none" src={signedUrl} className="w-full h-9" />
                  </div>
                )}
                {isAudio && unplayable && (
                  <p className="px-2.5 pb-2.5 text-[11px] text-amber-300">
                    Browsers can&apos;t play WMA — download it to listen.
                  </p>
                )}
              </li>
            )
          })}
        </ul>
        )}
        {slideImages.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
              Carousel Slides <span className="normal-case text-gray-600">— edited in the Creative tab</span>
            </p>
            <ul className="space-y-2">
              {slideImages.map((s, i) => (
                <li key={s.id} className="bg-gray-800/60 border border-gray-700/60 rounded-lg overflow-hidden">
                  <a href={s.image_url} target="_blank" rel="noopener noreferrer">
                    <img src={s.image_url} alt={s.headline ?? `Slide ${i + 1}`}
                      loading="lazy" decoding="async"
                      className="w-full max-h-48 object-cover border-b border-gray-700/60" />
                  </a>
                  <div className="p-2.5 flex items-center gap-2.5">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-200 font-medium truncate">Slide {i + 1}{s.headline ? ` — ${s.headline}` : ''}</p>
                    </div>
                    <a href={s.image_url} target="_blank" rel="noopener noreferrer"
                      className="text-gray-400 hover:text-gray-200 transition-colors" title="Open in new tab">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5m0 0v5m0-5L10 14M9 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-3" />
                      </svg>
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        </>
      )}
    </div>
  )
}
