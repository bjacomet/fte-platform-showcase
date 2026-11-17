'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InstantExperience, IEBlock, IEBlockType, IECarouselBlock } from '@/types'
import {
  IE_TEXT_MAX, IE_BUTTON_LABEL_MAX, IE_CAROUSEL_MIN, IE_CAROUSEL_MAX, IE_BLOCK_MAX, IE_BLOCK_LABELS, IE_BLOCK_HINTS,
} from '@/types'
import { drawerInputClass, drawerLabelClass } from '@/lib/formStyles'
import InstantExperienceMockup from '@/components/InstantExperienceMockup'

// The Instant Experience builder — a structured JSON editor for the inner canvas,
// modeled on MessengerWelcomeEditor. Controlled component: initializes from `value`
// and calls `onChange` on every edit. No Facebook API — the approved mockup + these
// fields are the build sheet the team recreates in Ads Manager by hand.

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50 MB app cap — see docs/features/adviewer.md "Why 50 MB"
const mb = (b: number) => (b / (1024 * 1024)).toFixed(0)

const IMAGE_EXTS = ['gif', 'png', 'jpg', 'jpeg', 'webp']
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'm4v']

function newId() { return crypto.randomUUID() }

function emptyBlock(type: IEBlockType): IEBlock {
  switch (type) {
    case 'header': return { id: newId(), type: 'header', media_kind: 'image', media_url: null, file_name: null }
    case 'text': return { id: newId(), type: 'text', text: '' }
    case 'image': return { id: newId(), type: 'image', media_url: null, file_name: null, link_url: null }
    case 'image_carousel': return { id: newId(), type: 'image_carousel', images: [{ id: newId(), url: null }, { id: newId(), url: null }] }
    case 'video': return { id: newId(), type: 'video', media_url: null, file_name: null }
    case 'button': return { id: newId(), type: 'button', label: '', url: null }
  }
}

// One-click starter scaffolds. Each factory mints fresh ids so blocks are unique,
// and seeds structure + placeholder copy (media left empty) so the team starts from a
// shape rather than a blank canvas. The chosen name is stored on InstantExperience.template.
// Product-set / storefront templates are skipped in v1 (no catalog block yet).
const IE_TEMPLATES: Record<string, () => IEBlock[]> = {
  Lookbook: () => [
    { id: newId(), type: 'header', media_kind: 'image', media_url: null, file_name: null },
    { id: newId(), type: 'image_carousel', images: [{ id: newId(), url: null }, { id: newId(), url: null }, { id: newId(), url: null }] },
    { id: newId(), type: 'text', text: 'One line about the collection.' },
    { id: newId(), type: 'button', label: 'Shop Now', url: null },
  ],
  'Customer Acquisition': () => [
    { id: newId(), type: 'header', media_kind: 'video', media_url: null, file_name: null },
    { id: newId(), type: 'text', text: 'Your value proposition — one or two lines.' },
    { id: newId(), type: 'text', text: 'Why choose you — a few key points.' },
    { id: newId(), type: 'button', label: 'Sign Up', url: null },
  ],
  Storytelling: () => [
    { id: newId(), type: 'header', media_kind: 'video', media_url: null, file_name: null },
    { id: newId(), type: 'text', text: 'Tell your story in a line or two.' },
    { id: newId(), type: 'button', label: 'Learn More', url: null },
  ],
  Custom: () => [],
}

const IE_TEMPLATE_META: { name: string; blurb: string }[] = [
  { name: 'Lookbook', blurb: 'Image-forward — showcase a collection.' },
  { name: 'Customer Acquisition', blurb: 'Direct response — sign-ups / leads.' },
  { name: 'Storytelling', blurb: 'Brand awareness — emotional / recall.' },
  { name: 'Custom', blurb: 'Blank — full control.' },
]

const isHttps = (u: string | null | undefined) => !!u && /^https?:\/\//i.test(u)
const isVideoish = (url: string) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)

