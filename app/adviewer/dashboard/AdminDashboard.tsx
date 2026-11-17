'use client'

import { useState, useMemo, useCallback, useTransition, useEffect } from 'react'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import ParticleBackground from '../components/ParticleBackground'
import type { AdviewerCampaign, AdviewerStatus, AdviewerCampaignScope } from '@/types'
import { CONTACTS_KEY, buildContactsCsv, contactsFromRows, type StoredContacts } from '@/lib/locationContacts'
import { saveStaffSetting } from '@/lib/staffSettings'
import { FB_CTA_OPTIONS } from '@/types'

// Bounds the direct-to-storage upload path (sign → uploadToSignedUrl) so an
// oversized file is rejected client-side with a clean message instead of 413-ing
// at the storage PUT. This matches the Supabase Free-plan GLOBAL storage upload cap
// (Storage → Settings → "Global file size limit", not SQL-editable) — the effective
// ceiling is min(global 50 MB, creative-files bucket 200 MB) = 50 MB. Bump back to
// 200 MB if/when the project moves to Supabase Pro and the global limit is raised.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50 MB

interface Client {
  id: string
  name: string
  abbreviation: string | null
  fb_page_logo_url: string | null
}

interface CardOption {
  id: string
  title: string
  media_type: string | null
}

// A file queued for direct upload to a campaign. render_mode 'display' (default)
// uploads it as a raw display creative; 'social' renders it inside the Facebook
// feed mockup using the copy fields below — no board card required.
interface QueuedUpload {
  file: File
  renderMode: 'display' | 'social'
  fbPageName: string
  fbBodyText: string
  fbHeadline: string
  fbSubheadline: string
  fbCta: string
  landingPageUrl: string
}

interface Props {
  userEmail: string
  clients: Client[]
  campaigns: AdviewerCampaign[]
}

const STATUS_STYLE: Record<string, string> = {
  pending:         'bg-amber-400/15 text-amber-300 border-amber-400/25',
  approved:        'bg-emerald-400/15 text-emerald-300 border-emerald-400/25',
  needs_revision:  'bg-rose-400/15 text-rose-300 border-rose-400/25',
}
const STATUS_LABEL: Record<string, string> = {
  pending:        'Pending',
  approved:       'Approved',
  needs_revision: 'Needs Revision',
}
// Sort needs_revision to the top so campaigns awaiting action surface first.
const STATUS_RANK: Record<AdviewerStatus, number> = { needs_revision: 0, pending: 1, approved: 2 }

function initials(name: string) {
  return name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase()
}

// How many creatives a dashboard tile lists before it collapses to "+N more".
// Reason for the cap: a tile is a *summary*, not the campaign. Before this, the
// tile printed every linked creative, so a 70-creative campaign (Atlas September)
// rendered a 70-row tile while a 2-creative campaign rendered a 2-row one — the
// grid row stretched to the tallest tile and everything below it was pushed off
// the first screen. Three rows is what the typical monthly campaign has anyway,
// so most tiles are unchanged; the full list lives one click away behind Open.
const TILE_PREVIEW_ROWS = 3
// Reserve the list area at its full height on every tile — 3 rows (h-4) + the
// "+N more" line, at gap-1 — so a 1-creative tile lines up with a 70-creative
// one. Without this the grid is even within a row but ragged between rows.
const TILE_LIST_MIN_H = 'min-h-[4.75rem]'

// One row of a dashboard tile's creative list. Board cards and uploaded files
// render identically here, so they are flattened into this shape before the cap
// is applied — otherwise the cap would have to be split across two lists and a
// campaign with 3 cards + 3 files would still render six rows.
type TileRow = {
  key: string
  dot: string
  label: string
  archived: boolean
  type: string | null
}

// The Supabase campaign-row select shared by campaign create + add-creative refresh.
const CAMPAIGN_SELECT = 'id, title, token, status, archived, client_id, created_at, updated_at, client:clients(id, name, fb_page_logo_url), campaign_cards:adviewer_campaign_cards(id, position, status, client_notes, card_id, card:cards(id, title, media_type, archived, atlas_location_id)), campaign_files:adviewer_campaign_files(id, file_name, file_url, position, status, client_notes, render_mode), scopes:adviewer_campaign_scopes(id, status)'

