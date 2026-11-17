'use client'

// Persists the user's chosen Calendar view (grid / feed / list) in
// localStorage so it sticks across sessions. SSR-safe: returns the default
// on the server, then syncs to the persisted value on first client render
// via useSyncExternalStore so we never have to call setState in an effect.

import { useSyncExternalStore } from 'react'

export type CalendarView = 'grid' | 'feed' | 'list'

const STORAGE_KEY = 'fte-calendar-view'
const DEFAULT_VIEW: CalendarView = 'feed'

function isValid(v: string | null): v is CalendarView {
  return v === 'grid' || v === 'feed' || v === 'list'
}

function getSnapshot(): CalendarView {
  if (typeof window === 'undefined') return DEFAULT_VIEW
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return isValid(raw) ? raw : DEFAULT_VIEW
}

function getServerSnapshot(): CalendarView {
  return DEFAULT_VIEW
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  // The native 'storage' event only fires across tabs. We also dispatch our
  // own CustomEvent so same-tab updates re-run getSnapshot.
  const handler = () => callback()
  window.addEventListener('storage', handler)
  window.addEventListener('fte-calendar-view-changed', handler)
  return () => {
    window.removeEventListener('storage', handler)
    window.removeEventListener('fte-calendar-view-changed', handler)
  }
}

export function useCalendarView(): [CalendarView, (next: CalendarView) => void] {
  const view = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  function setView(next: CalendarView) {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STORAGE_KEY, next)
    window.dispatchEvent(new CustomEvent('fte-calendar-view-changed'))
  }

  return [view, setView]
}