function validate(blocks: IEBlock[]): { errs: string[]; warns: string[] } {
  const errs: string[] = []
  const warns: string[] = []
  if (blocks.length > IE_BLOCK_MAX) errs.push(`More than ${IE_BLOCK_MAX} blocks (Meta's max).`)
  if (!blocks.some((b) => b.type === 'header')) warns.push('No header block — the header is the first thing seen.')
  if (!blocks.some((b) => b.type === 'button' && b.url?.trim())) warns.push('No button with a destination — add a CTA button so the experience links somewhere.')

  blocks.forEach((b, i) => {
    const at = `Block ${i + 1} (${IE_BLOCK_LABELS[b.type]})`
    if (b.type === 'header' && !b.media_url) errs.push(`${at}: needs a header image or video.`)
    if (b.type === 'text') {
      if (!b.text.trim()) errs.push(`${at}: text is empty.`)
      if (b.text.length > IE_TEXT_MAX) errs.push(`${at}: over ${IE_TEXT_MAX} chars.`)
    }
    if (b.type === 'image' && !b.media_url) errs.push(`${at}: needs an image.`)
    if (b.type === 'image' && b.link_url && !isHttps(b.link_url)) warns.push(`${at}: link should start with https://`)
    if (b.type === 'video' && !b.media_url) errs.push(`${at}: needs a video.`)
    if (b.type === 'image_carousel') {
      const filled = b.images.filter((im) => im.url).length
      if (filled < IE_CAROUSEL_MIN) errs.push(`${at}: needs at least ${IE_CAROUSEL_MIN} images.`)
      if (b.images.length > IE_CAROUSEL_MAX) errs.push(`${at}: more than ${IE_CAROUSEL_MAX} images.`)
    }
    if (b.type === 'button') {
      if (!b.label.trim()) errs.push(`${at}: button label is empty.`)
      if (b.label.length > IE_BUTTON_LABEL_MAX) errs.push(`${at}: label over ${IE_BUTTON_LABEL_MAX} chars.`)
      if (!b.url?.trim()) errs.push(`${at}: button destination URL is required.`)
      else if (!isHttps(b.url)) warns.push(`${at}: destination should start with https://`)
    }
  })
  return { errs, warns }
}

type MediaKind = 'image' | 'video' | 'any'

// Module-scope so it is a STABLE component type — defining it inside the editor
// would remount it (and every sibling text input) on each keystroke, dropping focus.
// `progress` is null when idle, 0–100 while the file bytes upload, and stays at 100
// during the signed-URL step (shown as "Finishing…").
function MediaDrop({
  slotId, url, kind, progress, onPick, onClear,
}: {
  slotId: string
  url: string | null
  kind: MediaKind
  progress: number | null
  onPick: (file: File) => void
  onClear: () => void
}) {
  const [drag, setDrag] = useState(false)
  const busy = progress != null
  const accept = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'image/*,video/*'
  const inputId = `ie-media-${slotId}`
  return (
    <div
      className={`relative w-full aspect-video rounded border overflow-hidden flex items-center justify-center text-[11px] transition-colors ${drag ? 'bg-blue-950/30 border-blue-500' : 'bg-gray-900 border-gray-700'}`}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy && e.dataTransfer.types.includes('Files')) setDrag(true) }}
      onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrag(false) }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDrag(false); if (busy) return; const f = e.dataTransfer.files[0]; if (f) onPick(f) }}
    >
      {url ? (
        <>
          {kind === 'video' || isVideoish(url)
            ? <video src={url} muted className="w-full h-full object-cover" />
            /* eslint-disable-next-line @next/next/no-img-element */
            : <img src={url} alt="" className="w-full h-full object-cover" />}
          <button
            onClick={(e) => { e.stopPropagation(); onClear() }}
            className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center text-white hover:bg-red-600 transition-colors"
            title="Remove"
          >×</button>
        </>
      ) : busy ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-4">
          <span className="text-blue-400 font-medium">{(progress ?? 0) >= 100 ? 'Finishing…' : `Uploading ${progress}%`}</span>
          <div className="w-4/5 h-1.5 rounded-full bg-gray-700 overflow-hidden">
            <div className="h-full bg-blue-500 transition-[width] duration-150 ease-out" style={{ width: `${Math.min(100, progress ?? 0)}%` }} />
          </div>
        </div>
      ) : (
        <label htmlFor={inputId} className="w-full h-full flex items-center justify-center cursor-pointer text-gray-500 hover:text-gray-300">
          {drag ? <span className="text-blue-400">Drop to upload</span> : <span>+ Add / drag {kind === 'video' ? 'video' : kind === 'image' ? 'image' : 'media'}</span>}
        </label>
      )}
      <input id={inputId} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = '' }} />
    </div>
  )
}

