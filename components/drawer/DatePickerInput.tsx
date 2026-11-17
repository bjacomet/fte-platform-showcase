'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { DayPicker, useDayPicker } from 'react-day-picker'
import type { ClassNames, MonthCaptionProps } from 'react-day-picker'

interface Props {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
}

function parseLocalDate(s: string): Date | undefined {
  if (!s) return undefined
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function toIsoString(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${day}`
}

function tryParseDate(s: string): Date | undefined {
  if (!s.trim()) return undefined
  // YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    if (!isNaN(d.getTime())) return d
  }
  // MM/DD/YYYY or M/D/YYYY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    const d = new Date(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]))
    if (!isNaN(d.getTime())) return d
  }
  // "Jun 25, 2026", "June 25 2026", etc.
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d
  return undefined
}

// Renders ‹ June 2026 › — replaces default caption + hides the default Nav via classNames
function MonthCaption({ calendarMonth }: MonthCaptionProps) {
  const { goToMonth, nextMonth, previousMonth } = useDayPicker()
  const label = calendarMonth.date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })
  return (
    <div className="flex items-center justify-between mb-2">
      <button
        type="button"
        disabled={!previousMonth}
        onClick={() => previousMonth && goToMonth(previousMonth)}
        className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-25"
        aria-label="Previous month"
      >
        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
        </svg>
      </button>
      <span className="text-white font-semibold text-sm select-none">{label}</span>
      <button
        type="button"
        disabled={!nextMonth}
        onClick={() => nextMonth && goToMonth(nextMonth)}
        className="flex items-center justify-center w-7 h-7 rounded text-gray-400 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-25"
        aria-label="Next month"
      >
        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
        </svg>
      </button>
    </div>
  )
}

const calendarClassNames: Partial<ClassNames> = {
  root: 'text-sm',
  months: 'flex',
  month: '',
  month_caption: '',
  caption_label: '',
  nav: 'hidden',
  month_grid: 'w-full border-collapse',
  weekdays: '',
  weekday: 'w-9 h-7 text-center text-[11px] font-medium text-gray-500 pb-0.5',
  weeks: '',
  week: '',
  day: 'p-0',
  day_button:
    'w-9 h-9 flex items-center justify-center rounded text-[13px] text-gray-300 hover:bg-gray-700 hover:text-white transition-colors cursor-pointer',
  selected: '!bg-blue-600 !text-white hover:!bg-blue-500',
  today: 'text-blue-400 font-medium',
  outside: 'opacity-25',
  disabled: 'opacity-20 cursor-not-allowed',
  hidden: 'invisible',
}

export default function DatePickerInput({
  value,
  onChange,
  className = '',
  placeholder = 'Select date',
}: Props) {
  const [open, setOpen] = useState(false)
  const [popupTop, setPopupTop] = useState(0)
  const [popupLeft, setPopupLeft] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const selected = parseLocalDate(value)
  const displayValue = selected
    ? `${String(selected.getMonth() + 1).padStart(2, '0')}/${String(selected.getDate()).padStart(2, '0')}/${selected.getFullYear()}`
    : ''

  // Sync inputText when the external value changes (calendar select, parent reset, etc.)
  // setState during render (before return) is the React-recommended pattern for derived state.
  const [prevValue, setPrevValue] = useState(value)
  const [inputText, setInputText] = useState(displayValue)
  if (prevValue !== value) {
    setPrevValue(value)
    setInputText(displayValue)
  }

  const openPicker = useCallback(() => {
    if (!inputRef.current) return
    const rect = inputRef.current.getBoundingClientRect()
    const POPUP_H = 310
    const goAbove = window.innerHeight - rect.bottom < POPUP_H + 8 && rect.top > POPUP_H
    setPopupTop(goAbove ? rect.top - POPUP_H - 4 : rect.bottom + 4)
    setPopupLeft(Math.min(rect.left, window.innerWidth - 290))
    setOpen(true)
  }, [])

  function commitText() {
    if (!inputText.trim()) {
      onChange('')
      return
    }
    const parsed = tryParseDate(inputText)
    if (parsed) {
      onChange(toIsoString(parsed))
    } else {
      // Invalid text — reset to last valid display value
      setInputText(displayValue)
    }
  }

  function handleSelect(day: Date | undefined) {
    onChange(day ? toIsoString(day) : '')
    setOpen(false)
  }

  function handleInputBlur() {
    commitText()
    setOpen(false)
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setOpen(false)
      setInputText(displayValue)
    } else if (e.key === 'Enter') {
      commitText()
      setOpen(false)
    }
  }

  // Close on outside click or scroll
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node
      if (!wrapperRef.current?.contains(t) && !popupRef.current?.contains(t)) {
        setOpen(false)
      }
    }
    function onScroll() {
      setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const popup = (
    <div
      ref={popupRef}
      style={{ top: popupTop, left: popupLeft }}
      className="fixed z-[150] w-[280px] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3"
      // Prevent input blur when clicking inside the calendar
      onMouseDown={(e) => e.preventDefault()}
    >
      <DayPicker
        mode="single"
        selected={selected}
        onSelect={handleSelect}
        defaultMonth={selected ?? new Date()}
        classNames={calendarClassNames}
        components={{ MonthCaption }}
      />
    </div>
  )

  return (
    <div ref={wrapperRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={inputText}
        placeholder={placeholder}
        className={`${className} pr-[52px]`}
        onFocus={openPicker}
        onClick={openPicker}
        onChange={(e) => setInputText(e.target.value)}
        onBlur={handleInputBlur}
        onKeyDown={handleInputKeyDown}
      />
      {value && (
        <button
          type="button"
          tabIndex={-1}
          // preventDefault keeps input focused so blur doesn't fire before the clear
          onMouseDown={(e) => {
            e.preventDefault()
            onChange('')
            setInputText('')
          }}
          className="absolute right-8 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-base leading-none"
          aria-label="Clear date"
        >
          ×
        </button>
      )}
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => {
          e.preventDefault()
          if (open) {
            setOpen(false)
          } else {
            inputRef.current?.focus()
            openPicker()
          }
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-300"
        aria-label="Open calendar"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="block"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </button>
      {open && typeof window !== 'undefined' && createPortal(popup, document.body)}
    </div>
  )
}