export default function AdminDashboard({ userEmail, clients, campaigns: initialCampaigns }: Props) {
  const router = useRouter()
  const supabase = createClient()

  const [campaigns, setCampaigns] = useState<AdviewerCampaign[]>(initialCampaigns)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // 'locations' is not a campaign status — it is the one view that deliberately
  // includes ARCHIVED campaigns. Corporate approval sets status='approved' AND
  // archived=true in the same write, so the moment a campaign becomes eligible
  // for location links it disappears from every other view here. See
  // campaignsForLocations.
  const [statusFilter, setStatusFilter] = useState<'all' | AdviewerStatus | 'locations'>('all')
  const [clientSearch, setClientSearch] = useState('')
  const [, startTransition] = useTransition()
  const [copied, setCopied] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [resetting, setResetting] = useState<string | null>(null)
  const [archiving, setArchiving] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)

  // ── Per-location review links (scopes) ───────────────────────────────────
  // Loaded on demand for one campaign at a time rather than joined into the
  // dashboard query: most campaigns have no scopes at all, and the panel is a
  // deliberate click.
  const [scopePanel, setScopePanel] = useState<AdviewerCampaign | null>(null)
  const [scopes, setScopes] = useState<AdviewerCampaignScope[]>([])
  const [scopesBusy, setScopesBusy] = useState(false)
  const [scopesError, setScopesError] = useState<string | null>(null)
  // Atlas location contact sheet (lib/locationContacts.ts). Loaded when the panel opens.
  const [contacts, setContacts] = useState<StoredContacts | null>(null)
  const [contactsBusy, setContactsBusy] = useState(false)
  const [contactsError, setContactsError] = useState<string | null>(null)
  const [copiedScope, setCopiedScope] = useState<string | null>(null)
  // Closing a location on its behalf is the normal path when changes arrive by
  // email, and the note is the only record of that conversation. It is typed,
  // not defaulted — a hardcoded "Closed by staff" would overwrite the one piece
  // of information worth keeping.
  const [closingScopeId, setClosingScopeId] = useState<string | null>(null)
  const [closeNote, setCloseNote] = useState('')

  // ── Sidebar drag-to-reorder ──────────────────────────────────────────────────
  const SIDEBAR_SECTIONS = ['clients', 'lookbook'] as const
  type SidebarSection = typeof SIDEBAR_SECTIONS[number]
  const [sidebarOrder, setSidebarOrder] = useState<SidebarSection[]>(() => {
    if (typeof window === 'undefined') return [...SIDEBAR_SECTIONS]
    try {
      const saved = localStorage.getItem('adviewer-sidebar-order')
      if (saved) {
        const parsed = JSON.parse(saved) as SidebarSection[]
        if (parsed.length === SIDEBAR_SECTIONS.length) return parsed
      }
    } catch { /* ignore */ }
    return [...SIDEBAR_SECTIONS]
  })

  useEffect(() => {
    localStorage.setItem('adviewer-sidebar-order', JSON.stringify(sidebarOrder))
  }, [sidebarOrder])

  function handleSidebarDragEnd(result: DropResult) {
    if (!result.destination || result.destination.index === result.source.index) return
    const next = [...sidebarOrder]
    const [moved] = next.splice(result.source.index, 1)
    next.splice(result.destination.index, 0, moved)
    setSidebarOrder(next)
  }

  // ── Campaign creation state ──────────────────────────────────────────────────
  const [showCreateCampaign, setShowCreateCampaign] = useState(false)
  const [campaignTitle, setCampaignTitle] = useState('')
  const [campaignClientId, setCampaignClientId] = useState('')
  const [clientCards, setClientCards] = useState<CardOption[]>([])
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([])
  const [loadingCards, setLoadingCards] = useState(false)
  const [creatingCampaign, setCreatingCampaign] = useState(false)
  const [uploadQueue, setUploadQueue] = useState<QueuedUpload[]>([])
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  // ── Add-creative-to-existing-campaign state ──────────────────────────────────
  // Shares uploadQueue / addFilesToQueue / updateQueueItem with the create modal;
  // only one modal is open at a time so the shared queue never collides.
  const [addCreativeCampaignId, setAddCreativeCampaignId] = useState<string | null>(null)
  const [addingCreative, setAddingCreative] = useState(false)


  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://your-app.vercel.app'


  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/adviewer/login')
  }

  async function fetchCardsForClient(clientId: string) {
    setLoadingCards(true)
    const { data } = await supabase.from('cards').select('id, title, media_type').eq('client_id', clientId).eq('archived', false).order('title')
    setClientCards((data ?? []) as CardOption[])
    setLoadingCards(false)
  }

  async function openCreateCampaign(clientId?: string) {
    setCampaignTitle('')
    setCampaignClientId(clientId ?? '')
    setSelectedCardIds([])
    setClientCards([])
    setUploadQueue([])
    setUploadError(null)
    setShowCreateCampaign(true)
    if (clientId) await fetchCardsForClient(clientId)
  }

  function addFilesToQueue(files: FileList | File[]) {
    const allowed = ['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime']
    const oversize: string[] = []
    const valid = Array.from(files)
      .filter(f => allowed.includes(f.type))
      .filter(f => {
        if (f.size > MAX_UPLOAD_BYTES) {
          oversize.push(`${f.name} is ${Math.round(f.size / 1024 / 1024)} MB — over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`)
          return false
        }
        return true
      })
      .map<QueuedUpload>(file => ({
        file,
        renderMode: 'display',
        fbPageName: '',
        fbBodyText: '',
        fbHeadline: '',
        fbSubheadline: '',
        fbCta: 'Learn More',
        landingPageUrl: '',
      }))
    if (oversize.length) setUploadError(oversize.join(' · '))
    setUploadQueue(prev => [...prev, ...valid])
  }

  function updateQueueItem(index: number, patch: Partial<QueuedUpload>) {
    setUploadQueue(prev => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)))
  }

  async function handleCreateCampaign() {
    const hasContent = selectedCardIds.length > 0 || uploadQueue.length > 0
    if (!campaignTitle.trim() || !campaignClientId || !hasContent || creatingCampaign) return
    setCreatingCampaign(true)
    try {
      const res = await fetch('/api/adviewer/campaign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: campaignTitle.trim(), client_id: campaignClientId, card_ids: selectedCardIds }),
      })
      if (!res.ok) throw new Error('Failed')
      const { token: newToken, campaign_id } = await res.json() as { token: string; campaign_id: string; previewUrl: string }

      // Upload queued files
      if (uploadQueue.length > 0) {
        setUploadingFiles(true)
        setUploadError(null)
        const failedFiles: string[] = []
        for (let i = 0; i < uploadQueue.length; i++) {
          const q = uploadQueue[i]
          const fd = new FormData()
          fd.append('file', q.file)
          fd.append('campaign_id', campaign_id)
          fd.append('position', String(i))
          fd.append('render_mode', q.renderMode)
          if (q.renderMode === 'social') {
            fd.append('fb_page_name', q.fbPageName)
            fd.append('fb_body_text', q.fbBodyText)
            fd.append('fb_headline', q.fbHeadline)
            fd.append('fb_subheadline', q.fbSubheadline)
            fd.append('fb_cta', q.fbCta)
            fd.append('landing_page_url', q.landingPageUrl)
          }
          const uploadRes = await fetch('/api/adviewer/upload', { method: 'POST', body: fd })
          if (!uploadRes.ok) failedFiles.push(q.file.name)
        }
        setUploadingFiles(false)
        if (failedFiles.length > 0) {
          setUploadError(`Failed to upload: ${failedFiles.join(', ')}`)
          setCreatingCampaign(false)
          return
        }
      }

      const { data } = await supabase
        .from('adviewer_campaigns')
        .select(CAMPAIGN_SELECT)
        .eq('token', newToken)
        .single()

      if (data) setCampaigns(prev => [data as unknown as AdviewerCampaign, ...prev])
      setShowCreateCampaign(false)
    } catch {
      // keep modal open
    } finally {
      setCreatingCampaign(false)
      setUploadingFiles(false)
    }
  }

  function toggleCardSelection(cardId: string) {
    setSelectedCardIds(prev => prev.includes(cardId) ? prev.filter(id => id !== cardId) : [...prev, cardId])
  }

  function openAddCreative(campaignId: string) {
    setUploadQueue([])
    setUploadError(null)
    setAddCreativeCampaignId(campaignId)
  }

  // Direct-to-storage upload for creatives added to an existing campaign. Each queued
  // file is signed (/upload/sign) → uploaded straight to Supabase Storage from the
  // browser (bypassing the ~4.5MB serverless body cap that makes video fail through
  // /api/adviewer/upload) → recorded (/campaign-file). Real per-file errors surface;
  // files that succeeded are dropped from the queue so a retry won't duplicate them.
  async function handleAddCreative() {
    const campaignId = addCreativeCampaignId
    if (!campaignId || uploadQueue.length === 0 || addingCreative) return
    setAddingCreative(true)
    setUploadError(null)

    const failures: string[] = []
    const succeeded = new Set<number>()

    for (let i = 0; i < uploadQueue.length; i++) {
      const q = uploadQueue[i]
      try {
        const signRes = await fetch('/api/adviewer/upload/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ campaign_id: campaignId, file_name: q.file.name }),
        })
        const signJson = await signRes.json().catch(() => ({})) as { path?: string; token?: string; publicUrl?: string; error?: string }
        if (!signRes.ok || !signJson.path || !signJson.token || !signJson.publicUrl) {
          failures.push(`${q.file.name}: ${signJson.error ?? 'could not sign upload'}`)
          continue
        }

        const { error: upErr } = await supabase.storage
          .from('creative-files')
          .uploadToSignedUrl(signJson.path, signJson.token, q.file)
        if (upErr) {
          failures.push(`${q.file.name}: ${upErr.message}`)
          continue
        }

        const recordRes = await fetch('/api/adviewer/campaign-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            campaign_id: campaignId,
            file_name: q.file.name,
            file_url: signJson.publicUrl,
            render_mode: q.renderMode,
            ...(q.renderMode === 'social' ? {
              fb_page_name: q.fbPageName,
              fb_body_text: q.fbBodyText,
              fb_headline: q.fbHeadline,
              fb_subheadline: q.fbSubheadline,
              fb_cta: q.fbCta,
              landing_page_url: q.landingPageUrl,
            } : {}),
          }),
        })
        const recordJson = await recordRes.json().catch(() => ({})) as { error?: string }
        if (!recordRes.ok) {
          failures.push(`${q.file.name}: ${recordJson.error ?? 'could not record file'}`)
          continue
        }
        succeeded.add(i)
      } catch (e) {
        failures.push(`${q.file.name}: ${e instanceof Error ? e.message : 'unexpected error'}`)
      }
    }

    // Refresh the campaign row so newly added files appear in the list.
    if (succeeded.size > 0) {
      const { data } = await supabase
        .from('adviewer_campaigns')
        .select(CAMPAIGN_SELECT)
        .eq('id', campaignId)
        .single()
      if (data) setCampaigns(prev => prev.map(c => c.id === campaignId ? (data as unknown as AdviewerCampaign) : c))
    }

    setAddingCreative(false)
    if (failures.length > 0) {
      setUploadQueue(prev => prev.filter((_, i) => !succeeded.has(i)))
      setUploadError(`Failed: ${failures.join(' · ')}`)
      return // keep modal open so the user sees exactly what failed
    }
    setAddCreativeCampaignId(null)
  }


  // Lifecycle writes go through /api/adviewer/campaign/[id] (service role behind an
  // auth gate) rather than the browser supabase client: adviewer_* writes are
  // writer-only RLS, so a non-writer's direct write was silently rejected while the
  // optimistic state update below made it look like it succeeded. State is only
  // updated after response.ok, so a real failure no longer lies to the user.
  async function deleteCampaign(id: string) {
    const res = await fetch(`/api/adviewer/campaign/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      console.error('Failed to delete campaign:', (await res.json().catch(() => ({}))).error)
      return
    }
    setCampaigns(prev => prev.filter(c => c.id !== id))
    setDeleteConfirm(null)
  }

  async function archiveCampaign(id: string) {
    setArchiving(id)
    const res = await fetch(`/api/adviewer/campaign/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    })
    if (res.ok) {
      setCampaigns(prev => prev.filter(c => c.id !== id))
    } else {
      console.error('Failed to archive campaign:', (await res.json().catch(() => ({}))).error)
    }
    setArchiving(null)
  }

  async function resetCampaign(id: string) {
    setResetting(id)
    const res = await fetch(`/api/adviewer/campaign/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset' }),
    })
    if (res.ok) {
      setCampaigns(prev => prev.map(c => c.id === id ? { ...c, status: 'pending' as AdviewerStatus } : c))
    } else {
      console.error('Failed to reset campaign:', (await res.json().catch(() => ({}))).error)
    }
    setResetting(null)
  }

  async function loadContacts(): Promise<StoredContacts | null> {
    setContactsError(null)
    const { data, error } = await supabase.from('app_settings').select('value').eq('key', CONTACTS_KEY).maybeSingle()
    if (error) { setContactsError(error.message); return null }
    let parsed: StoredContacts | null = null
    try { parsed = data?.value ? JSON.parse(data.value) as StoredContacts : null } catch { parsed = null }
    setContacts(parsed)
    return parsed
  }

  // Parse in the browser (SheetJS, loaded only when used) and store the rows —
  // not the file — so the download needs no re-upload next month. Replaces the
  // previous sheet entirely: the sheet is the team's master list.
  async function uploadContacts(file: File) {
    setContactsBusy(true)
    setContactsError(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false })
      const parsed = contactsFromRows(rows)
      if (parsed.length === 0) throw new Error('No contact rows found under the Location / Name / Email headers.')
      const stored: StoredContacts = { fileName: file.name, uploadedAt: new Date().toISOString(), rows: parsed }
      // Staff settings route: RLS keeps app_settings writes admin-only.
      const error = await saveStaffSetting(CONTACTS_KEY, JSON.stringify(stored))
      if (error) throw new Error(error)
      setContacts(stored)
    } catch (e) {
      setContactsError(e instanceof Error ? e.message : 'Could not read that sheet')
    }
    setContactsBusy(false)
  }

  // Explicit args so the one-click flow can pass what it just fetched instead of
  // reading state that has not re-rendered yet.
  function downloadContactsSheet(campaign: AdviewerCampaign, rows = contacts?.rows ?? [], links = scopes) {
    const csv = buildContactsCsv(rows, links, baseUrl)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${campaign.title.replace(/[\\/:*?"<>|]/g, '-')} — location links.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function openScopePanel(campaign: AdviewerCampaign) {
    void loadContacts()
    setScopePanel(campaign)
    setScopes([])
    setScopesError(null)
    setScopesBusy(true)
    try {
      const res = await fetch(`/api/adviewer/campaign/${campaign.id}/scopes`)
      const body = await res.json() as { scopes?: AdviewerCampaignScope[]; error?: string }
      if (!res.ok) setScopesError(body.error ?? 'Could not load location links')
      else setScopes(body.scopes ?? [])
    } catch {
      setScopesError('Could not load location links')
    }
    setScopesBusy(false)
  }

  // POST is idempotent server-side (upsert on campaign_id + atlas_location_id), so
  // clicking this twice adds links for newly-linked locations and leaves every
  // existing token alone. That matters: a re-minted token is a dead link in
  // somebody's inbox.
  async function generateScopes(campaignId: string): Promise<AdviewerCampaignScope[] | null> {
    let result: AdviewerCampaignScope[] | null = null
    setScopesBusy(true)
    setScopesError(null)
    try {
      const res = await fetch(`/api/adviewer/campaign/${campaignId}/scopes`, { method: 'POST' })
      const body = await res.json() as { scopes?: AdviewerCampaignScope[]; error?: string }
      if (!res.ok) setScopesError(body.error ?? 'Could not generate location links')
      else {
        const next = body.scopes ?? []
        result = next
        setScopes(next)
        // Keep the tile's link count in step without a reload.
        setCampaigns(prev => prev.map(c => c.id === campaignId ? { ...c, scopes: next.map(sc => ({ id: sc.id, status: sc.status })) } : c))
      }
    } catch {
      setScopesError('Could not generate location links')
    }
    setScopesBusy(false)
    return result
  }

  // The one-click "Separate per location" button on a campaign tile. Opens the
  // Location links panel and generates in the same click — the separate
  // menu → panel → Generate steps were three clicks for the only thing anyone
  // opens that panel to do. Safe to press any time: generation is idempotent, so
  // on a campaign that is already split it only adds links for locations that
  // gained creatives, and every link already sent keeps working.
  //
  // It also downloads the links sheet straight away when a contact sheet is on
  // file (design lead: one button, nothing to hunt for). The panel still opens
  // behind it for anyone who wants to copy a single link or check statuses.
  async function separateByLocation(campaign: AdviewerCampaign) {
    setScopePanel(campaign)
    setScopes([])
    const [stored, links] = await Promise.all([loadContacts(), generateScopes(campaign.id)])
    if (stored && links && links.length > 0) downloadContactsSheet(campaign, stored.rows, links)
  }

  async function patchScope(campaignId: string, patch: { scopeId: string; status?: AdviewerStatus; markSent?: boolean; closedNote?: string | null }) {
    setScopesBusy(true)
    // Clear on entry like its siblings do — otherwise a banner from an earlier
    // failure sits there through every later success.
    setScopesError(null)
    try {
      const res = await fetch(`/api/adviewer/campaign/${campaignId}/scopes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await res.json() as { scopes?: AdviewerCampaignScope[]; error?: string }
      if (!res.ok) setScopesError(body.error ?? 'Could not update this location')
      else setScopes(body.scopes ?? [])
    } catch {
      setScopesError('Could not update this location')
    }
    setScopesBusy(false)
  }

  const copyScopeLink = useCallback((token: string) => {
    void navigator.clipboard.writeText(`${baseUrl}/adviewer/c/${token}`)
    setCopiedScope(token)
    setTimeout(() => setCopiedScope((t) => t === token ? null : t), 2000)
  }, [baseUrl])

  const copyLink = useCallback((token: string, isCampaign = false) => {
    const url = isCampaign ? `${baseUrl}/adviewer/c/${token}` : `${baseUrl}/adviewer/${token}`
    void navigator.clipboard.writeText(url)
    setCopied(token)
    setTimeout(() => setCopied((c) => c === token ? null : c), 2000)
  }, [baseUrl])

  // Unresolved client pins across a campaign's cards + files. Mirrors the
  // card-feedback route's dedup: when a card has per-size file_pins, its flat
  // `pins` is the union of those, so count file_pins only to avoid double-counting.
  const openPinCount = useCallback((c: AdviewerCampaign): number => {
    let n = 0
    for (const cc of c.campaign_cards ?? []) {
      const notes = cc.client_notes
      if (!notes) continue
      const resolved = new Set(notes.resolved_pins ?? [])
      const filePins = notes.file_pins ?? {}
      if (Object.keys(filePins).length > 0) {
        for (const arr of Object.values(filePins)) {
          n += (arr ?? []).filter(p => !resolved.has(p.id)).length
        }
      } else {
        n += (notes.pins ?? []).filter(p => !resolved.has(p.id)).length
      }
    }
    for (const f of c.campaign_files ?? []) {
      n += (f.client_notes?.pins ?? []).length
    }
    return n
  }, [])

  // A campaign belongs in the Locations view when its per-location links either
  // already exist or can now be generated. Archived is not disqualifying here —
  // it is the normal state for an approved campaign, and it is exactly the state
  // the links are minted in.
  const isLocationCampaign = useCallback((c: AdviewerCampaign) => {
    if ((c.scopes?.length ?? 0) > 0) return true
    // Status deliberately not checked. Generating links no longer waits on
    // corporate, so this view has to show a campaign BEFORE it is approved —
    // otherwise the one place the Location links panel lives is the one place
    // you cannot reach until the thing you were trying to skip has happened.
    return (c.campaign_cards ?? []).some(cc => cc.card?.archived !== true && cc.card?.atlas_location_id)
  }, [])

  const filteredCampaigns = useMemo(() => {
    // Every other view hides archived campaigns — they have been filed into the
    // Lookbook and are finished. Locations is the exception, by design.
    let list = statusFilter === 'locations'
      ? campaigns.filter(isLocationCampaign)
      : campaigns.filter(c => !c.archived)
    if (selectedClientId) list = list.filter(c => c.client_id === selectedClientId)
    if (statusFilter !== 'all' && statusFilter !== 'locations') list = list.filter(c => c.status === statusFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c => c.title.toLowerCase().includes(q) || (c.client?.name ?? '').toLowerCase().includes(q))
    }
    // Atlas (location-split) campaigns first so the Separate per location button is
    // never buried in a long grid; then needs_revision first as before.
    return [...list].sort((a, b) =>
      (Number(isLocationCampaign(b)) - Number(isLocationCampaign(a))) || (STATUS_RANK[a.status] - STATUS_RANK[b.status]))
  }, [campaigns, selectedClientId, statusFilter, search, isLocationCampaign])

  // Counts per status for the filter chips (respects client + search, ignores the status filter itself).
  const statusCounts = useMemo(() => {
    const base = campaigns.filter(c => !c.archived)
      .filter(c => !selectedClientId || c.client_id === selectedClientId)
      .filter(c => {
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return c.title.toLowerCase().includes(q) || (c.client?.name ?? '').toLowerCase().includes(q)
      })
    // Counted over ALL campaigns, archived included — see isLocationCampaign.
    const locationBase = campaigns
      .filter(isLocationCampaign)
      .filter(c => !selectedClientId || c.client_id === selectedClientId)
    return {
      all: base.length,
      needs_revision: base.filter(c => c.status === 'needs_revision').length,
      pending: base.filter(c => c.status === 'pending').length,
      approved: base.filter(c => c.status === 'approved').length,
      locations: locationBase.length,
    }
  }, [campaigns, selectedClientId, search, isLocationCampaign])


  const clientForId = useCallback((id: string | null) => clients.find((c) => c.id === id), [clients])

  // Dropzone + per-file Display/Social toggle + FB copy fields. Shared verbatim by the
  // New Campaign modal and the Add Creative modal so the two upload UIs never drift.
  function renderUploadSection() {
    return (
      <div>
        <label className="text-[11px] text-white/40 uppercase tracking-wider font-medium block mb-1.5">
          Upload Files <span className="text-white/20 normal-case font-normal">— display assets or social specs; toggle each below ({uploadQueue.length} queued)</span>
        </label>
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFilesToQueue(e.dataTransfer.files) }}
          onClick={() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = 'image/gif,image/png,image/jpeg,image/webp,video/mp4,video/quicktime,.mp4,.mov'; i.onchange = (ev) => { const f = (ev.target as HTMLInputElement).files; if (f) addFilesToQueue(f) }; i.click() }}
          className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all ${dragOver ? 'border-[#7c3aed] bg-[#7c3aed]/10' : 'border-white/10 hover:border-white/25 hover:bg-white/[0.03]'}`}
        >
          <svg className="w-6 h-6 text-white/20 mx-auto mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <p className="text-xs text-white/30">Drop files or click to browse</p>
          <p className="text-[10px] text-white/15 mt-1">GIF · PNG · JPG · MP4 · MOV</p>
        </div>

        {/* File queue */}
        {uploadQueue.length > 0 && (
          <div className="mt-2 space-y-2">
            {uploadQueue.map((q, i) => (
              <div key={i} className="rounded-lg bg-white/[0.04] border border-white/[0.08] p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-cyan-400 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909" />
                  </svg>
                  <span className="text-[12px] text-white/60 truncate flex-1">{q.file.name}</span>
                  <span className="text-[10px] text-white/25 flex-none">{(q.file.size / 1024).toFixed(0)} KB</span>
                  <button onClick={() => setUploadQueue(prev => prev.filter((_, j) => j !== i))}
                    className="text-white/20 hover:text-rose-400 transition-colors flex-none text-xs">✕</button>
                </div>

                {/* Display / Social toggle */}
                <div className="flex items-center gap-1 bg-white/[0.04] rounded-lg p-0.5 w-max">
                  {(['display', 'social'] as const).map(mode => (
                    <button key={mode} type="button" onClick={() => updateQueueItem(i, { renderMode: mode })}
                      className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors ${q.renderMode === mode ? 'bg-[#7c3aed] text-white' : 'text-white/40 hover:text-white/70'}`}>
                      {mode === 'display' ? 'Display' : 'Social'}
                    </button>
                  ))}
                </div>

                {/* Social copy fields — each with a persistent label */}
                {q.renderMode === 'social' && (
                  <div className="space-y-2 pt-0.5">
                    <div>
                      <label className="block text-[10px] text-white/40 uppercase tracking-wider font-medium mb-0.5">Page name</label>
                      <input type="text" value={q.fbPageName} onChange={e => updateQueueItem(i, { fbPageName: e.target.value })} placeholder="Defaults to client"
                        className="w-full text-[12px] bg-white/[0.06] border border-white/15 rounded-lg px-2.5 py-1.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/40 uppercase tracking-wider font-medium mb-0.5">Primary text</label>
                      <textarea value={q.fbBodyText} onChange={e => updateQueueItem(i, { fbBodyText: e.target.value })} placeholder="Caption shown above the creative" rows={2}
                        className="w-full text-[12px] bg-white/[0.06] border border-white/15 rounded-lg px-2.5 py-1.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60 resize-none" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/40 uppercase tracking-wider font-medium mb-0.5">Headline</label>
                      <input type="text" value={q.fbHeadline} onChange={e => updateQueueItem(i, { fbHeadline: e.target.value })} placeholder="Bold text under the creative"
                        className="w-full text-[12px] bg-white/[0.06] border border-white/15 rounded-lg px-2.5 py-1.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/40 uppercase tracking-wider font-medium mb-0.5">Sub-headline</label>
                      <input type="text" value={q.fbSubheadline} onChange={e => updateQueueItem(i, { fbSubheadline: e.target.value })} placeholder="Line under the headline"
                        className="w-full text-[12px] bg-white/[0.06] border border-white/15 rounded-lg px-2.5 py-1.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/40 uppercase tracking-wider font-medium mb-0.5">Landing page URL</label>
                      <input type="url" value={q.landingPageUrl} onChange={e => updateQueueItem(i, { landingPageUrl: e.target.value })} placeholder="https://…"
                        className="w-full text-[12px] bg-white/[0.06] border border-white/15 rounded-lg px-2.5 py-1.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60" />
                    </div>
                    <div>
                      <label className="block text-[10px] text-white/40 uppercase tracking-wider font-medium mb-0.5">CTA button</label>
                      <select value={q.fbCta} onChange={e => updateQueueItem(i, { fbCta: e.target.value })}
                        className="w-full text-[12px] bg-white/[0.06] border border-white/15 rounded-lg px-2.5 py-1.5 text-white focus:outline-none focus:border-[#7c3aed]/60 appearance-none">
                        {FB_CTA_OPTIONS.map(cta => <option key={cta} value={cta}>{cta}</option>)}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="relative min-h-screen flex flex-col" style={{ background: 'radial-gradient(ellipse 120% 90% at 50% 60%, #12101a 0%, #0d0d11 55%, #0a0a0e 100%)' }}>
      <ParticleBackground />

      {/* Top nav */}
      <header className="sticky top-0 z-20 border-b border-white/[0.07]" style={{ background: 'rgba(13,13,17,0.85)', backdropFilter: 'blur(16px)' }}>
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center gap-4">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-none" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
            <span className="text-white font-black text-[10px] tracking-tight">FTE</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white leading-tight">Adviewer</p>
            <p className="text-[10px] text-white/30 uppercase tracking-widest">Follow The Eyes</p>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search previews…"
            className="w-56 text-xs bg-white/[0.06] border border-white/10 rounded-lg px-3 py-1.5 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60"
          />
          <button
            onClick={() => openCreateCampaign()}
            className="flex items-center gap-1.5 text-xs font-semibold text-white px-3 py-1.5 rounded-lg"
            style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Campaign
          </button>
          <button onClick={handleSignOut} className="flex items-center gap-1.5 text-xs font-medium text-white/70 hover:text-white px-3 py-1.5 rounded-lg border border-white/15 hover:border-white/30 transition-all">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75" />
            </svg>
            Sign out
          </button>
        </div>
      </header>

      <div className="relative z-10 flex flex-1 max-w-7xl mx-auto w-full px-5 py-6 gap-6">
        {/* Sidebar — draggable sections */}
        <aside className="w-52 flex-none">
          <DragDropContext onDragEnd={handleSidebarDragEnd}>
            <Droppable droppableId="sidebar" direction="vertical">
              {provided => (
                <div ref={provided.innerRef} {...provided.droppableProps} className="flex flex-col gap-3">
                  {sidebarOrder.map((section, index) => (
                    <Draggable key={section} draggableId={section} index={index}>
                      {(drag, snapshot) => (
                        <div
                          ref={drag.innerRef}
                          {...drag.draggableProps}
                          {...drag.dragHandleProps}
                          style={{ ...drag.draggableProps.style, opacity: snapshot.isDragging ? 0.85 : 1 }}
                        >
                          {section === 'clients' && (
                            <div className="p-px rounded-2xl bg-gradient-to-br from-violet-500/40 via-white/[0.06] to-cyan-500/30">
                              <div className="bg-white/[0.04] rounded-2xl p-3 flex flex-col gap-2 backdrop-blur-sm">
                                <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest px-1 pt-1">Clients</p>
                                <input
                                  type="text"
                                  value={clientSearch}
                                  onChange={e => setClientSearch(e.target.value)}
                                  placeholder="Search clients..."
                                  className="w-full bg-white/[0.06] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white placeholder-white/30 outline-none focus:border-white/20 transition-colors"
                                />
                                <select
                                  value={selectedClientId ?? ''}
                                  onChange={e => startTransition(() => setSelectedClientId(e.target.value || null))}
                                  className="w-full bg-white/[0.06] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-white/20 transition-colors appearance-none cursor-pointer"
                                >
                                  <option value="">All clients ({campaigns.length})</option>
                                  {clients
                                    .filter(c => !clientSearch || c.name.toLowerCase().includes(clientSearch.toLowerCase()))
                                    .map(c => {
                                      const count = campaigns.filter(camp => camp.client_id === c.id).length
                                      return (
                                        <option key={c.id} value={c.id}>
                                          {c.name}{count > 0 ? ` (${count})` : ''}
                                        </option>
                                      )
                                    })
                                  }
                                </select>
                                {selectedClientId && (
                                  <button
                                    onClick={() => { startTransition(() => setSelectedClientId(null)); setClientSearch('') }}
                                    className="text-[10px] text-white/40 hover:text-white/70 transition-colors text-left"
                                  >
                                    ✕ Clear filter
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                          {section === 'lookbook' && (
                            <div className="p-px rounded-2xl bg-gradient-to-br from-violet-500/40 via-white/[0.06] to-cyan-500/30">
                              <div className="bg-white/[0.04] rounded-2xl p-3 backdrop-blur-sm">
                                <p className="text-[10px] font-semibold text-white/30 uppercase tracking-widest px-1 pt-1 mb-2">Lookbook</p>
                                <Link href="/adviewer/lookbook" className="flex items-center gap-1.5 text-xs font-medium text-white/70 hover:text-white w-full px-3 py-1.5 rounded-lg bg-white/[0.06] border border-white/[0.08] hover:bg-white/10 transition-colors">
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                                  </svg>
                                  Open Lookbook
                                </Link>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        </aside>

        {/* Main */}
        <main className="flex-1 min-w-0">
          {/* ── Status filter ── */}
          <div className="flex items-center gap-1.5 mb-3">
            {([
              ['all', 'All', statusCounts.all],
              ['needs_revision', 'Needs Revision', statusCounts.needs_revision],
              ['pending', 'Pending', statusCounts.pending],
              ['approved', 'Approved', statusCounts.approved],
              ['locations', 'Locations', statusCounts.locations],
            ] as const).map(([value, label, count]) => (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                className={`flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                  statusFilter === value
                    ? 'bg-white/[0.1] border-white/20 text-white'
                    : 'bg-white/[0.03] border-white/[0.06] text-white/45 hover:text-white/70 hover:bg-white/[0.06]'
                }`}
              >
                {label}
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                  value === 'needs_revision' && count > 0 ? 'bg-rose-400/20 text-rose-300' : 'bg-white/[0.08] text-white/40'
                }`}>
                  {count}
                </span>
              </button>
            ))}
          </div>
          {/* Approving a campaign files it into the Lookbook, which is also when
              its location links become available — so this one view has to say
              out loud that it is showing filed campaigns on purpose. */}
          {statusFilter === 'locations' && (
            <p className="text-[11px] text-white/35 mb-3 -mt-1">
              Campaigns whose creatives are split by location, approved or not. Filed campaigns are included too, since
              approving a campaign files it.
            </p>
          )}
          {/* ── Campaigns ── */}
          {filteredCampaigns.length === 0 ? (
              <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-12 text-center">
                {statusFilter === 'locations' ? (
                  <>
                    <p className="text-sm font-medium text-white/40 mb-1">Nothing to split by location</p>
                    <p className="text-xs text-white/20">A campaign shows here once it is approved and its creatives carry Atlas locations.</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-white/40 mb-1">No campaigns yet</p>
                    <p className="text-xs text-white/20">Use the New Campaign button above to get started</p>
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filteredCampaigns.map(c => {
                  // Archived cards are still listed below (greyed) but are filtered
                  // out of the client review, so the tile says how many of the links
                  // the client actually sees.
                  const allCards = c.campaign_cards ?? []
                  const allFiles = c.campaign_files ?? []
                  const liveCount = allCards.filter(cc => cc.card?.archived !== true).length
                  const archivedCount = allCards.length - liveCount
                  const totalItems = allCards.length + allFiles.length
                  // Cards first, then uploaded files — the same order the two
                  // lists used to render in, so the tile's top rows don't move.
                  const tileRows: TileRow[] = [
                    ...allCards.map(cc => {
                      const isArchived = cc.card?.archived === true
                      return {
                        key: `card-${cc.id}`,
                        dot: isArchived ? 'bg-white/10' : cc.status === 'approved' ? 'bg-emerald-400' : cc.status === 'needs_revision' ? 'bg-amber-400' : 'bg-white/20',
                        label: cc.card?.title ?? 'Untitled',
                        archived: isArchived,
                        type: cc.card?.media_type ?? null,
                      }
                    }),
                    ...allFiles.map(f => ({
                      key: `file-${f.id}`,
                      dot: f.status === 'approved' ? 'bg-emerald-400' : f.status === 'needs_revision' ? 'bg-amber-400' : 'bg-cyan-400/50',
                      label: f.file_name,
                      archived: false,
                      type: 'Display',
                    })),
                  ]
                  const visibleRows = tileRows.slice(0, TILE_PREVIEW_ROWS)
                  const hiddenRows = tileRows.length - visibleRows.length
                  const clientName = c.client?.name ?? '—'
                  const pins = openPinCount(c)
                  return (
                    <div key={c.id} className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-4 flex flex-col gap-3 hover:bg-white/[0.07] transition-colors">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#7c3aed]/40 to-[#06b6d4]/40 flex items-center justify-center flex-none">
                          <span className="text-[10px] font-bold text-white/70">{initials(clientName)}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-white truncate leading-tight">{c.title}</p>
                          <p className="text-[10px] text-white/35 truncate">{clientName}</p>
                        </div>
                        {pins > 0 && (
                          <span className="flex-none flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-400/15 text-amber-300 border border-amber-400/25" title={`${pins} open change ${pins === 1 ? 'request' : 'requests'}`}>
                            <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                              <path d="M10 2a5 5 0 00-5 5c0 2.5 1.5 3.5 2 6h6c.5-2.5 2-3.5 2-6a5 5 0 00-5-5z" />
                              <path d="M7 15h6v1a1 1 0 01-1 1H8a1 1 0 01-1-1v-1z" />
                            </svg>
                            {pins}
                          </span>
                        )}
                        <span className={`flex-none text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[c.status]}`}>
                          {STATUS_LABEL[c.status]}
                        </span>
                      </div>
                      {/* Count line, always rendered — it is what replaces the
                          full list as the "how big is this campaign" signal, and
                          rendering it unconditionally keeps every tile the same
                          height. When cards have been archived it keeps saying so:
                          staff need to know the client sees fewer than the total. */}
                      <p className="text-[10px] text-white/25 -mt-1">
                        {archivedCount > 0
                          ? `${liveCount} shown to client · ${archivedCount} archived`
                          : `${totalItems} ${totalItems === 1 ? 'creative' : 'creatives'}`}
                      </p>
                      {/* Creative list — capped at TILE_PREVIEW_ROWS. Archived cards
                          are still listed (greyed, struck) when they fall inside the
                          cap: staff need to see that a creative was pulled from this
                          campaign. The full list, archived rows included, is on the
                          campaign itself via Open. */}
                      <div className={`space-y-1 ${TILE_LIST_MIN_H}`}>
                        {visibleRows.map(row => (
                          <div key={row.key} className={`flex items-center gap-2 h-4 text-[11px] ${row.archived ? 'text-white/20' : 'text-white/40'}`}>
                            <div className={`w-1.5 h-1.5 rounded-full flex-none ${row.dot}`} />
                            <span className={`truncate ${row.archived ? 'line-through' : ''}`}>{row.label}</span>
                            {row.archived && <span className="flex-none text-[9px] font-semibold uppercase tracking-wide px-1.5 py-px rounded bg-white/[0.06] text-white/30 border border-white/10" title="Archived on the board — hidden from the client review">Archived</span>}
                            {row.type && <span className="text-white/20 flex-none">{row.type}</span>}
                          </div>
                        ))}
                        {hiddenRows > 0 && (
                          <p className="pl-3.5 h-4 leading-4 text-[11px] text-white/25">+{hiddenRows} more</p>
                        )}
                      </div>
                      {/* Only on campaigns with creatives tied to an Atlas location — nothing
                          else can be split. Label flips once links exist; the click does
                          the same safe thing either way (see separateByLocation). */}
                      {(c.campaign_cards ?? []).some(cc => cc.card?.archived !== true && cc.card?.atlas_location_id) && (
                        <button
                          onClick={() => void separateByLocation(c)}
                          className="mt-auto w-full text-xs font-semibold py-1.5 rounded-lg text-white transition-opacity hover:opacity-90"
                          style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
                        >
                          Separate per location
                          {(c.scopes?.length ?? 0) > 0 && (
                            <span className="block text-[10px] font-normal text-white/75">{c.scopes?.length} location links · downloads the sheet</span>
                          )}
                        </button>
                      )}
                      <div className={`flex items-center gap-2 pt-1 ${(c.campaign_cards ?? []).some(cc => cc.card?.archived !== true && cc.card?.atlas_location_id) ? '' : 'mt-auto'}`}>
                        <a href={`${baseUrl}/adviewer/c/${c.token}`} target="_blank" rel="noopener noreferrer"
                          className="flex-1 text-center text-xs font-medium py-1.5 rounded-lg bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10 transition-colors">
                          Open
                        </a>
                        <button onClick={() => copyLink(c.token, true)}
                          className="flex-1 text-center text-xs font-medium py-1.5 rounded-lg transition-colors"
                          style={copied === c.token ? { background: 'rgba(16,185,129,0.15)', color: 'rgb(52,211,153)' } : { background: 'rgba(124,58,237,0.15)', color: 'rgba(167,139,250,1)' }}>
                          {copied === c.token ? '✓ Copied' : 'Copy link'}
                        </button>
                        {/* Add creative — staff-tier (its upload/sign + campaign-file routes are requireWriter, broad staff). This dashboard is staff-only: page.tsx redirects adviewer_clients accounts to /adviewer/projects, so every viewer is staff and sees it, matching the ungated reset/delete controls below. */}
                        <button onClick={() => openAddCreative(c.id)} title="Add creative"
                          className="w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-cyan-400 hover:bg-cyan-400/10 transition-colors flex-none">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                          </svg>
                        </button>
                        {c.status !== 'pending' && (
                          <button onClick={() => void resetCampaign(c.id)} disabled={resetting === c.id} title="Clear pins & reset to pending"
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-amber-400 hover:bg-amber-400/10 transition-colors flex-none disabled:opacity-40">
                            {resetting === c.id ? <span className="text-[10px]">…</span> : (
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                              </svg>
                            )}
                          </button>
                        )}
                        <div className="relative flex-none">
                          <button
                            onClick={() => setMenuOpen(menuOpen === c.id ? null : c.id)}
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-white/60 hover:bg-white/10 transition-colors"
                            title="Edit campaign"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                            </svg>
                          </button>
                          {menuOpen === c.id && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)} />
                              <div className="absolute right-0 bottom-10 z-20 w-44 rounded-xl border border-white/10 overflow-hidden shadow-2xl" style={{ background: 'rgba(18,16,26,0.97)', backdropFilter: 'blur(12px)' }}>
                                <button
                                  onClick={() => { setMenuOpen(null); void archiveCampaign(c.id) }}
                                  disabled={archiving === c.id}
                                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-40"
                                >
                                  <svg className="w-3.5 h-3.5 text-cyan-400/70 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                                  </svg>
                                  Send to Lookbook
                                </button>
                                {c.status !== 'pending' && (
                                  <>
                                    <div className="h-px bg-white/[0.06]" />
                                    <button
                                      onClick={() => { setMenuOpen(null); void resetCampaign(c.id) }}
                                      disabled={resetting === c.id}
                                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-amber-300 hover:text-amber-200 hover:bg-amber-400/10 transition-colors disabled:opacity-40"
                                    >
                                      <svg className="w-3.5 h-3.5 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                                      </svg>
                                      Clear pins &amp; reset to pending
                                    </button>
                                  </>
                                )}
                                <div className="h-px bg-white/[0.06]" />
                                <button
                                  onClick={() => { setMenuOpen(null); void openScopePanel(c) }}
                                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors"
                                >
                                  <svg className="w-3.5 h-3.5 text-cyan-400/70 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
                                  </svg>
                                  Location links
                                </button>
                                <div className="h-px bg-white/[0.06]" />
                                <button
                                  onClick={() => { setMenuOpen(null); setDeleteConfirm(c.id) }}
                                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-400/10 transition-colors"
                                >
                                  <svg className="w-3.5 h-3.5 flex-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
        </main>
      </div>

      {/* ── New Campaign modal ── */}
      {showCreateCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-lg rounded-2xl border border-white/15 p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto" style={{ background: 'rgba(18,16,26,0.97)' }}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">New Campaign</h2>
              <button onClick={() => setShowCreateCampaign(false)} className="text-white/30 hover:text-white text-lg leading-none">✕</button>
            </div>

            {/* Campaign name */}
            <div>
              <label className="text-[11px] text-white/40 uppercase tracking-wider font-medium block mb-1.5">Campaign name</label>
              <input type="text" value={campaignTitle} onChange={e => setCampaignTitle(e.target.value)} placeholder="e.g. July 2026"
                className="w-full text-sm bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2 text-white placeholder-white/25 focus:outline-none focus:border-[#7c3aed]/60" />
            </div>

            {/* Client */}
            <div>
              <label className="text-[11px] text-white/40 uppercase tracking-wider font-medium block mb-1.5">Client</label>
              <select value={campaignClientId} onChange={e => { setCampaignClientId(e.target.value); setSelectedCardIds([]); setClientCards([]); if (e.target.value) void fetchCardsForClient(e.target.value) }}
                className="w-full text-sm bg-white/[0.06] border border-white/15 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-[#7c3aed]/60 appearance-none">
                <option value="">Select a client…</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {/* Board cards (optional) */}
            <div>
              <label className="text-[11px] text-white/40 uppercase tracking-wider font-medium block mb-1.5">
                Board Cards <span className="text-white/20 normal-case font-normal">— optional ({selectedCardIds.length} selected)</span>
              </label>
              {loadingCards ? (
                <div className="text-sm text-white/30 py-2">Loading cards…</div>
              ) : clientCards.length === 0 ? (
                <div className="text-xs text-white/20 py-2 italic">{campaignClientId ? 'No board cards for this client' : 'Select a client to see their board cards'}</div>
              ) : (
                <div className="max-h-36 overflow-y-auto space-y-1 border border-white/10 rounded-lg p-2 bg-white/[0.02]">
                  {clientCards.map(card => {
                    const selected = selectedCardIds.includes(card.id)
                    return (
                      <button key={card.id} onClick={() => toggleCardSelection(card.id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all ${selected ? 'bg-[#7c3aed]/20 border border-[#7c3aed]/40' : 'hover:bg-white/[0.05] border border-transparent'}`}>
                        <div className={`w-4 h-4 rounded flex items-center justify-center flex-none border ${selected ? 'bg-[#7c3aed] border-[#7c3aed]' : 'border-white/20'}`}>
                          {selected && <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                        </div>
                        <div className="min-w-0">
                          <p className="text-[12px] font-medium text-white truncate">{card.title}</p>
                          {card.media_type && <p className="text-[10px] text-white/30">{card.media_type}</p>}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Direct file upload (optional) */}
            {renderUploadSection()}

            {uploadError && (
              <p className="text-xs text-rose-400 bg-rose-400/10 border border-rose-400/20 rounded-lg px-3 py-2">{uploadError}</p>
            )}
            <div className="flex gap-2 pt-1">
              <button
                onClick={handleCreateCampaign}
                disabled={!campaignTitle.trim() || !campaignClientId || (selectedCardIds.length === 0 && uploadQueue.length === 0) || creatingCampaign}
                className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white disabled:opacity-40 transition-opacity"
                style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
                {uploadingFiles ? `Uploading files…` : creatingCampaign ? 'Creating…' : `Create Campaign (${selectedCardIds.length + uploadQueue.length} creatives)`}
              </button>
              <button onClick={() => setShowCreateCampaign(false)} className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Creative modal ── */}
      {addCreativeCampaignId && (() => {
        const campaign = campaigns.find(c => c.id === addCreativeCampaignId)
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
            <div className="w-full max-w-lg rounded-2xl border border-white/15 p-6 flex flex-col gap-4 max-h-[90vh] overflow-y-auto" style={{ background: 'rgba(18,16,26,0.97)' }}>
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-white">Add creative</h2>
                  <p className="text-[11px] text-white/35 truncate">{campaign?.title ?? 'Campaign'}{campaign?.client?.name ? ` · ${campaign.client.name}` : ''}</p>
                </div>
                <button onClick={() => setAddCreativeCampaignId(null)} className="text-white/30 hover:text-white text-lg leading-none flex-none">✕</button>
              </div>

              {renderUploadSection()}

              {uploadError && (
                <p className="text-xs text-rose-400 bg-rose-400/10 border border-rose-400/20 rounded-lg px-3 py-2 break-words">{uploadError}</p>
              )}
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleAddCreative}
                  disabled={uploadQueue.length === 0 || addingCreative}
                  className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white disabled:opacity-40 transition-opacity"
                  style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
                  {addingCreative ? 'Uploading…' : `Add ${uploadQueue.length} creative${uploadQueue.length === 1 ? '' : 's'}`}
                </button>
                <button onClick={() => setAddCreativeCampaignId(null)} className="px-4 text-sm font-medium text-white/50 hover:text-white bg-white/[0.06] rounded-xl transition-colors">Cancel</button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Delete confirm */}
      {scopePanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-2xl max-h-[85vh] rounded-2xl border border-white/10 flex flex-col" style={{ background: 'rgba(18,16,26,0.98)' }}>
            <div className="flex items-start justify-between gap-4 p-6 pb-4 border-b border-white/[0.08]">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-white">Location links</h2>
                <p className="text-sm text-white/40 mt-1 truncate">{scopePanel.title}</p>
                <p className="text-xs text-white/30 mt-2">
                  One link per location, each showing only that location&apos;s creatives. <b className="text-white/50">Download sheet</b> gives you the contact list with each location&apos;s link filled in, ready to send to the team. A location can leave notes on the link or just email you back; both are fine.
                </p>
              </div>
              <button onClick={() => setScopePanel(null)} className="flex-none w-8 h-8 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Contact sheet — upload once, download per campaign with links filled in. */}
            <div className="mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
              <p className="flex-1 min-w-[180px] text-[11px] text-white/45">
                {contacts
                  ? <>Contacts: <span className="text-white/70">{contacts.fileName}</span> · {contacts.rows.length} rows · uploaded {new Date(contacts.uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</>
                  : 'No contact sheet yet — upload the location contact list (Location, Name, Email).'}
              </p>
              <label className={`text-xs font-medium px-3 py-1.5 rounded-lg border border-white/15 text-white/70 hover:text-white hover:border-white/30 transition-colors ${contactsBusy ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}`}>
                {contactsBusy ? 'Reading…' : contacts ? 'Replace sheet' : 'Upload contacts sheet'}
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadContacts(f) }} />
              </label>
              <button
                onClick={() => downloadContactsSheet(scopePanel)}
                disabled={scopes.length === 0}
                title={scopes.length === 0 ? 'Generate the location links first' : 'Download the contact list with each location’s review link'}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white disabled:opacity-35 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
              >
                Download sheet
              </button>
              {contactsError && <p className="w-full text-[11px] text-rose-300">{contactsError}</p>}
            </div>

            {scopesError && (
              <p className="mx-6 mt-4 text-xs text-rose-300 bg-rose-400/10 border border-rose-400/20 rounded-lg px-3 py-2">{scopesError}</p>
            )}

            <div className="flex-1 overflow-y-auto p-6 pt-4 space-y-2">
              {scopes.length === 0 && !scopesBusy && !scopesError && (
                <p className="text-xs text-white/30 py-6 text-center">
                  No location links yet. Generating them splits this campaign by the location on each card.
                </p>
              )}
              {scopes.map(sc => (
                <div key={sc.id} className="space-y-2">
                <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-white truncate">{sc.atlas_location?.name ?? 'Unknown location'}</p>
                    <p className="text-[10px] text-white/30 truncate">
                      {sc.sent_at ? `Sent ${new Date(sc.sent_at).toLocaleDateString()}` : 'Not sent yet'}
                      {sc.closed_note ? ` · ${sc.closed_note}` : ''}
                    </p>
                  </div>
                  <span className={`flex-none text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[sc.status]}`}>
                    {STATUS_LABEL[sc.status]}
                  </span>
                  <button
                    onClick={() => copyScopeLink(sc.token)}
                    className="flex-none text-[11px] font-medium px-2.5 py-1.5 rounded-lg transition-colors"
                    style={copiedScope === sc.token
                      ? { background: 'rgba(16,185,129,0.15)', color: 'rgb(52,211,153)' }
                      : { background: 'rgba(124,58,237,0.15)', color: 'rgba(167,139,250,1)' }}
                  >
                    {copiedScope === sc.token ? '✓ Copied' : 'Copy link'}
                  </button>
                  {/* Marking sent is the only record that this location was ever
                      asked — there is no send flow to infer it from. */}
                  {!sc.sent_at && (
                    <button
                      onClick={() => void patchScope(scopePanel.id, { scopeId: sc.id, markSent: true })}
                      disabled={scopesBusy}
                      className="flex-none text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-white/[0.06] text-white/50 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
                    >
                      Mark sent
                    </button>
                  )}
                  {/* Closing on the location's behalf is the normal path when
                      changes arrive by email rather than through Adviewer. */}
                  {sc.status !== 'approved' && (
                    <button
                      onClick={() => { setClosingScopeId(sc.id); setCloseNote(sc.closed_note ?? '') }}
                      disabled={scopesBusy}
                      className="flex-none text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-emerald-400/10 text-emerald-300/80 hover:text-emerald-200 hover:bg-emerald-400/15 transition-colors disabled:opacity-40"
                      title="Record that this location signed off, including by email"
                    >
                      Close
                    </button>
                  )}
                </div>
                {closingScopeId === sc.id && (
                  <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] px-3 py-2.5 space-y-2">
                    <p className="text-[10px] text-white/40">
                      What did they say, and how? This is the only record of an approval that came in off-platform.
                    </p>
                    <input
                      autoFocus
                      value={closeNote}
                      onChange={e => setCloseNote(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') setClosingScopeId(null) }}
                      placeholder="e.g. Approved by email — Maria, no changes"
                      className="w-full text-xs bg-white/[0.04] border border-white/10 rounded-lg px-2.5 py-1.5 text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-400/40"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setClosingScopeId(null)}
                        className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg text-white/40 hover:text-white/70 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          const note = closeNote.trim()
                          setClosingScopeId(null)
                          void patchScope(scopePanel.id, {
                            scopeId: sc.id,
                            status: 'approved',
                            // Only fall back to a generic note when nothing was
                            // typed — never overwrite one that is already there.
                            closedNote: note || sc.closed_note || 'Closed by staff',
                          })
                        }}
                        disabled={scopesBusy}
                        className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25 transition-colors disabled:opacity-40"
                      >
                        Record sign-off
                      </button>
                    </div>
                  </div>
                )}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-3 p-6 pt-4 border-t border-white/[0.08]">
              <p className="text-[10px] text-white/25">
                {scopes.length > 0 && scopes.every(sc => sc.status === 'approved') && scopePanel.status !== 'approved'
                  ? 'Every location has approved. Locations never file the campaign themselves — when you are happy, use Approve → Lookbook.'
                  : scopePanel.status === 'approved'
                  ? 'Generating again only adds links for locations that gained creatives. Existing links keep working.'
                  : 'Corporate has not signed off on this campaign yet — generating links anyway is fine, nothing is sent until you hand one over.'}
              </p>
              <button
                onClick={() => void generateScopes(scopePanel.id)}
                disabled={scopesBusy}
                className="flex-none text-xs font-semibold px-4 py-2 rounded-lg transition-all disabled:opacity-35 disabled:cursor-not-allowed"
                style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)', color: 'white' }}
              >
                {scopesBusy ? 'Working…' : scopes.length > 0 ? 'Refresh links' : 'Generate location links'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }}>
          <div className="w-full max-w-sm rounded-2xl border border-rose-500/25 p-6 flex flex-col gap-4" style={{ background: 'rgba(18,16,26,0.98)' }}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-rose-500/15 flex items-center justify-center flex-none mt-0.5">
                <svg className="w-5 h-5 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              </div>
              <div>
                <h2 className="text-base font-semibold text-white">Permanently delete this campaign?</h2>
                <p className="text-sm text-white/40 mt-1">This cannot be undone. The campaign, all its files, and the shareable link will be gone forever. There is no coming back from this.</p>
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setDeleteConfirm(null)} className="flex-1 text-sm font-medium text-white/60 hover:text-white bg-white/[0.06] hover:bg-white/10 py-2.5 rounded-xl transition-colors">
                Cancel
              </button>
              <button onClick={() => void deleteCampaign(deleteConfirm)}
                className="flex-1 text-sm font-semibold py-2.5 rounded-xl text-white bg-rose-600 hover:bg-rose-500 transition-colors">
                Yes, delete forever
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="relative z-10 border-t border-white/[0.06] py-4">
        <p className="text-[10px] text-white/20 text-center uppercase tracking-widest">Follow The Eyes · {userEmail}</p>
      </footer>
    </div>
  )
}
