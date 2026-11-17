'use client'

import { useEffect, useRef, useState } from 'react'

// Detects when a newer build has been deployed while this tab stayed open, and
// prompts a reload. This is the structural fix for stale-tab drift: a board tab
// left open for days runs an old JS bundle and can silently diverge from DB truth
// (the root cause of the phantom-duplicate-card issue). We never auto-reload —
// that would discard in-progress edits — we surface a banner the user can act on.
//
// The tab records the build id it loaded with (first successful fetch) and
// re-checks on an interval and whenever the tab regains focus. A version that
// differs from that baseline means a deploy happened after this tab loaded.

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export default function UpdateAvailableBanner() {
  const baselineRef = useRef<string | null>(null)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' })
        if (!res.ok) return
        const { version } = (await res.json()) as { version?: string }
        if (cancelled || !version) return
        if (baselineRef.current === null) {
          baselineRef.current = version // record the version this tab loaded with
          return
        }
        if (version !== baselineRef.current) setUpdateAvailable(true)
      } catch {
        // network blip — ignore, we'll try again on the next tick
      }
    }

    void check()
    const interval = setInterval(() => void check(), POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (!updateAvailable || dismissed) return null

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-full border border-[#38b6ff]/50 bg-[#00152a] px-4 py-2.5 shadow-lg shadow-black/50">
        <span className="text-[13px] text-[#eaf3fc]">
          A new version of the board is available.
        </span>
        <button
          onClick={() => window.location.reload()}
          className="rounded-full bg-gradient-to-r from-[#06b6d4] to-[#7c3aed] px-3 py-1 text-[13px] font-semibold text-white hover:opacity-90"
        >
          Reload
        </button>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="text-gray-400 hover:text-gray-200"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
