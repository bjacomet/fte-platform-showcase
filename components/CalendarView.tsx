'use client'

import { useMemo, useRef, useState, type DragEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Card, CarouselSlide, Client, Column } from '@/types'
import { createClient } from '@/lib/supabase/client'
import {
  formatMonth,
  formatPostDate,
  nextMonth,
  prevMonth,
} from '@/lib/calendar'
import FacebookAdPreview from './FacebookAdPreview'
import FacebookCarouselPreview from './FacebookCarouselPreview'
import ExternalRef from './ExternalRef'
import CardDrawer from './CardDrawer'
import ViewToggle from './calendar/ViewToggle'
import { useCalendarView } from './calendar/useCalendarView'
import CalendarGridView from './calendar/CalendarGridView'
import CalendarListView from './calendar/CalendarListView'

interface Props {
  clients: Client[]
  selectedClientId: string | null
  year: number
  month: number
  cards: Card[]
  slidesByCardId: Record<string, CarouselSlide[]>
  imageUrlByCardId: Record<string, string | null>
  boxLinkUrl: string | null
  columns: Column[]
  doneColumnId: string | null
  userEmail: string
}

export default function CalendarView({
  clients,
  selectedClientId,
  year,
  month,
  cards,
  slidesByCardId,
  imageUrlByCardId,
  boxLinkUrl,
  columns,
  doneColumnId,
  userEmail,
}: Props) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [view, setView] = useCalendarView()

  const [openCard, setOpenCard] = useState<Card | null>(null)
  const [boxLink, setBoxLink] = useState(boxLinkUrl ?? '')
  const [boxSaving, setBoxSaving] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [clientPickerOpen, setClientPickerOpen] = useState(false)

  // Drag-to-post image upload state (non-carousel posts in Feed view)
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null)
  const [uploadingCardId, setUploadingCardId] = useState<string | null>(null)
  const [uploadErrorCardId, setUploadErrorCardId] = useState<string | null>(null)
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const activeClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId) ?? null,
    [clients, selectedClientId]
  )
  const shareToken = activeClient?.calendar_share_token ?? null

  const clientsById = useMemo(() => {
    const out: Record<string, Client> = {}
    for (const c of clients) out[c.id] = c
    return out
  }, [clients])

  function buildHref(overrides: { client?: string; year?: number; month?: number }) {
    const q = new URLSearchParams()
    const c = overrides.client ?? selectedClientId ?? ''
    const y = overrides.year ?? year
    const m = overrides.month ?? month
    if (c) q.set('client', c)
    q.set('year', String(y))
    q.set('month', String(m))
    return `/calendar?${q.toString()}`
  }

  function navigate(overrides: { client?: string; year?: number; month?: number }) {
    router.push(buildHref(overrides))
  }

  const prev = prevMonth(year, month)
  const next = nextMonth(year, month)

  async function saveBoxLink() {
    if (!selectedClientId) return
    const trimmed = boxLink.trim()
    setBoxSaving(true)
    if (trimmed) {
      await supabase
        .from('client_calendar_months')
        .upsert(
          {
            client_id: selectedClientId,
            year,
            month,
            box_link_url: trimmed,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'client_id,year,month' }
        )
    } else {
      await supabase
        .from('client_calendar_months')
        .delete()
        .match({ client_id: selectedClientId, year, month })
    }
    setBoxSaving(false)
  }

  async function copyShareLink() {
    if (!shareToken) return
    const url = `${window.location.origin}/calendar/${shareToken}`
    try {
      await navigator.clipboard.writeText(url)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 1800)
    } catch {
      // Clipboard failures are rare but non-fatal — leave the UI quiet
    }
  }

  function handleCardUpdated() {
    // Card may have moved months / types / clients — just refresh the feed.
    router.refresh()
  }

  async function uploadImageForCard(cardId: string, file: File) {
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now()
    // Basic guardrails. The UI already filters by MIME on the drop handler.
    if (!file.type.startsWith('image/')) {
      setUploadErrorCardId(cardId)
      setTimeout(() => setUploadErrorCardId((v) => (v === cardId ? null : v)), 2400)
      return
    }
    setUploadingCardId(cardId)
    setUploadErrorCardId(null)
    try {
      const extFromName = file.name.split('.').pop()?.toLowerCase()
      const extFromType = file.type.split('/')[1]?.toLowerCase()
      const ext = (extFromName || extFromType || 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg'
      const path = `calendar/${cardId}/preview.${ext}`

      const { error: uploadErr } = await supabase.storage
        .from('creative-files')
        .upload(path, file, { upsert: true, contentType: file.type })
      if (uploadErr) throw uploadErr

      const { data: urlData } = supabase.storage.from('creative-files').getPublicUrl(path)
      const publicUrl = urlData?.publicUrl
      if (!publicUrl) throw new Error('Could not resolve public URL after upload')

      // Cache-bust so the FB mockup re-fetches the new image immediately.
      const bustedUrl = `${publicUrl}?v=${now}`

      const { error: updateErr } = await supabase
        .from('cards')
        .update({ preview_image_url: bustedUrl, updated_at: new Date().toISOString() })
        .eq('id', cardId)
      if (updateErr) throw updateErr

      router.refresh()
    } catch (err) {
      console.error('[calendar] preview image upload failed', err)
      setUploadErrorCardId(cardId)
      setTimeout(() => setUploadErrorCardId((v) => (v === cardId ? null : v)), 2400)
    } finally {
      setUploadingCardId((v) => (v === cardId ? null : v))
      setDragOverCardId((v) => (v === cardId ? null : v))
    }
  }

  function onCardDragOver(e: DragEvent<HTMLDivElement>, cardId: string) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (dragOverCardId !== cardId) setDragOverCardId(cardId)
  }

  function onCardDragLeave(e: DragEvent<HTMLDivElement>, cardId: string) {
    const related = e.relatedTarget as Node | null
    if (related && e.currentTarget.contains(related)) return
    setDragOverCardId((v) => (v === cardId ? null : v))
  }

  function onCardDrop(e: DragEvent<HTMLDivElement>, cardId: string) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file) {
      setDragOverCardId((v) => (v === cardId ? null : v))
      return
    }
    void uploadImageForCard(cardId, file)
  }

  function handleCardDeleted() {
    setOpenCard(null)
    router.refresh()
  }

  // Empty state shared across all three views.
  const emptyState = (
    <div className="max-w-[500px] mx-auto text-center text-gray-500 mt-16 px-4">
      <p className="text-sm">
        No posts scheduled for {activeClient?.name ?? 'this client'} in {formatMonth(year, month)}.
      </p>
      <p className="text-xs mt-2 text-gray-600">
        Create a card on the board with a flight start date in this month and a post-style media type
        (Social Ad Request, Carousel Ad, Organic Post, Reel Request, or Eblast).
      </p>
    </div>
  )

  // Client switcher: render the current selection as a pill chip with initials.
  // Click toggles the picker — keeps the header tidy when there are many clients.
  const initials = activeClient
    ? activeClient.name
        .split(' ')
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('')
    : '?'

  return (
    <div className="min-h-screen flex flex-col bg-[#0f1117] text-gray-100">

      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-900 border-b border-gray-700/60 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-base font-semibold text-white tracking-tight">Content Calendar</h1>

          {/* Client chip + dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setClientPickerOpen((o) => !o)}
              className="inline-flex items-center gap-2 pl-1 pr-2.5 py-1 bg-gray-800 border border-gray-600 rounded-full text-xs text-gray-200 hover:bg-gray-700 transition-colors"
            >
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-[9px] font-semibold text-white">
                {initials}
              </span>
              <span>{activeClient?.name ?? 'Select client'}</span>
              <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {clientPickerOpen && (
              <div className="absolute z-20 mt-1 w-56 bg-gray-800 border border-gray-700 rounded-lg shadow-2xl max-h-72 overflow-y-auto">
                {clients.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-gray-500">No clients</div>
                ) : (
                  clients.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setClientPickerOpen(false)
                        navigate({ client: c.id })
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-700 transition-colors ${
                        c.id === selectedClientId ? 'text-blue-300' : 'text-gray-200'
                      }`}
                    >
                      {c.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Month nav */}
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-600 rounded-lg px-1 py-0.5">
            <button
              onClick={() => navigate({ year: prev.year, month: prev.month })}
              className="px-2 py-1 text-gray-300 hover:text-white hover:bg-gray-700 rounded"
              aria-label="Previous month"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-sm text-gray-200 font-medium min-w-[8.5rem] text-center">
              {formatMonth(year, month)}
            </span>
            <button
              onClick={() => navigate({ year: next.year, month: next.month })}
              className="px-2 py-1 text-gray-300 hover:text-white hover:bg-gray-700 rounded"
              aria-label="Next month"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          <ViewToggle value={view} onChange={setView} />
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={
              selectedClientId
                ? `/calendar/import?client=${selectedClientId}&year=${year}&month=${month}`
                : '/calendar/import'
            }
            aria-disabled={!activeClient}
            className={
              activeClient
                ? 'text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-100 font-medium transition-colors inline-flex items-center gap-1.5'
                : 'text-xs px-3 py-1.5 rounded-lg bg-gray-800 text-gray-500 cursor-not-allowed inline-flex items-center gap-1.5 pointer-events-none'
            }
            title="Bulk import posts"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5-5 5 5M12 5v12" />
            </svg>
            Bulk import
          </Link>
          <button
            onClick={copyShareLink}
            disabled={!shareToken}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-medium transition-colors inline-flex items-center gap-1.5"
            title="Copy client share link"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 10-5.656-5.656l-1.1 1.1" />
            </svg>
            {shareCopied ? 'Copied!' : 'Copy share link'}
          </button>
          <a
            href="/board"
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            ← Board
          </a>
        </div>
      </div>

      {/* Monthly Box link row */}
      {selectedClientId && (
        <div className="px-4 py-2.5 bg-gray-900/60 border-b border-gray-800 flex items-center gap-3 flex-wrap">
          <label className="text-xs text-gray-400 font-medium">Monthly Box Link:</label>
          <input
            type="url"
            value={boxLink}
            onChange={(e) => setBoxLink(e.target.value)}
            onBlur={saveBoxLink}
            placeholder="External Box folder link"
            className="flex-1 min-w-[260px] max-w-[640px] bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {boxLink && (
            <ExternalRef url={boxLink} note="this month's creative" />
          )}
          {boxSaving && <span className="text-xs text-gray-500">Saving…</span>}
        </div>
      )}

      {/* Body — switch by view */}
      <div className="flex-1 overflow-y-auto">
        {cards.length === 0 ? (
          <div className="py-8">{emptyState}</div>
        ) : view === 'grid' ? (
          <CalendarGridView
            cards={cards}
            year={year}
            month={month}
            imageUrlByCardId={imageUrlByCardId}
            onCardClick={(c) => setOpenCard(c)}
          />
        ) : view === 'list' ? (
          <CalendarListView
            cards={cards}
            imageUrlByCardId={imageUrlByCardId}
            clientsById={clientsById}
            onCardClick={(c) => setOpenCard(c)}
          />
        ) : (
          /* Feed view — vertical FB mockups with drag-to-post. */
          <div className="py-8 px-4">
            <div className="flex flex-col gap-8">
              {cards.map((card) => {
                const isCarousel = card.media_type === 'Carousel Ad'
                const slides = slidesByCardId[card.id] ?? []
                const imageUrl = imageUrlByCardId[card.id] ?? null
                const isDragOver = dragOverCardId === card.id
                const isUploading = uploadingCardId === card.id
                const hadError = uploadErrorCardId === card.id
                const hasImage = Boolean(imageUrl)
                return (
                  <div key={card.id} className="flex flex-col items-center">
                    <div className="w-full max-w-[500px] mb-2 flex items-baseline justify-between gap-3">
                      <p className="text-xs text-gray-400 font-medium">
                        {formatPostDate(card.flight_start_date)}
                      </p>
                      <div className="flex items-center gap-3">
                        {!isCarousel && (
                          <>
                            <input
                              ref={(el) => {
                                fileInputRefs.current[card.id] = el
                              }}
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0]
                                if (file) void uploadImageForCard(card.id, file)
                                e.target.value = ''
                              }}
                            />
                            <button
                              onClick={() => fileInputRefs.current[card.id]?.click()}
                              disabled={isUploading}
                              className="text-[11px] text-gray-500 hover:text-gray-300 underline underline-offset-2 disabled:opacity-50"
                            >
                              {isUploading ? 'Uploading…' : hasImage ? 'Replace image' : 'Add image'}
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => setOpenCard(card)}
                          className="text-[11px] text-gray-500 hover:text-gray-300 underline underline-offset-2"
                        >
                          Open card
                        </button>
                      </div>
                    </div>
                    {isCarousel ? (
                      <FacebookCarouselPreview card={card} client={activeClient} slides={slides} />
                    ) : (
                      <div
                        onDragOver={(e) => onCardDragOver(e, card.id)}
                        onDragEnter={(e) => onCardDragOver(e, card.id)}
                        onDragLeave={(e) => onCardDragLeave(e, card.id)}
                        onDrop={(e) => onCardDrop(e, card.id)}
                        className={`relative rounded-lg transition-all ${
                          isDragOver
                            ? 'ring-2 ring-blue-500/80 ring-offset-2 ring-offset-[#0f1117]'
                            : ''
                        }`}
                      >
                        <FacebookAdPreview card={card} client={activeClient} previewImageUrl={imageUrl} />
                        {isDragOver && (
                          <div className="pointer-events-none absolute inset-0 rounded-lg bg-blue-500/10 flex items-center justify-center">
                            <span className="text-xs font-medium text-blue-200 bg-blue-900/70 px-2.5 py-1 rounded">
                              Drop to attach image
                            </span>
                          </div>
                        )}
                        {isUploading && (
                          <div className="pointer-events-none absolute inset-0 rounded-lg bg-black/40 flex items-center justify-center">
                            <span className="text-xs font-medium text-white bg-gray-900/80 px-2.5 py-1 rounded">
                              Uploading…
                            </span>
                          </div>
                        )}
                        {hadError && (
                          <div className="pointer-events-none absolute top-2 right-2 text-[11px] font-medium text-white bg-red-600/90 px-2 py-0.5 rounded">
                            Upload failed
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {openCard && (
        <CardDrawer
          card={openCard}
          columns={columns}
          clients={clients}
          doneColumnId={doneColumnId}
          onClose={() => setOpenCard(null)}
          onUpdated={handleCardUpdated}
          onDeleted={handleCardDeleted}
          onColumnChanged={handleCardUpdated}
          userEmail={userEmail}
        />
      )}

    </div>
  )
}
