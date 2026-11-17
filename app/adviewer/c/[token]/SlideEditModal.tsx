'use client'

import { useState } from 'react'
import type { CampaignCardData } from '@/types'

type Slide = NonNullable<NonNullable<CampaignCardData['card']>['carousel_slides']>[number]

// Staff-only carousel slide editor for the Adviewer preview (universal-controls gap
// #2). Reuses the file-edit modal's look and its edit-in-place contract, but targets
// carousel_slides via the generalized /api/adviewer/slide/[id] (copy) + /replace
// (graphic) routes. A carousel is one review unit, so saving resets the parent card's
// review to pending; a new graphic also snapshots + clears that slide's pins
// server-side. Carousel slides are image-only. On success the caller refreshes the
// server data so the edit shows live (card/campaign/token/history untouched).
export default function SlideEditModal({
  slide, onClose, onSaved,
}: {
  slide: Slide
  onClose: () => void
  onSaved: () => void
}) {
  const [copy, setCopy] = useState({
    headline: slide.headline ?? '',
    subheadline: slide.subheadline ?? '',
    display_link: slide.display_link ?? '',
    landing_page_url: slide.landing_page_url ?? '',
    graphic_headline: slide.graphic_headline ?? '',
    graphic_subhead: slide.graphic_subhead ?? '',
  })
  const [graphic, setGraphic] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const field = (k: keyof typeof copy) => (e: React.ChangeEvent<HTMLInputElement>) => setCopy(c => ({ ...c, [k]: e.target.value }))
  const inputCls = 'w-full rounded-md px-3 py-2 text-xs text-white bg-white/[0.04] border border-white/10 focus:border-white/30 outline-none'

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const patch = await fetch(`/api/adviewer/slide/${slide.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(copy),
      })
      if (!patch.ok) throw new Error((await patch.json().catch(() => ({})))?.error ?? 'Failed to save copy')

      if (graphic) {
        const fd = new FormData()
        fd.append('file', graphic)
        const rep = await fetch(`/api/adviewer/slide/${slide.id}/replace`, { method: 'POST', body: fd })
        if (!rep.ok) throw new Error((await rep.json().catch(() => ({})))?.error ?? 'Failed to replace graphic')
      }
      onSaved()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => { if (!saving) onClose() }}>
      <div className="w-full max-w-md rounded-xl p-5 max-h-[90vh] overflow-y-auto" style={{ background: '#14141b', border: '1px solid rgba(255,255,255,0.12)' }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1.5">
          <h3 className="text-sm font-semibold text-white">Edit slide {slide.position + 1}</h3>
          <button onClick={() => { if (!saving) onClose() }} className="text-white/40 hover:text-white text-xl leading-none" aria-label="Close">×</button>
        </div>
        <p className="text-[11px] text-white/40 mb-4">
          Update the copy and/or drop in a new graphic (images only). Saving resets this card&apos;s review to pending; a new graphic also snapshots + clears this slide&apos;s pins.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Graphic</label>
            <label
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) setGraphic(f) }}
              className={`flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-3 py-4 text-center cursor-pointer transition-colors ${dragOver ? 'border-teal-400 bg-teal-500/10' : 'border-white/15 hover:border-white/30 bg-white/[0.03]'}`}
            >
              <input type="file" accept="image/gif,image/png,image/jpeg,image/webp,.gif,.png,.jpg,.jpeg,.webp" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) setGraphic(f); e.target.value = '' }} />
              {graphic
                ? <span className="text-xs text-teal-300 font-medium break-all">New graphic: {graphic.name}</span>
                : <span className="text-xs text-white/50">Drop a new image here, or click to choose — replaces this slide&apos;s graphic on Save</span>}
              {graphic && <button onClick={e => { e.preventDefault(); setGraphic(null) }} className="text-[10px] text-white/40 hover:text-white underline">Keep the current graphic</button>}
            </label>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Headline</label>
            <input value={copy.headline} onChange={field('headline')} className={inputCls} />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Sub headline</label>
            <input value={copy.subheadline} onChange={field('subheadline')} className={inputCls} />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Display link <span className="text-white/25 normal-case">(optional)</span></label>
            <input value={copy.display_link} onChange={field('display_link')} className={inputCls} placeholder="e.g. example-moto.com" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Landing page URL</label>
            <input value={copy.landing_page_url} onChange={field('landing_page_url')} className={inputCls} placeholder="https://…" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Graphic heading</label>
              <input value={copy.graphic_headline} onChange={field('graphic_headline')} className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-white/40 mb-1">Graphic subheading</label>
              <input value={copy.graphic_subhead} onChange={field('graphic_subhead')} className={inputCls} />
            </div>
          </div>

          {error && <p className="text-[11px] text-rose-400">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button onClick={save} disabled={saving} className="flex-1 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { if (!saving) onClose() }} className="px-4 py-2 rounded-lg text-xs font-medium text-white/50 hover:text-white/80 bg-white/[0.05]">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}