interface Props {
  value: InstantExperience | null
  onChange: (v: InstantExperience | null) => void
  /** Direct-to-storage uploader (bypasses the 4.5MB Vercel body cap). Returns the file URL or null. */
  onUploadMedia: (file: File, onProgress?: (loaded: number, total: number) => void) => Promise<string | null>
  /** Outer trigger-ad context for the live preview. */
  pageName?: string
  pageLogoUrl?: string | null
  coverBodyText?: string | null
}

export default function InstantExperienceEditor({ value, onChange, onUploadMedia, pageName, pageLogoUrl, coverBodyText }: Props) {
  const blocks = useMemo(() => value?.blocks ?? [], [value])
  // Per-slot upload progress: slotId → 0–100 (bytes), held at 100 during the signed-URL
  // step. Absent = idle. Replaces the old single `uploadingId` so two slots can upload
  // at once and each shows its own bar.
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [uploadError, setUploadError] = useState<string | null>(null)
  const { errs, warns } = useMemo(() => validate(blocks), [blocks])

  const lbl = drawerLabelClass
  const inp = drawerInputClass

  // Always-latest snapshot of blocks. Every mutation reads from and writes to these
  // refs, because handlers can resolve LATER than the render that created them — a slow
  // media upload, or a second upload landing first. A render-time `blocks` snapshot
  // would then commit the pre-edit list and silently revert whatever changed while the
  // file was in flight (typed copy, another block's media, an added/removed slot).
  const blocksRef = useRef(blocks)
  const templateRef = useRef(value?.template)
  // Effects resync from props (e.g. the drawer loads a different card); `commit` also
  // writes the refs synchronously, so back-to-back mutations never race the effect.
  useEffect(() => { blocksRef.current = blocks }, [blocks])
  useEffect(() => { templateRef.current = value?.template }, [value?.template])

  // The single commit path — updates the refs, then hands the new list up.
  const commit = useCallback((next: IEBlock[], template?: string) => {
    blocksRef.current = next
    if (template !== undefined) templateRef.current = template
    onChange(next.length ? { blocks: next, template: templateRef.current } : null)
  }, [onChange])

  // Functional updater for one image_carousel block's images, keyed by block id and
  // applied to the LATEST images array (never a captured snapshot). Used by every
  // carousel slot mutation (add / set / clear / remove) so filled slots are never
  // shifted, dropped, or reordered by a late-arriving upload.
  const updateCarouselImages = useCallback((
    blockId: string,
    updater: (imgs: IECarouselBlock['images']) => IECarouselBlock['images'],
  ) => {
    commit(blocksRef.current.map((b) =>
      b.id === blockId && b.type === 'image_carousel' ? { ...b, images: updater(b.images) } : b,
    ))
  }, [commit])

  const addBlock = (type: IEBlockType) => {
    if (blocksRef.current.length >= IE_BLOCK_MAX) return
    commit([...blocksRef.current, emptyBlock(type)])
  }
  const applyTemplate = (name: string) => {
    const count = blocksRef.current.length
    if (count > 0 && !window.confirm(`Replace the current ${count} block${count === 1 ? '' : 's'} with the "${name}" template?`)) return
    commit(IE_TEMPLATES[name]?.() ?? [], name)
  }
  const removeBlock = (id: string) => commit(blocksRef.current.filter((b) => b.id !== id))
  const moveBlock = (id: string, dir: -1 | 1) => {
    const cur = blocksRef.current
    const i = cur.findIndex((b) => b.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= cur.length) return
    const next = cur.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    commit(next)
  }
  // Patch one block by id — same latest-snapshot rule: the media patches below land
  // from async uploads, so this must never rebuild from a render-time `blocks`.
  const patchBlock = (id: string, patch: Partial<IEBlock>) => {
    commit(blocksRef.current.map((b) => (b.id === id ? ({ ...b, ...patch } as IEBlock) : b)))
  }

  // Size- and type-gated upload. Tracks per-slot progress while in flight; returns the
  // URL or null. The finally clause always clears the slot's progress, so a failed or
  // rejected upload can never leave the slot stuck on "Uploading…".
  const upload = useCallback(async (slotId: string, file: File, kind: MediaKind): Promise<string | null> => {
    setUploadError(null)
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const okImage = file.type.startsWith('image/') || IMAGE_EXTS.includes(ext)
    const okVideo = file.type.startsWith('video/') || VIDEO_EXTS.includes(ext)
    if (kind === 'image' && !okImage) { setUploadError('Please choose an image file.'); return null }
    if (kind === 'video' && !okVideo) { setUploadError('Please choose a video file.'); return null }
    if (kind === 'any' && !okImage && !okVideo) { setUploadError('Please choose an image or video file.'); return null }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(`${file.name} is ${mb(file.size)} MB — over the ${mb(MAX_UPLOAD_BYTES)} MB limit. Compress it (keep IE video ≤60s at 1080p) or trim before uploading.`)
      return null
    }
    setProgress((p) => ({ ...p, [slotId]: 0 }))
    try {
      const url = await onUploadMedia(file, (loaded, total) => {
        const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0
        setProgress((p) => ({ ...p, [slotId]: pct }))
      })
      if (!url) setUploadError(`Upload failed for ${file.name}.`)
      return url
    } catch {
      setUploadError(`Upload failed for ${file.name}.`)
      return null
    } finally {
      setProgress((p) => { const n = { ...p }; delete n[slotId]; return n })
    }
  }, [onUploadMedia])

  // Blocks are rendered by a plain function (NOT a nested component) so text inputs
  // keep focus across edits. MediaDrop is the only piece with local state and is a
  // stable module-scope component.
  const renderCarousel = (block: IECarouselBlock) => (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {block.images.map((im, k) => (
          <div key={im.id} className="space-y-1">
            <MediaDrop
              slotId={im.id} url={im.url} kind="image" progress={progress[im.id] ?? null}
              onPick={(f) => { void upload(im.id, f, 'image').then((u) => { if (u) updateCarouselImages(block.id, (imgs) => imgs.map((x) => x.id === im.id ? { ...x, url: u, file_name: f.name } : x)) }) }}
              onClear={() => updateCarouselImages(block.id, (imgs) => imgs.map((x) => x.id === im.id ? { ...x, url: null, file_name: null } : x))}
            />
            <button onClick={() => updateCarouselImages(block.id, (imgs) => imgs.filter((x) => x.id !== im.id))} disabled={block.images.length <= IE_CAROUSEL_MIN} className="w-full text-[10px] text-gray-500 hover:text-red-400 disabled:opacity-30">Remove #{k + 1}</button>
          </div>
        ))}
      </div>
      {/* Append the new empty slot to the END — never splice into the middle. */}
      <button onClick={() => updateCarouselImages(block.id, (imgs) => [...imgs, { id: newId(), url: null }])} disabled={block.images.length >= IE_CAROUSEL_MAX}
        className="w-full py-1.5 border border-dashed border-gray-600 rounded text-[11px] text-gray-400 hover:text-gray-200 hover:border-gray-400 disabled:opacity-40 transition-colors">
        + Add carousel image ({block.images.length}/{IE_CAROUSEL_MAX})
      </button>
    </div>
  )

  const renderBlock = (block: IEBlock, i: number) => (
    <div key={block.id} className="bg-gray-800/60 border border-gray-700/60 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Block {i + 1} · {IE_BLOCK_LABELS[block.type]}</span>
        <div className="flex items-center gap-2">
          <button onClick={() => moveBlock(block.id, -1)} disabled={i === 0} className="text-gray-500 hover:text-gray-200 disabled:opacity-30 text-xs" title="Move up">↑</button>
          <button onClick={() => moveBlock(block.id, 1)} disabled={i === blocks.length - 1} className="text-gray-500 hover:text-gray-200 disabled:opacity-30 text-xs" title="Move down">↓</button>
          <button onClick={() => removeBlock(block.id)} className="text-gray-600 hover:text-red-400 text-[10px] transition-colors">Remove</button>
        </div>
      </div>

      {block.type === 'header' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            {(['image', 'video'] as const).map((k) => (
              <button key={k} onClick={() => patchBlock(block.id, { media_kind: k, media_url: null, file_name: null })}
                className={`px-2.5 py-1 rounded text-[11px] font-medium border transition-colors ${block.media_kind === k ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}>
                {k === 'image' ? 'Image' : 'Video'}
              </button>
            ))}
          </div>
          <MediaDrop
            slotId={block.id} url={block.media_url} kind={block.media_kind} progress={progress[block.id] ?? null}
            onPick={(f) => { void upload(block.id, f, block.media_kind).then((u) => { if (u) patchBlock(block.id, { media_url: u, file_name: f.name }) }) }}
            onClear={() => patchBlock(block.id, { media_url: null, file_name: null })}
          />
        </div>
      )}

      {block.type === 'text' && (
        <div className="space-y-0.5">
          <label className={`${lbl} flex justify-between`}>
            <span>Copy</span>
            <span className={block.text.length > IE_TEXT_MAX ? 'text-red-400' : 'text-gray-600'}>{block.text.length}/{IE_TEXT_MAX}</span>
          </label>
          <textarea value={block.text} onChange={(e) => patchBlock(block.id, { text: e.target.value })} rows={3} className={`${inp} resize-none`} placeholder="Copy section…" />
        </div>
      )}

      {block.type === 'image' && (
        <div className="space-y-2">
          <MediaDrop
            slotId={block.id} url={block.media_url} kind="image" progress={progress[block.id] ?? null}
            onPick={(f) => { void upload(block.id, f, 'image').then((u) => { if (u) patchBlock(block.id, { media_url: u, file_name: f.name }) }) }}
            onClear={() => patchBlock(block.id, { media_url: null, file_name: null })}
          />
          <div className="space-y-0.5">
            <label className={lbl}>Tap-to-link URL <span className="text-gray-600 normal-case">(optional)</span></label>
            <input value={block.link_url ?? ''} onChange={(e) => patchBlock(block.id, { link_url: e.target.value || null })} className={inp} placeholder="https://…" />
          </div>
        </div>
      )}

      {block.type === 'video' && (
        <MediaDrop
          slotId={block.id} url={block.media_url} kind="video" progress={progress[block.id] ?? null}
          onPick={(f) => { void upload(block.id, f, 'video').then((u) => { if (u) patchBlock(block.id, { media_url: u, file_name: f.name }) }) }}
          onClear={() => patchBlock(block.id, { media_url: null, file_name: null })}
        />
      )}

      {block.type === 'image_carousel' && renderCarousel(block)}

      {block.type === 'button' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-0.5">
            <label className={`${lbl} flex justify-between`}>
              <span>Label</span>
              <span className={block.label.length > IE_BUTTON_LABEL_MAX ? 'text-red-400' : 'text-gray-600'}>{block.label.length}/{IE_BUTTON_LABEL_MAX}</span>
            </label>
            <input value={block.label} onChange={(e) => patchBlock(block.id, { label: e.target.value })} className={inp} placeholder="Shop Now" />
          </div>
          <div className="space-y-0.5">
            <label className={lbl}>Destination URL</label>
            <input value={block.url ?? ''} onChange={(e) => patchBlock(block.id, { url: e.target.value || null })} className={inp} placeholder="https://…" />
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className="grid lg:grid-cols-[1fr_340px] gap-4">
      {/* Editor column */}
      <div className="space-y-3">
        <div className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Instant Experience — inner blocks</div>
        <p className="text-[11px] text-gray-500 -mt-1">
          The outer feed ad uses this card&apos;s Facebook copy + cover image. Build the full-screen experience below.
          Keep videos ≤60s at 1080p so they fit the 50&nbsp;MB upload cap.
        </p>

        {/* Start from a template — seeds a block structure so the team isn't staring at a
            blank canvas. Confirms before overwriting an existing build. */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
            {blocks.length === 0 ? 'Start from a template' : 'Replace with a template'}
          </div>
          <div className="grid sm:grid-cols-2 gap-1.5">
            {IE_TEMPLATE_META.map((t) => (
              <button key={t.name} onClick={() => applyTemplate(t.name)}
                className={`text-left px-2.5 py-1.5 rounded border transition-colors ${value?.template === t.name ? 'border-blue-500 bg-blue-950/30' : 'border-gray-700 hover:border-gray-500 hover:bg-gray-800/40'}`}>
                <div className="text-[11px] font-semibold text-gray-200">{t.name}</div>
                <div className="text-[10px] text-gray-500 leading-snug mt-0.5">{t.blurb}</div>
              </button>
            ))}
          </div>
        </div>

        {blocks.map((block, i) => renderBlock(block, i))}

        {/* Add-block palette — each option carries a one-line hint so the team knows
            what it's for (esp. single Image vs. swipeable Image carousel). */}
        <div className="space-y-1.5">
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Add a block</div>
          <div className="grid sm:grid-cols-2 gap-1.5">
            {(Object.keys(IE_BLOCK_LABELS) as IEBlockType[]).map((t) => (
              <button key={t} onClick={() => addBlock(t)} disabled={blocks.length >= IE_BLOCK_MAX}
                className="text-left px-2.5 py-1.5 rounded border border-dashed border-gray-600 hover:border-gray-400 hover:bg-gray-800/40 disabled:opacity-40 transition-colors">
                <div className="text-[11px] font-semibold text-gray-200">+ {IE_BLOCK_LABELS[t]}</div>
                <div className="text-[10px] text-gray-500 leading-snug mt-0.5">{IE_BLOCK_HINTS[t]}</div>
              </button>
            ))}
          </div>
        </div>
        {blocks.length >= IE_BLOCK_MAX && <p className="text-[10px] text-amber-400">Reached Meta&apos;s {IE_BLOCK_MAX}-block limit.</p>}

        {uploadError && <p className="text-[11px] text-red-400">{uploadError}</p>}

        {/* Validation summary */}
        {(errs.length > 0 || warns.length > 0) && (
          <div className={`rounded-lg border p-2.5 text-[11px] space-y-1 ${errs.length ? 'border-red-800/60 bg-red-950/30' : 'border-amber-800/60 bg-amber-950/20'}`}>
            <div className={`font-semibold ${errs.length ? 'text-red-300' : 'text-amber-300'}`}>{errs.length ? 'Needs attention' : 'Looks good — a couple of suggestions'}</div>
            {errs.map((e, i) => <div key={`e${i}`} className="text-red-300/90">• {e}</div>)}
            {warns.map((w, i) => <div key={`w${i}`} className="text-amber-300/80">• {w}</div>)}
          </div>
        )}
      </div>

      {/* Live preview column */}
      <div className="lg:sticky lg:top-2 self-start">
        <div className="text-[10px] font-bold text-gray-300 uppercase tracking-widest mb-2">Preview</div>
        <InstantExperienceMockup
          blocks={blocks}
          cover={{ pageName, logoUrl: pageLogoUrl, bodyText: coverBodyText }}
        />
      </div>
    </div>
  )
}
