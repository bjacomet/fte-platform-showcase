'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import type { Client } from '@/types'
import { POST_STYLE_MEDIA_TYPES } from '@/types'
import {
  formatMonth,
  monthShortName,
  nextMonth,
  prevMonth,
} from '@/lib/calendar'
import {
  parseClipboardEvent,
  type ImportRow,
  type ParseSource,
} from '@/lib/calendar-import'

interface Props {
  clients: Client[]
  selectedClientId: string
  year: number
  month: number
  columnId: string
}

const SOURCE_LABEL: Record<ParseSource, string> = {
  html: 'Pasted from a rich-text source · table structure preserved',
  tab: 'Pasted tab-separated text · structured by tabs',
  stream: 'Pasted plain text · structure recovered automatically',
  empty: '',
}

export default function ImportPage({
  clients,
  selectedClientId,
  year,
  month,
  columnId,
}: Props) {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const [rows, setRows] = useState<ImportRow[]>([])
  const [source, setSource] = useState<ParseSource>('empty')
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const activeClient = useMemo(
    () => clients.find((c) => c.id === selectedClientId) ?? clients[0],
    [clients, selectedClientId]
  )

  // Listen for paste anywhere on the page so the user never has to think
  // about where to focus. The handler is non-capturing; native paste inside
  // editable inputs still goes through normally because we only act when
  // the event target isn't already an editable element.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const target = e.target as HTMLElement | null
      if (target) {
        const editable = target.closest('input, textarea, [contenteditable="true"]')
        if (editable) return
      }
      const result = parseClipboardEvent(e, year, month)
      if (result.rows.length === 0) return
      e.preventDefault()
      setRows(result.rows)
      setSource(result.source)
      setErrorMsg(null)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [year, month])

  const validRows = rows.filter((r) => r.isoDate && r.copy)
  const blockingCount = rows.length - validRows.length

  function updateRow(id: string, patch: Partial<ImportRow>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r
        const next = { ...r, ...patch }
        // If date was edited, re-validate inline.
        if (patch.dateInput !== undefined) {
          const trimmed = (patch.dateInput ?? '').trim()
          if (!trimmed) {
            next.isoDate = null
            next.error = 'Missing date'
          } else {
            // Naive: accept anything that parses to a date-like string.
            // The submit path also re-derives flight_month from isoDate, so
            // the user-edited value just has to be ISO-ish.
            const reparsed = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
              ? `${trimmed.slice(0, 10)}`
              : null
            if (reparsed) {
              next.isoDate = reparsed
              next.error = null
            } else {
              // Try month/day/year again.
              const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
              if (slash) {
                const m = String(Number(slash[1])).padStart(2, '0')
                const d = String(Number(slash[2])).padStart(2, '0')
                const yRaw = Number(slash[3])
                const y = yRaw < 100 ? 2000 + yRaw : yRaw
                next.isoDate = `${y}-${m}-${d}`
                next.error = null
              } else {
                next.isoDate = null
                next.error = `Could not parse "${trimmed}"`
              }
            }
          }
        }
        return next
      })
    )
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }

  function clearAll() {
    setRows([])
    setSource('empty')
    setErrorMsg(null)
  }

  async function handleImport() {
    if (validRows.length === 0) return
    setSubmitting(true)
    setErrorMsg(null)

    const abbr =
      activeClient.abbreviation ?? activeClient.name.slice(0, 3).toUpperCase()

    const inserts = validRows.map((r) => {
      const iso = r.isoDate as string
      const monthNum = Number(iso.slice(5, 7))
      const day = Number(iso.slice(8, 10))
      const dateLabel = `${monthShortName(monthNum)} ${day}`
      const preview = r.copy.length > 60 ? `${r.copy.slice(0, 60)}…` : r.copy
      return {
        title: `${abbr}-M${monthNum}-${dateLabel} - ${preview}`,
        client_id: activeClient.id,
        column_id: columnId,
        media_type: r.mediaType,
        position: 0,
        archived: false,
        calendar_only: true,
        flight_start_date: iso,
        flight_month: monthNum,
        fb_body_text: r.copy,
        fb_page_name: activeClient.name,
        creative_brief: r.creative ? `Creative Used: ${r.creative}` : null,
      }
    })

    const { error } = await supabase.from('cards').insert(inserts)
    if (error) {
      setErrorMsg(`Insert failed: ${error.message}`)
      setSubmitting(false)
      return
    }

    setSubmitting(false)
    router.push(
      `/calendar?client=${activeClient.id}&year=${year}&month=${month}`
    )
    router.refresh()
  }

  function navigateTo(overrides: { client?: string; year?: number; month?: number }) {
    const q = new URLSearchParams()
    q.set('client', overrides.client ?? activeClient.id)
    q.set('year', String(overrides.year ?? year))
    q.set('month', String(overrides.month ?? month))
    router.push(`/calendar/import?${q.toString()}`)
  }

  const prev = prevMonth(year, month)
  const next = nextMonth(year, month)
  const initials = activeClient.name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <div className="min-h-screen flex flex-col bg-[#0f1117] text-gray-100">

      {/* Top bar */}
      <div className="px-4 py-3 bg-gray-900 border-b border-gray-700/60 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href={`/calendar?client=${activeClient.id}&year=${year}&month=${month}`}
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            ← Back to calendar
          </Link>
          <span className="text-gray-700">·</span>
          <span className="inline-flex items-center gap-2 pl-1 pr-2.5 py-1 bg-gray-800 border border-gray-600 rounded-full text-xs text-gray-200">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-600 text-[9px] font-semibold text-white">
              {initials}
            </span>
            <span>{activeClient.name}</span>
          </span>
          <select
            value={activeClient.id}
            onChange={(e) => navigateTo({ client: e.target.value })}
            className="bg-gray-800 border border-gray-600 text-gray-200 text-xs rounded-lg px-2 py-1 hover:bg-gray-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Change client"
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-600 rounded-lg px-1 py-0.5">
            <button
              onClick={() => navigateTo({ year: prev.year, month: prev.month })}
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
              onClick={() => navigateTo({ year: next.year, month: next.month })}
              className="px-2 py-1 text-gray-300 hover:text-white hover:bg-gray-700 rounded"
              aria-label="Next month"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
        <button
          onClick={handleImport}
          disabled={submitting || validRows.length === 0}
          className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-medium transition-colors"
        >
          {submitting
            ? 'Importing…'
            : validRows.length > 0
            ? `Import ${validRows.length} post${validRows.length === 1 ? '' : 's'}`
            : 'Import 0 posts'}
        </button>
      </div>

      {/* Page heading */}
      <div className="px-6 py-5 border-b border-gray-800/60">
        <div className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">
          Calendar · {activeClient.name} · {formatMonth(year, month)}
        </div>
        <h1 className="text-lg font-semibold text-white mt-1">Bulk import posts</h1>
        <p className="text-xs text-gray-400 mt-1">
          Just paste your table — we keep the structure. Images get attached later, from the calendar.
        </p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-6">
            <div className="border-0.5 border-dashed border-gray-700 rounded-xl bg-gray-900/40 px-6 py-10 text-center">
              <svg
                width="32"
                height="32"
                fill="none"
                viewBox="0 0 24 24"
                stroke="#6b7280"
                strokeWidth="1.5"
                style={{ display: 'block', margin: '0 auto 8px' }}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-sm font-medium text-gray-200">Paste your content plan</p>
              <p className="text-xs text-gray-500 mt-1">
                Press{' '}
                <kbd className="inline-block px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-[11px] text-gray-300 mx-0.5">⌘V</kbd>
                {' '}or{' '}
                <kbd className="inline-block px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-[11px] text-gray-300 mx-0.5">Ctrl V</kbd>
                {' '}anywhere on this page. From Word, Google Docs, Claude — table structure is preserved.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Source / actions strip */}
            <div className="px-6 py-3 bg-gray-900/40 border-b border-gray-800 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-green-900/30 text-green-300 border border-green-700/40">
                  <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  {SOURCE_LABEL[source]} · {rows.length} row{rows.length === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[11px] text-blue-400 hover:text-blue-300"
                >
                  Replace paste
                </button>
              </div>
              {blockingCount > 0 && (
                <span className="text-[11px] text-amber-300">
                  {blockingCount} row{blockingCount === 1 ? '' : 's'} need fixing before import
                </span>
              )}
            </div>

            {/* The table */}
            <div className="px-6 py-6">
              <h2 className="text-base font-medium text-white mb-3">{formatMonth(year, month)}</h2>
              <div className="border border-gray-700/60 rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-gray-900/60">
                    <tr className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                      <th className="text-left px-3 py-2 w-32">Post Date</th>
                      <th className="text-left px-3 py-2">Copy</th>
                      <th className="text-left px-3 py-2 w-64">Creative Used</th>
                      <th className="text-left px-3 py-2 w-40">Media Type</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700/40">
                    {rows.map((r) => {
                      const bad = !r.isoDate
                      const warn = !!r.isoDate && !!r.error
                      return (
                        <tr
                          key={r.id}
                          className={
                            bad
                              ? 'bg-red-950/20 align-top'
                              : warn
                              ? 'bg-amber-950/15 align-top'
                              : 'align-top'
                          }
                        >
                          <td className="px-3 py-3 text-xs text-gray-300">
                            <input
                              type="text"
                              value={r.isoDate ?? r.dateInput}
                              onChange={(e) => updateRow(r.id, { dateInput: e.target.value })}
                              className="w-full bg-transparent border-0 outline-none text-xs text-gray-200 focus:bg-gray-900 rounded px-1.5 py-0.5"
                            />
                            {r.error && (
                              <div className={`text-[10px] mt-0.5 ${bad ? 'text-red-300' : 'text-amber-300'}`}>
                                {r.error}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-3 text-sm text-gray-200">
                            <textarea
                              value={r.copy}
                              onChange={(e) => updateRow(r.id, { copy: e.target.value })}
                              rows={Math.min(6, Math.max(2, Math.ceil(r.copy.length / 50)))}
                              className="w-full bg-transparent border-0 outline-none text-sm text-gray-200 focus:bg-gray-900 rounded px-1.5 py-1 resize-none leading-relaxed"
                            />
                          </td>
                          <td className="px-3 py-3 text-xs text-gray-400 italic">
                            <textarea
                              value={r.creative}
                              onChange={(e) => updateRow(r.id, { creative: e.target.value })}
                              rows={Math.min(4, Math.max(2, Math.ceil(r.creative.length / 30)))}
                              className="w-full bg-transparent border-0 outline-none text-xs text-gray-300 focus:bg-gray-900 rounded px-1.5 py-1 resize-none leading-relaxed italic"
                            />
                          </td>
                          <td className="px-3 py-3">
                            <select
                              value={r.mediaType}
                              onChange={(e) => updateRow(r.id, { mediaType: e.target.value as ImportRow['mediaType'] })}
                              className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                            >
                              {POST_STYLE_MEDIA_TYPES.map((t) => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-2 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => removeRow(r.id)}
                              className="text-gray-600 hover:text-red-400 transition-colors"
                              aria-label="Remove row"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-gray-500 italic mt-3">
                Click any cell to edit. Press <kbd className="px-1 py-0 bg-gray-800 border border-gray-700 rounded text-[10px]">⌘V</kbd> again to replace these rows with a fresh paste.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Sticky-ish footer */}
      <div className="px-6 py-3 bg-gray-900 border-t border-gray-700/60 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-gray-400">
          {validRows.length > 0
            ? `${validRows.length} of ${rows.length} ready · ${activeClient.name} · ${formatMonth(year, month)}`
            : rows.length === 0
            ? 'Paste a 3-column table above to get started.'
            : `${validRows.length} of ${rows.length} ready`}
        </div>
        <div className="flex items-center gap-2">
          {errorMsg && (
            <span className="text-xs text-red-300 bg-red-950/40 border border-red-800/50 rounded px-2 py-1">
              {errorMsg}
            </span>
          )}
          <button
            onClick={handleImport}
            disabled={submitting || validRows.length === 0}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-medium transition-colors"
          >
            {submitting
              ? 'Importing…'
              : validRows.length > 0
              ? `Import ${validRows.length} post${validRows.length === 1 ? '' : 's'}`
              : 'Import 0 posts'}
          </button>
        </div>
      </div>
    </div>
  )
}
