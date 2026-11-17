'use client'

import { useMemo, useRef, useState } from 'react'
import type { Client } from '@/types'
import type { DuplicatePlanItem, DuplicateResult } from '@/lib/duplicateCards'

interface Props {
  selectedIds: Set<string>
  clients: Client[]
  disabled?: boolean
}

type Phase = 'pick' | 'preview' | 'done'

/**
 * "Duplicate to…" in the board's multi-select bar. Pick clients → preview the
 * exact titles that will be created (dry run, nothing written) → create.
 * The preview step is the point: it is the only place someone sees that the
 * copies arrive with a blank landing page, FB page and files before they exist.
 */
export default function BulkDuplicateMenu({ selectedIds, clients, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('pick')
  const [targets, setTargets] = useState<Set<string>>(() => new Set())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<DuplicatePlanItem[]>([])
  const [result, setResult] = useState<DuplicateResult | null>(null)

  const activeClients = useMemo(
    () =>
      clients
        .filter((c) => c.active)
        .filter((c) => {
          const q = filter.trim().toLowerCase()
          return !q || c.name.toLowerCase().includes(q) || (c.abbreviation ?? '').toLowerCase().includes(q)
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    [clients, filter],
  )

  const reset = () => {
    setPhase('pick')
    setTargets(new Set())
    setFilter('')
    setError(null)
    setPlan([])
    setResult(null)
  }

  const close = () => {
    setOpen(false)
    reset()
  }

  const toggle = (id: string) =>
    setTargets((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Create sends exactly the cards the preview showed, even if the board
  // selection changes while the preview is open.
  const previewedIds = useRef<string[]>([])

  const post = async (dryRun: boolean) => {
    if (dryRun) previewedIds.current = [...selectedIds]
    const res = await fetch('/api/cards/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardIds: previewedIds.current, targetClientIds: [...targets], dryRun }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`)
    return json
  }

  const handlePreview = async () => {
    setBusy(true)
    setError(null)
    try {
      const json = (await post(true)) as { plan: DuplicatePlanItem[] }
      setPlan(json.plan)
      setPhase('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed')
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    setBusy(true)
    setError(null)
    try {
      const json = (await post(false)) as DuplicateResult
      setResult(json)
      setPhase('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Duplicate failed')
    } finally {
      setBusy(false)
    }
  }

  const willCreate = plan.filter((p) => !p.skipReason)

  return (
    <div className="relative">
      <button
        onClick={() => (open ? close() : setOpen(true))}
        disabled={disabled}
        title="Copy the selected cards onto other clients — copy and brief carry over; landing page, Facebook page and files start blank"
        className="rounded-md border border-[#0075a9]/50 bg-[#002a4a] px-2 py-1 text-sm text-white transition-colors hover:bg-[#003a63] disabled:opacity-50"
      >
        ⧉ Duplicate to…
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 mb-3 w-96 -translate-x-1/2 rounded-xl border border-[#0075a9]/60 bg-[#00152a] p-3 text-white shadow-2xl shadow-black/50">
          {phase === 'pick' && (
            <>
              <div className="mb-2 text-sm font-semibold">
                Duplicate {selectedIds.size} card{selectedIds.size === 1 ? '' : 's'} to…
              </div>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter clients"
                className="mb-2 w-full rounded-md border border-[#0075a9]/50 bg-[#002a4a] px-2 py-1 text-sm text-white placeholder:text-white/40 focus:outline-none"
              />
              <div className="max-h-56 overflow-y-auto pr-1">
                {activeClients.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-white/5">
                    <input type="checkbox" checked={targets.has(c.id)} onChange={() => toggle(c.id)} />
                    <span className="truncate">{c.name}</span>
                    {c.abbreviation && <span className="text-xs text-white/40">{c.abbreviation}</span>}
                  </label>
                ))}
                {activeClients.length === 0 && <div className="px-1 py-2 text-xs text-white/50">No matching clients.</div>}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-xs text-white/50">{targets.size} client{targets.size === 1 ? '' : 's'} picked</span>
                <button
                  onClick={handlePreview}
                  disabled={busy || targets.size === 0}
                  className="rounded-md bg-[#0075a9] px-3 py-1 text-sm font-semibold text-white transition-colors hover:bg-[#0088c4] disabled:opacity-50"
                >
                  {busy ? 'Checking…' : 'Preview'}
                </button>
              </div>
            </>
          )}

          {phase === 'preview' && (
            <>
              <div className="mb-1 text-sm font-semibold">
                {willCreate.length} card{willCreate.length === 1 ? '' : 's'} will be created in Queue
              </div>
              <div className="mb-2 text-xs text-white/60">
                Copy and brief carry over. Landing page, Facebook page, files, Box and build links start blank.
              </div>
              <ul className="max-h-56 space-y-1 overflow-y-auto pr-1 text-sm">
                {plan.map((p) => (
                  <li key={`${p.sourceCardId}:${p.targetClientId}`} className={p.skipReason ? 'text-white/40' : ''}>
                    <span className="block truncate" title={p.newTitle}>{p.newTitle}</span>
                    <span className="block truncate text-xs text-white/40">
                      {p.skipReason ? `Skipped — ${p.skipReason}` : `for ${p.targetClientName}, from "${p.sourceTitle}"`}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between gap-2">
                <button onClick={() => setPhase('pick')} disabled={busy} className="text-xs text-white/60 hover:text-white disabled:opacity-50">
                  ← Back
                </button>
                <button
                  onClick={handleCreate}
                  disabled={busy || willCreate.length === 0}
                  className="rounded-md bg-[#0075a9] px-3 py-1 text-sm font-semibold text-white transition-colors hover:bg-[#0088c4] disabled:opacity-50"
                >
                  {busy ? 'Creating…' : `Create ${willCreate.length}`}
                </button>
              </div>
            </>
          )}

          {phase === 'done' && result && (
            <>
              <div className="mb-2 text-sm font-semibold">
                ✓ Created {result.created.length} card{result.created.length === 1 ? '' : 's'} in Queue
              </div>
              {result.errors.length > 0 && (
                <ul className="mb-2 space-y-1 text-xs text-red-400">
                  {result.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              <div className="flex justify-end">
                <button onClick={close} className="rounded-md bg-[#0075a9] px-3 py-1 text-sm font-semibold text-white hover:bg-[#0088c4]">
                  Done
                </button>
              </div>
            </>
          )}

          {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
        </div>
      )}
    </div>
  )
}
