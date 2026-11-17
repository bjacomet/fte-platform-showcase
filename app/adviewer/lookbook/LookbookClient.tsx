'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import ParticleBackground from '../components/ParticleBackground'
import type { AdviewerCampaign, AdviewerCreativeDeck, AdviewerLookbookFolder } from '@/types'
import { AD_STILL_SECONDS, isVideoUrl, pickThumbFile, resolveFileUrl, videoStillSrc } from '@/lib/mediaKind'
import { clientFacingFiles } from '@/lib/adviewerFiles'
import VideoStill from '@/components/VideoStill'

interface Props {
  campaigns: AdviewerCampaign[]
  decks: AdviewerCreativeDeck[]
  folders: AdviewerLookbookFolder[]
}

interface Creative {
  id: string
  type: 'file' | 'card'
  label: string
  fileUrl: string
}

interface CampaignView {
  id: string
  title: string
  token: string
  clientId: string | null
  clientName: string
  folderId: string | null
  thumbUrl: string
  creatives: Creative[]
}

// resolveUrl / isVideo were private copies here. The isVideo copy had already
// drifted — it omitted 'm4v', so an .m4v creative rendered as a broken image on
// this surface and correctly as video everywhere else. Exactly the drift
// lib/mediaKind.ts exists to stop.
const resolveUrl = resolveFileUrl
const isVideo = isVideoUrl

