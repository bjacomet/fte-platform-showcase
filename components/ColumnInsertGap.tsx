'use client'

import { useState, useRef, useEffect } from 'react'

interface Props {
  afterColumnId: string
  onInsert: (afterColumnId: string, name: string) => Promise<void>
  isDragging?: boolean
}

export default function ColumnInsertGap({ afterColumnId, onInsert, isDragging = false }: Props) {
  const [hovered, setHovered] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  // During a drag, stay mounted at the resting width but inert — unmounting the
  // gaps would collapse the column row on pickup and spring it back on drop.
  if (isDragging) {
    return <div className="flex-none self-stretch" style={{ width: 12 }} />
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || loading) return
    setLoading(true)
    await onInsert(afterColumnId, name.trim())
    setName('')
    setAdding(false)
    setLoading(false)
    setHovered(false)
  }

  function handleCancel() {
    setAdding(false)
    setName('')
    setHovered(false)
  }

  if (adding) {
    return (
      <div className="flex-none self-start mt-0" style={{ width: 200 }}>
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-2 rounded-xl p-3 shadow-2xl border border-[#0075a9]/40"
          style={{ background: 'rgba(20,24,40,0.95)', backdropFilter: 'blur(12px)' }}
        >
          <p className="text-[11px] text-white/50 font-medium uppercase tracking-wider">New Column</p>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Column name…"
            className="w-full bg-white/[0.06] border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-[#0075a9]/70"
            onKeyDown={(e) => e.key === 'Escape' && handleCancel()}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!name.trim() || loading}
              className="flex-1 text-xs font-semibold py-1.5 rounded-lg text-white disabled:opacity-40 transition-opacity"
              style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
            >
              {loading ? '…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="flex-1 text-xs font-medium py-1.5 rounded-lg bg-white/[0.06] text-white/60 hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div
      className="flex-none relative flex items-center justify-center self-stretch"
      style={{
        width: hovered ? 40 : 12,
        transition: 'width 150ms ease',
        cursor: hovered ? 'pointer' : 'default',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {hovered && (
        <>
          {/* Sleek dashed vertical line — repeating-gradient avoids SVG % height issues */}
          <div
            className="absolute left-1/2 -translate-x-px inset-y-0 pointer-events-none"
            style={{
              width: 1,
              background: 'repeating-linear-gradient(to bottom, rgba(0,117,169,0.6) 0px, rgba(0,117,169,0.6) 5px, transparent 5px, transparent 15px)',
            }}
          />
          {/* FTE gradient plus button */}
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-white text-base font-bold shadow-xl hover:scale-110 transition-transform z-20"
            style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}
          >
            +
          </button>
        </>
      )}
    </div>
  )
}
