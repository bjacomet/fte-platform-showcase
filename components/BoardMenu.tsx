'use client'

import { useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

// Direct Unsplash CDN URLs — stable, no API key required, no redirects
const PRESETS = [
  {
    label: 'Nature',
    thumb: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=280&h=128&fit=crop&q=60',
    full:  'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1600&q=80&fit=crop',
  },
  {
    label: 'Mountains',
    thumb: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=280&h=128&fit=crop&q=60',
    full:  'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1600&q=80&fit=crop',
  },
  {
    label: 'Ocean',
    thumb: 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=280&h=128&fit=crop&q=60',
    full:  'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=1600&q=80&fit=crop',
  },
  {
    label: 'City',
    thumb: 'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=280&h=128&fit=crop&q=60',
    full:  'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=1600&q=80&fit=crop',
  },
  {
    label: 'Abstract',
    thumb: 'https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=280&h=128&fit=crop&q=60',
    full:  'https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=1600&q=80&fit=crop',
  },
  {
    label: 'Dark',
    thumb: 'https://images.unsplash.com/photo-1475274047050-1d0c0975c63e?w=280&h=128&fit=crop&q=60',
    full:  'https://images.unsplash.com/photo-1475274047050-1d0c0975c63e?w=1600&q=80&fit=crop',
  },
  {
    label: 'Space',
    thumb: 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=280&h=128&fit=crop&q=60',
    full:  'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1600&q=80&fit=crop',
  },
  {
    label: 'Desert',
    thumb: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=280&h=128&fit=crop&q=60',
    full:  'https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=1600&q=80&fit=crop',
  },
]

const DEFAULT_BG = PRESETS[0].full

// Animated background presets — stored as `motion:<key>` (see AnimatedBackground.tsx).
// `swatch` is a static CSS background hinting at each animation's look.
const MOTION = [
  { key: 'aurora', label: 'Aurora orbs', swatch: 'radial-gradient(circle at 28% 30%, rgba(0,117,169,0.9), transparent 55%), radial-gradient(circle at 72% 68%, rgba(124,58,237,0.9), transparent 55%), #07090f' },
  { key: 'particles', label: 'Particles', swatch: 'radial-gradient(circle at 20% 40%, #38b6ff 0 2px, transparent 3px), radial-gradient(circle at 55% 62%, #c084fc 0 2px, transparent 3px), radial-gradient(circle at 78% 30%, #0075a9 0 2px, transparent 3px), #07090f' },
  { key: 'gradient', label: 'Gradient drift', swatch: 'linear-gradient(135deg, #001b30, #003057, #0075a9, #1b1145)' },
  { key: 'shapes', label: 'Floating shapes', swatch: 'radial-gradient(circle at 30% 58%, transparent 5px, rgba(56,182,255,0.6) 6px, transparent 8px), radial-gradient(circle at 70% 40%, transparent 4px, rgba(124,58,237,0.6) 5px, transparent 7px), #07090f' },
] as const

interface Props {
  onClose: () => void
  onBackgroundChange: (url: string) => void
  currentBackground: string
  /**
   * Where the chosen background is saved. Omitted = the FTE board's shared
   * app_settings key. The Atlas board passes its own so its background is
   * independent (atlas_board_settings.background_url).
   */
  persist?: (url: string) => Promise<void>
  title?: string
}

export default function BoardMenu({ onClose, onBackgroundChange, currentBackground, persist, title = 'Change Background' }: Props) {
  const [customUrl, setCustomUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  const saveBackground = async (url: string) => {
    setSaving(true)
    onBackgroundChange(url)
    if (persist) {
      await persist(url)
    } else {
      await supabase.from('app_settings').upsert(
        { key: 'board_background_url', value: url },
        { onConflict: 'key' }
      )
    }
    setSaving(false)
  }

  const uploadImageFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setUploadError('Only image files are supported.')
      return
    }
    setUploading(true)
    setUploadError(null)
    const ext = file.name.split('.').pop() ?? 'jpg'
    const path = `backgrounds/${crypto.randomUUID()}.${ext}`
    const { error } = await supabase.storage.from('creative-files').upload(path, file, { upsert: false })
    if (error) {
      setUploadError('Upload failed. Try again.')
      setUploading(false)
      return
    }
    const { data } = supabase.storage.from('creative-files').getPublicUrl(path)
    await saveBackground(data.publicUrl)
    setUploading(false)
  }

  const handleCustom = () => {
    if (customUrl.trim()) saveBackground(customUrl.trim())
  }

  return (
    <div className="fixed inset-y-0 right-0 w-80 bg-[#1a1d23] border-l border-gray-700/60 z-50 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700/60">
        <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-200 transition-colors text-lg leading-none">✕</button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Animated */}
        <div>
          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Animated</p>
          <div className="grid grid-cols-2 gap-2">
            {MOTION.map((m) => (
              <button
                key={m.key}
                onClick={() => saveBackground(`motion:${m.key}`)}
                disabled={saving}
                className={`relative w-full h-16 rounded-lg overflow-hidden border transition-all group ${
                  currentBackground === `motion:${m.key}` ? 'border-blue-400 ring-1 ring-blue-400/60' : 'border-gray-700/60 hover:border-blue-500'
                }`}
                style={{ background: m.swatch }}
              >
                <div className="absolute inset-0 bg-black/25 group-hover:bg-black/10 transition-colors" />
                <span className="relative text-xs font-medium text-white drop-shadow">{m.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Presets */}
        <div>
          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Photo Categories</p>
          <div className="grid grid-cols-2 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => saveBackground(p.full)}
                disabled={saving}
                className="relative w-full h-16 rounded-lg overflow-hidden border border-gray-700/60 hover:border-blue-500 transition-all group"
                style={{ backgroundImage: `url(${p.thumb})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
              >
                <div className="absolute inset-0 bg-black/40 group-hover:bg-black/20 transition-colors" />
                <span className="relative text-xs font-medium text-white drop-shadow">{p.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Upload from device */}
        <div>
          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Upload from Device</p>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const file = e.dataTransfer.files[0]
              if (file) void uploadImageFile(file)
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-1.5 w-full h-20 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
              dragOver
                ? 'border-violet-400 bg-violet-900/20'
                : 'border-gray-600 hover:border-gray-400 bg-gray-800/40'
            }`}
          >
            {uploading ? (
              <span className="text-xs text-gray-300">Uploading…</span>
            ) : (
              <>
                <span className="text-lg">🖼️</span>
                <span className="text-xs text-gray-400">Drop an image or click to browse</span>
              </>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void uploadImageFile(file)
              e.target.value = ''
            }}
          />
          {uploadError && <p className="text-[10px] text-red-400 mt-1">{uploadError}</p>}
        </div>

        {/* Custom URL */}
        <div>
          <p className="text-xs text-gray-400 font-medium mb-2 uppercase tracking-wider">Custom Image URL</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustom()}
              placeholder="https://..."
              className="flex-1 text-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleCustom}
              disabled={saving || !customUrl.trim()}
              className="text-xs px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg transition-colors"
            >
              Set
            </button>
          </div>
        </div>

        {/* Reset to default */}
        <button
          onClick={() => saveBackground(DEFAULT_BG)}
          disabled={saving}
          className="w-full text-xs text-gray-400 hover:text-gray-200 border border-gray-700/60 hover:border-gray-500/60 rounded-lg py-2 transition-colors"
        >
          Reset to default
        </button>

        <p className="text-[10px] text-gray-600 text-center">
          Photos via{' '}
          <a href="https://unsplash.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-400">
            Unsplash
          </a>
        </p>
      </div>
    </div>
  )
}