function initials(name: string) {
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

export default function LookbookClient({ campaigns, decks: initialDecks, folders }: Props) {
  const router = useRouter()
  const supabase = createClient()

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  const [openCampaignId, setOpenCampaignId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [menuKey, setMenuKey] = useState<string | null>(null)

  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renameTarget, setRenameTarget] = useState<AdviewerLookbookFolder | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<AdviewerLookbookFolder | null>(null)
  const [moveTarget, setMoveTarget] = useState<CampaignView | null>(null)
  const [busy, setBusy] = useState(false)
  // Every folder mutation below used to be `if (res.ok) { …close, refresh }` with
  // no else, no catch and no error state. On any non-2xx — and the route now
  // returns 409 for a structural rename or a non-empty delete — the modal simply
  // stayed open and the button re-enabled, so the only feedback was that nothing
  // happened. The user retries and it fails identically.
  const [folderError, setFolderError] = useState<string | null>(null)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [decks, setDecks] = useState<AdviewerCreativeDeck[]>(initialDecks)
  const [showBuildModal, setShowBuildModal] = useState(false)
  const [deckTitle, setDeckTitle] = useState('')
  const [building, setBuilding] = useState(false)
  const [deckDeleteConfirm, setDeckDeleteConfirm] = useState<string | null>(null)
  const [newDeckUrl, setNewDeckUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const campaignViews = useMemo<CampaignView[]>(() => {
    return campaigns.map(c => {
      const creatives: Creative[] = []
      for (const f of c.campaign_files ?? []) {
        if (f.status === 'approved') {
          creatives.push({ id: f.id, type: 'file', label: f.file_name, fileUrl: resolveUrl(f.file_url) })
        }
      }
      for (const cc of c.campaign_cards ?? []) {
        // An approved card that was later ARCHIVED must not reach a Creative
        // Deck. Decks are shared with prospects at /adviewer/deck/[token], and
        // buildDeck below takes whatever is selectable here — so an archived
        // creative was one click from a client-facing link. #89 added this guard
        // to every page that lists multiple cards; the Lookbook missed it only
        // because #83 rewrote this exact loop and kept the pre-#89 shape. The
        // Atlas ScanCo consolidation in #91 produced precisely these rows: approved,
        // then archived.
        //
        // Filtered in JS, not in the query, for the same reason as
        // app/adviewer/c/[token]/page.tsx: a PostgREST filter on an embedded
        // resource does not drop the parent, it returns the join row with
        // `card: null`. Only `archived === true` hides — a null/absent flag
        // means "not marked archived", the safe direction for an older row.
        if (cc.status === 'approved' && cc.card?.archived !== true) {
          creatives.push({
            id: cc.id,
            type: 'card',
            label: cc.card?.title ?? 'Untitled',
            // NOT card_files[0]. PostgREST gives no ordering guarantee on an
            // embedded resource, so [0] changes between reloads, and uploads are
            // unfiltered — prod has six application/zip rows on one card and a
            // PDF, any of which could win and render as a broken-image icon.
            // pickThumbFile keeps only rows a browser can paint, prefers the
            // MIME type over the extension, and orders by created_at.
            // Same client-facing rule as the review page (lib/adviewerFiles.ts),
            // so a source photo on the card can't become the Lookbook thumbnail.
            fileUrl: resolveUrl(cc.card?.preview_image_url ?? pickThumbFile(
              cc.card?.card_files ? clientFacingFiles(cc.card.card_files, cc.card.media_type, cc.card.preview_image_url) : null,
            )?.file_url ?? null),
          })
        }
      }
      // A still image makes the better tile, so it wins when there is one — but
      // falling back to a video is the point: every Atlas creative is an MP4, so
      // before the render path below learned to draw one, all 68 of those cards
      // showed the initials placeholder.
      const thumb = creatives.find(cr => cr.fileUrl && !isVideo(cr.fileUrl))?.fileUrl ?? creatives[0]?.fileUrl ?? ''
      return {
        id: c.id,
        title: c.title,
        token: c.token,
        clientId: c.client_id,
        clientName: c.client?.name ?? 'Unknown',
        folderId: c.lookbook_folder_id ?? null,
        thumbUrl: thumb,
        creatives,
      }
    })
  }, [campaigns])

  const childFolders = useMemo(() => {
    const m = new Map<string | null, AdviewerLookbookFolder[]>()
    for (const f of folders) {
      const k = f.parent_id ?? null
      const arr = m.get(k) ?? []
      arr.push(f)
      m.set(k, arr)
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    }
    return m
  }, [folders])

  const folderById = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders])

  // Both walks below are bounded as well as guarded. The PATCH route now refuses
  // to create a parent_id cycle, but it cannot un-make one that predates the
  // guard — and an unbounded `while (pid)` over cyclic data does not render
  // wrong, it hangs the tab. A cap costs nothing and fails visibly instead.
  const MAX_FOLDER_DEPTH = 64

  function depthOf(f: AdviewerLookbookFolder) {
    let d = 0
    let pid = f.parent_id
    while (pid && d < MAX_FOLDER_DEPTH) { const p = folderById.get(pid); if (!p) break; d++; pid = p.parent_id }
    return d
  }

  const path = useMemo(() => {
    const arr: AdviewerLookbookFolder[] = []
    let id: string | null = currentFolderId
    while (id && arr.length < MAX_FOLDER_DEPTH) { const f = folderById.get(id); if (!f) break; arr.unshift(f); id = f.parent_id }
    return arr
  }, [currentFolderId, folderById])

  const currentFolder = currentFolderId ? folderById.get(currentFolderId) ?? null : null
  const subfolders = childFolders.get(currentFolderId) ?? []
  const campaignsHere = useMemo(
    () => campaignViews.filter(c => (c.folderId ?? null) === currentFolderId),
    [campaignViews, currentFolderId],
  )
  const openCampaign = openCampaignId ? campaignViews.find(c => c.id === openCampaignId) ?? null : null

  const searching = search.trim().length > 0
  const searchResults = useMemo(() => {
    if (!searching) return []
    const q = search.toLowerCase()
    return campaignViews.filter(c => c.title.toLowerCase().includes(q) || c.clientName.toLowerCase().includes(q))
  }, [searching, search, campaignViews])

  // One place that turns a failed response into something a person can read.
  // The routes return a specific `error` for the cases that are refusals rather
  // than faults (renaming a month, deleting a year that still holds campaigns),
  // and that sentence is the whole point — a generic "something went wrong"
  // would leave the user with no idea that the refusal was deliberate.
  async function describeFailure(res: Response, fallback: string): Promise<string> {
    const body = await res.json().catch(() => null) as { error?: string } | null
    return body?.error ?? `${fallback} (${res.status})`
  }

  // Whether the modal should get out of the way so the message can be read.
  //
  // A 4xx here is a REFUSAL — renaming a month, a duplicate name, a folder that
  // still holds campaigns — and retrying with the same input cannot change it,
  // so the modal closes and the banner is visible. A 5xx or a dropped connection
  // might succeed on retry, so the modal stays open with what the user typed
  // still in it. Without this the banner rendered behind the modal's overlay,
  // dimmed and unreadable, which is barely better than the silence it replaced.
  const isRefusal = (res: Response) => res.status >= 400 && res.status < 500

  function countIn(folderId: string) {
    const subs = childFolders.get(folderId)?.length ?? 0
    const camps = campaignViews.filter(c => c.folderId === folderId).length
    return subs + camps
  }

  async function createFolder() {
    const name = newFolderName.trim()
    if (!name || !currentFolder || busy) return
    setBusy(true)
    setFolderError(null)
    try {
      const res = await fetch('/api/adviewer/lookbook-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: currentFolder.client_id, parent_id: currentFolder.id, name }),
      })
      if (res.ok) { setShowNewFolder(false); setNewFolderName(''); router.refresh() }
      else {
        if (isRefusal(res)) setShowNewFolder(false)
        setFolderError(await describeFailure(res, 'Could not create that folder'))
      }
    } catch {
      setFolderError('Could not reach the server. Check your connection and try again.')
    }
    setBusy(false)
  }

  async function submitRename() {
    const name = renameValue.trim()
    if (!name || !renameTarget || busy) return
    setBusy(true)
    setFolderError(null)
    try {
      const res = await fetch(`/api/adviewer/lookbook-folders/${renameTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (res.ok) { setRenameTarget(null); setRenameValue(''); router.refresh() }
      else {
        if (isRefusal(res)) { setRenameTarget(null); setRenameValue('') }
        setFolderError(await describeFailure(res, 'Could not rename that folder'))
      }
    } catch {
      setFolderError('Could not reach the server. Check your connection and try again.')
    }
    setBusy(false)
  }

  async function confirmDelete() {
    if (!deleteTarget || busy) return
    setBusy(true)
    setFolderError(null)
    try {
      const res = await fetch(`/api/adviewer/lookbook-folders/${deleteTarget.id}`, { method: 'DELETE' })
      if (res.ok) {
        if (currentFolderId === deleteTarget.id) setCurrentFolderId(deleteTarget.parent_id ?? null)
        setDeleteTarget(null)
        router.refresh()
      } else {
        setDeleteTarget(null)
        setFolderError(await describeFailure(res, 'Could not delete that folder'))
      }
    } catch {
      setFolderError('Could not reach the server. Check your connection and try again.')
    }
    setBusy(false)
  }

  async function moveCampaignTo(folderId: string | null) {
    if (!moveTarget || busy) return
    setBusy(true)
    setFolderError(null)
    try {
      const res = await fetch(`/api/adviewer/campaign/${moveTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-folder', folder_id: folderId }),
      })
      if (res.ok) { setMoveTarget(null); router.refresh() }
      else {
        if (isRefusal(res)) setMoveTarget(null)
        setFolderError(await describeFailure(res, 'Could not move that campaign'))
      }
    } catch {
      setFolderError('Could not reach the server. Check your connection and try again.')
    }
    setBusy(false)
  }

  function toggleItem(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function buildDeck() {
    if (!deckTitle.trim() || selectedIds.size === 0 || building || !openCampaign) return
    setBuilding(true)
    const selected = openCampaign.creatives.filter(cr => selectedIds.has(cr.id))
    const res = await fetch('/api/adviewer/deck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: deckTitle.trim(),
        client_id: openCampaign.clientId,
        items: selected.map((it, i) => ({ source_type: it.type, source_id: it.id, position: i })),
      }),
    })
    if (res.ok) {
      const { token, deck } = await res.json() as { token: string; deck: AdviewerCreativeDeck }
      setDecks(prev => [deck, ...prev])
      setNewDeckUrl(`${window.location.origin}/adviewer/deck/${token}`)
      setSelectedIds(new Set())
      setDeckTitle('')
      setShowBuildModal(false)
    }
    setBuilding(false)
  }

  async function deleteDeck(id: string) {
    await supabase.from('adviewer_creative_decks').delete().eq('id', id)
    setDecks(prev => prev.filter(d => d.id !== id))
    setDeckDeleteConfirm(null)
  }

  function copyLink(url: string, id: string) {
    void navigator.clipboard.writeText(url)
    setCopied(id)
    setTimeout(() => setCopied(c => c === id ? null : c), 2000)
  }

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.vercel.app'
  const moveFolders = moveTarget ? folders.filter(f => f.client_id === moveTarget.clientId) : []

  return (
    <div className="relative min-h-screen flex flex-col" style={{ background: 'radial-gradient(ellipse 120% 90% at 50% 60%, #12101a 0%, #0d0d11 55%, #0a0a0e 100%)' }} onClick={() => setMenuKey(null)}>
      <ParticleBackground />

      <header className="sticky top-0 z-20 border-b border-white/[0.07]" style={{ background: 'rgba(13,13,17,0.85)', backdropFilter: 'blur(16px)' }}>
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center gap-4">
          <Link href="/adviewer/dashboard" className="flex items-center gap-2 text-white/50 hover:text-white transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            <span className="text-xs font-medium">Dashboard</span>
          </Link>
          <div className="w-px h-5 bg-white/10" />
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-none" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
            <span className="text-white font-black text-[10px] tracking-tight">FTE</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white leading-tight">Lookbook</p>
            <p className="text-[10px] text-white/30 uppercase tracking-widest">Approved Creatives Library</p>
          </div>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="w-52 text-xs bg-white/[0.06] border border-white/10 rounded-lg px-3 py-1.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60"
          />
          {openCampaign && selectedIds.size > 0 && (
            <button
              onClick={() => setShowBuildModal(true)}
              className="flex items-center gap-1.5 text-xs font-semibold text-white px-3 py-1.5 rounded-lg"
              style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
            >
              Build Creative Deck ({selectedIds.size})
            </button>
          )}
        </div>
      </header>

      <div className="relative z-10 flex-1 max-w-7xl mx-auto w-full px-5 py-6">

        <div className="flex items-center gap-2 mb-5 flex-wrap">
          <button
            onClick={() => { setCurrentFolderId(null); setOpenCampaignId(null); setSearch('') }}
            className="text-xs font-medium text-white/60 hover:text-white transition-colors"
          >
            Lookbook
          </button>
          {!searching && path.map(f => (
            <span key={f.id} className="flex items-center gap-2">
              <span className="text-white/20 text-xs">/</span>
              <button
                onClick={() => { setCurrentFolderId(f.id); setOpenCampaignId(null) }}
                className="text-xs font-medium text-white/60 hover:text-white transition-colors"
              >
                {f.name}
              </button>
            </span>
          ))}
          {!searching && openCampaign && (
            <span className="flex items-center gap-2">
              <span className="text-white/20 text-xs">/</span>
              <span className="text-xs font-semibold text-white">{openCampaign.title}</span>
            </span>
          )}
          {searching && <span className="text-xs text-white/40">Search results for “{search}”</span>}

          <div className="flex-1" />

          {!searching && !openCampaign && currentFolder && (
            <button
              onClick={() => { setShowNewFolder(true); setNewFolderName('') }}
              className="flex items-center gap-1.5 text-xs font-medium text-white/70 hover:text-white bg-white/[0.06] hover:bg-white/10 border border-white/10 rounded-lg px-3 py-1.5 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New folder
            </button>
          )}
        </div>

        {/* Refusals from the folder routes are deliberate and explain themselves,
            so they are shown as written rather than flattened into a generic
            failure. Dismissible, because the user has read it once. */}
        {folderError && (
          <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-4 py-3">
            <svg className="w-4 h-4 flex-none mt-0.5 text-amber-300/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <p className="flex-1 text-xs text-amber-100/90 leading-relaxed">{folderError}</p>
            <button
              onClick={() => setFolderError(null)}
              className="flex-none text-amber-200/50 hover:text-amber-100 transition-colors"
              aria-label="Dismiss"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        )}

        {searching ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {searchResults.map(c => (
              <CampaignTile key={c.id} c={c} baseUrl={baseUrl} menuKey={menuKey} setMenuKey={setMenuKey}
                onOpen={() => { setSearch(''); setCurrentFolderId(c.folderId); setOpenCampaignId(c.id); setSelectedIds(new Set()) }}
                onMove={() => setMoveTarget(c)} />
            ))}
            {searchResults.length === 0 && <EmptyBox label="No campaigns match your search" />}
          </div>
        ) : openCampaign ? (
          <section>
            {openCampaign.creatives.length === 0 ? (
              <EmptyBox label="This campaign has no approved creatives" />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {openCampaign.creatives.map(cr => {
                  const selected = selectedIds.has(cr.id)
                  return (
                    <button key={cr.id} onClick={() => toggleItem(cr.id)}
                      className={`relative rounded-xl overflow-hidden border text-left transition-all ${selected ? 'border-[#7c3aed] ring-2 ring-[#7c3aed]/40' : 'border-white/[0.08] hover:border-white/20'}`}>
                      <div className="bg-white/[0.04] aspect-square flex items-center justify-center overflow-hidden">
                        {cr.fileUrl && !isVideo(cr.fileUrl)
                          ? <img src={cr.fileUrl} alt={cr.label} className="w-full h-full object-contain" />
                          : cr.fileUrl && isVideo(cr.fileUrl)
                            ? <VideoStill className="relative w-full h-full" src={videoStillSrc(cr.fileUrl, undefined, AD_STILL_SECONDS)} />
                            : <div className="flex flex-col items-center gap-2 text-white/20"><div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#7c3aed]/30 to-[#06b6d4]/30 flex items-center justify-center"><span className="text-xs font-bold text-white/50">{initials(openCampaign.clientName)}</span></div><span className="text-[10px] text-white/30">Social Ad</span></div>}
                      </div>
                      <div className="p-2.5 bg-white/[0.03]"><p className="text-[11px] font-medium text-white truncate">{cr.label}</p></div>
                      {selected && (
                        <div className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #7c3aed, #06b6d4)' }}>
                          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            <a href={`${baseUrl}/adviewer/c/${openCampaign.token}`} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 mt-4 text-xs font-medium text-[#a78bfa] hover:text-white transition-colors">
              Open full campaign in Adviewer
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          </section>
        ) : (
          <>
            {subfolders.length === 0 && campaignsHere.length === 0 ? (
              <EmptyBox label={currentFolder ? 'This folder is empty' : 'No approved campaigns yet — approve a campaign to populate the Lookbook'} />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {subfolders.map(f => (
                  <div key={f.id} className="relative">
                    <button
                      onClick={() => { setCurrentFolderId(f.id); setOpenCampaignId(null) }}
                      className="w-full flex items-center gap-3 rounded-xl border border-white/[0.08] hover:border-white/20 bg-white/[0.04] hover:bg-white/[0.06] p-3.5 text-left transition-all"
                    >
                      <svg className="w-8 h-8 flex-none text-[#a78bfa]" fill="currentColor" viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" /></svg>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-white truncate">{f.name}</p>
                        <p className="text-[10px] text-white/30">{countIn(f.id)} item{countIn(f.id) === 1 ? '' : 's'}</p>
                      </div>
                    </button>
                    <button onClick={e => { e.stopPropagation(); setMenuKey(menuKey === `folder:${f.id}` ? null : `folder:${f.id}`) }}
                      className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-md text-white/40 hover:text-white hover:bg-white/10 transition-colors">
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
                    </button>
                    {menuKey === `folder:${f.id}` && (
                      <div onClick={e => e.stopPropagation()} className="absolute top-9 right-2 z-30 w-36 rounded-lg border border-white/15 py-1 shadow-xl" style={{ background: 'rgba(24,22,34,0.98)' }}>
                        <button onClick={() => { setRenameTarget(f); setRenameValue(f.name); setMenuKey(null) }} className="w-full text-left text-xs text-white/70 hover:text-white hover:bg-white/10 px-3 py-1.5 transition-colors">Rename</button>
                        <button onClick={() => { setDeleteTarget(f); setMenuKey(null) }} className="w-full text-left text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-400/10 px-3 py-1.5 transition-colors">Delete</button>
                      </div>
                    )}
                  </div>
                ))}
                {campaignsHere.map(c => (
                  <CampaignTile key={c.id} c={c} baseUrl={baseUrl} menuKey={menuKey} setMenuKey={setMenuKey}
                    onOpen={() => { setOpenCampaignId(c.id); setSelectedIds(new Set()) }}
                    onMove={() => setMoveTarget(c)} />
                ))}
              </div>
            )}
          </>
        )}

        {decks.length > 0 && (
          <section className="mt-10">
            <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest mb-3">My Creative Decks</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {decks.map(deck => {
                const deckUrl = `${baseUrl}/adviewer/deck/${deck.token}`
                return (
                  <div key={deck.id} className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-4 flex flex-col gap-3">
                    <div>
                      <p className="text-xs font-semibold text-white truncate">{deck.title}</p>
                      <p className="text-[10px] text-white/30 mt-0.5">{deck.client?.name ?? '—'} · {deck.items?.length ?? 0} creatives</p>
                    </div>
                    <div className="flex items-center gap-2 mt-auto">
                      <a href={deckUrl} target="_blank" rel="noopener noreferrer" className="flex-1 text-center text-xs font-medium py-1.5 rounded-lg bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10 transition-colors">Open</a>
                      <button onClick={() => copyLink(deckUrl, deck.id)} className="flex-1 text-center text-xs font-medium py-1.5 rounded-lg transition-colors" style={copied === deck.id ? { background: 'rgba(16,185,129,0.15)', color: 'rgb(52,211,153)' } : { background: 'rgba(124,58,237,0.15)', color: 'rgba(167,139,250,1)' }}>{copied === deck.id ? '✓ Copied' : 'Copy link'}</button>
                      <button onClick={() => setDeckDeleteConfirm(deck.id)} title="Delete deck" className="w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-rose-400 hover:bg-rose-400/10 transition-colors flex-none">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>

      {showNewFolder && currentFolder && (
        <Modal onClose={() => setShowNewFolder(false)}>
          <h2 className="text-base font-semibold text-white mb-1">New folder</h2>
          <p className="text-[12px] text-white/40 mb-3">Inside {currentFolder.name}</p>
          <input type="text" value={newFolderName} autoFocus onChange={e => setNewFolderName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void createFolder() }} placeholder="Folder name" className="w-full text-sm bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60" />
          <div className="flex gap-2 mt-4">
            <button onClick={() => void createFolder()} disabled={!newFolderName.trim() || busy} className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white disabled:opacity-40" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>{busy ? 'Creating…' : 'Create'}</button>
            <button onClick={() => setShowNewFolder(false)} className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      {renameTarget && (
        <Modal onClose={() => setRenameTarget(null)}>
          <h2 className="text-base font-semibold text-white mb-3">Rename folder</h2>
          <input type="text" value={renameValue} autoFocus onChange={e => setRenameValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submitRename() }} className="w-full text-sm bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-[#7c3aed]/60" />
          <div className="flex gap-2 mt-4">
            <button onClick={() => void submitRename()} disabled={!renameValue.trim() || busy} className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white disabled:opacity-40" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>{busy ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setRenameTarget(null)} className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal onClose={() => setDeleteTarget(null)}>
          <h2 className="text-base font-semibold text-white mb-2">Delete “{deleteTarget.name}”?</h2>
          <p className="text-sm text-white/40 mb-4">Any campaigns inside become Unfiled — the campaigns, their creatives and share links are never touched. Sub-folders are removed too.</p>
          <div className="flex gap-2">
            <button onClick={() => void confirmDelete()} disabled={busy} className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white bg-rose-600 hover:bg-rose-500 transition-colors disabled:opacity-40">{busy ? 'Deleting…' : 'Delete folder'}</button>
            <button onClick={() => setDeleteTarget(null)} className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      {moveTarget && (
        <Modal onClose={() => setMoveTarget(null)}>
          <h2 className="text-base font-semibold text-white mb-1">Move “{moveTarget.title}”</h2>
          <p className="text-[12px] text-white/40 mb-3">Pick a destination folder for {moveTarget.clientName}</p>
          <div className="max-h-72 overflow-y-auto flex flex-col gap-1">
            <button onClick={() => void moveCampaignTo(null)} disabled={busy} className="text-left text-xs text-white/60 hover:text-white hover:bg-white/10 rounded-lg px-3 py-2 transition-colors">Unfiled (remove from folder)</button>
            {moveFolders.map(f => (
              <button key={f.id} onClick={() => void moveCampaignTo(f.id)} disabled={busy}
                className={`text-left text-xs rounded-lg px-3 py-2 transition-colors ${moveTarget.folderId === f.id ? 'text-white bg-white/10' : 'text-white/60 hover:text-white hover:bg-white/10'}`}
                style={{ paddingLeft: `${12 + depthOf(f) * 14}px` }}>
                {f.name}{moveTarget.folderId === f.id ? '  ·  current' : ''}
              </button>
            ))}
          </div>
          <div className="flex justify-end mt-4">
            <button onClick={() => setMoveTarget(null)} className="px-4 py-2 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      {showBuildModal && (
        <Modal onClose={() => setShowBuildModal(false)}>
          <h2 className="text-base font-semibold text-white mb-1">Build Creative Deck</h2>
          <p className="text-[12px] text-white/40 mb-3">{selectedIds.size} creative{selectedIds.size !== 1 ? 's' : ''} selected</p>
          <input type="text" value={deckTitle} autoFocus onChange={e => setDeckTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void buildDeck() }} placeholder="e.g. Q3 2026 Sales Presentation" className="w-full text-sm bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60" />
          <div className="flex gap-2 mt-4">
            <button onClick={() => void buildDeck()} disabled={!deckTitle.trim() || building} className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white disabled:opacity-40" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>{building ? 'Building…' : 'Create Deck'}</button>
            <button onClick={() => setShowBuildModal(false)} className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      {newDeckUrl && (
        <Modal onClose={() => setNewDeckUrl(null)}>
          <p className="text-sm font-semibold text-white mb-1">Creative Deck created!</p>
          <p className="text-[12px] text-white/40 mb-3">Share this link in your meeting</p>
          <div className="bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 mb-4"><p className="text-[11px] text-white/50 truncate">{newDeckUrl}</p></div>
          <div className="flex gap-2">
            <button onClick={() => copyLink(newDeckUrl, 'new')} className="flex-1 text-sm font-semibold py-2.5 rounded-xl transition-colors" style={copied === 'new' ? { background: 'rgba(16,185,129,0.2)', color: 'rgb(52,211,153)' } : { background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)', color: 'white' }}>{copied === 'new' ? '✓ Copied!' : 'Copy link'}</button>
            <button onClick={() => setNewDeckUrl(null)} className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Done</button>
          </div>
        </Modal>
      )}

      {deckDeleteConfirm && (
        <Modal onClose={() => setDeckDeleteConfirm(null)}>
          <h2 className="text-base font-semibold text-white mb-2">Delete this deck?</h2>
          <p className="text-sm text-white/40 mb-4">The shareable link will stop working. The original creatives stay in the Lookbook.</p>
          <div className="flex gap-2">
            <button onClick={() => void deleteDeck(deckDeleteConfirm)} className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white bg-rose-600 hover:bg-rose-500 transition-colors">Delete</button>
            <button onClick={() => setDeckDeleteConfirm(null)} className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      <footer className="relative z-10 border-t border-white/[0.06] py-4">
        <p className="text-[10px] text-white/20 text-center uppercase tracking-widest">Follow The Eyes · Lookbook</p>
      </footer>
    </div>
  )
}

function EmptyBox({ label }: { label: string }) {
  return (
    <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-12 text-center">
      <p className="text-sm font-medium text-white/40">{label}</p>
    </div>
  )
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-white/15 p-6" style={{ background: 'rgba(18,16,26,0.97)' }}>
        {children}
      </div>
    </div>
  )
}

function CampaignTile({ c, baseUrl, menuKey, setMenuKey, onOpen, onMove }: {
  c: CampaignView
  baseUrl: string
  menuKey: string | null
  setMenuKey: (k: string | null) => void
  onOpen: () => void
  onMove: () => void
}) {
  return (
    <div className="relative">
      <button onClick={onOpen} className="w-full rounded-xl overflow-hidden border border-white/[0.08] hover:border-white/20 text-left transition-all">
        <div className="bg-white/[0.04] aspect-square flex items-center justify-center overflow-hidden">
          {c.thumbUrl && !isVideo(c.thumbUrl)
            ? <img src={c.thumbUrl} alt={c.title} className="w-full h-full object-contain" />
            : c.thumbUrl && isVideo(c.thumbUrl)
            ? <VideoStill className="relative w-full h-full" src={videoStillSrc(c.thumbUrl, undefined, AD_STILL_SECONDS)} />
            : <div className="flex flex-col items-center gap-2 text-white/20"><div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#7c3aed]/30 to-[#06b6d4]/30 flex items-center justify-center"><span className="text-xs font-bold text-white/50">{initials(c.clientName)}</span></div><span className="text-[10px] text-white/30">{c.creatives.length} creative{c.creatives.length === 1 ? '' : 's'}</span></div>}
        </div>
        <div className="p-2.5 bg-white/[0.03]">
          <p className="text-[11px] font-medium text-white truncate">{c.title}</p>
          <p className="text-[10px] text-white/30 truncate">{c.creatives.length} creative{c.creatives.length === 1 ? '' : 's'}</p>
        </div>
      </button>
      <button onClick={e => { e.stopPropagation(); setMenuKey(menuKey === `campaign:${c.id}` ? null : `campaign:${c.id}`) }}
        className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-md text-white/50 hover:text-white bg-black/40 hover:bg-black/60 transition-colors">
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
      </button>
      {menuKey === `campaign:${c.id}` && (
        <div onClick={e => e.stopPropagation()} className="absolute top-9 right-2 z-30 w-40 rounded-lg border border-white/15 py-1 shadow-xl" style={{ background: 'rgba(24,22,34,0.98)' }}>
          <a href={`${baseUrl}/adviewer/c/${c.token}`} target="_blank" rel="noopener noreferrer" onClick={() => setMenuKey(null)} className="block text-xs text-white/70 hover:text-white hover:bg-white/10 px-3 py-1.5 transition-colors">Open in Adviewer ↗</a>
          <button onClick={() => { onMove(); setMenuKey(null) }} className="w-full text-left text-xs text-white/70 hover:text-white hover:bg-white/10 px-3 py-1.5 transition-colors">Move to folder…</button>
        </div>
      )}
    </div>
  )
}
