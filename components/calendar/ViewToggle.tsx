'use client'

import type { ReactElement } from 'react'
import type { CalendarView } from './useCalendarView'

interface Props {
  value: CalendarView
  onChange: (next: CalendarView) => void
  /** Light variant for the client-share header (white surface). */
  variant?: 'dark' | 'light'
}

interface ViewOption {
  key: CalendarView
  label: string
  icon: ReactElement
}

const OPTIONS: ViewOption[] = [
  {
    key: 'grid',
    label: 'Grid',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h6v6H4zM14 5h6v6h-6zM4 13h6v6H4zM14 13h6v6h-6z" />
      </svg>
    ),
  },
  {
    key: 'feed',
    label: 'Feed',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 5h14M5 12h14M5 19h14" />
      </svg>
    ),
  },
  {
    key: 'list',
    label: 'List',
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
      </svg>
    ),
  },
]

export default function ViewToggle({ value, onChange, variant = 'dark' }: Props) {
  const wrapperClass =
    variant === 'dark'
      ? 'inline-flex bg-gray-800 border border-gray-600 rounded-lg p-0.5'
      : 'inline-flex bg-gray-100 border border-gray-200 rounded-lg p-0.5'

  function buttonClass(active: boolean) {
    if (variant === 'dark') {
      return active
        ? 'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-blue-600 text-white'
        : 'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md text-gray-300 hover:text-white hover:bg-gray-700 transition-colors'
    }
    return active
      ? 'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-[#1877F2] text-white'
      : 'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md text-[#65676B] hover:text-[#050505] hover:bg-white transition-colors'
  }

  return (
    <div className={wrapperClass} role="tablist" aria-label="Calendar view">
      {OPTIONS.map((opt) => {
        const active = value === opt.key
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.key)}
            className={buttonClass(active)}
          >
            {opt.icon}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
