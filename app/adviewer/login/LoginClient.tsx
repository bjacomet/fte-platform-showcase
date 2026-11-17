'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'

// ── Particle system ───────────────────────────────────────────────────────────

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  color: string
  alpha: number
  alphaDelta: number
  alphaMin: number
  alphaMax: number
}

const COLORS = [
  '#7c3aed', // purple-600
  '#8b5cf6', // purple-500
  '#a78bfa', // purple-400
  '#06b6d4', // cyan-500
  '#22d3ee', // cyan-400
  '#67e8f9', // cyan-300
  '#c084fc', // purple-400 (mid)
  '#5b21b6', // purple-800 (deep)
]

function initParticles(w: number, h: number): Particle[] {
  return Array.from({ length: 80 }, () => {
    const alphaMax = 0.12 + Math.random() * 0.25
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      radius: 1.5 + Math.random() * 4.5,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      alpha: Math.random() * alphaMax,
      alphaDelta: (Math.random() * 0.003 + 0.001) * (Math.random() < 0.5 ? 1 : -1),
      alphaMin: 0.02,
      alphaMax,
    }
  })
}

function ParticleCanvas({ mouseRef }: { mouseRef: React.RefObject<{ x: number; y: number }> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w = window.innerWidth
    let h = window.innerHeight
    canvas.width  = w
    canvas.height = h

    let particles = initParticles(w, h)
    let rafId: number
    let offsetX = 0
    let offsetY = 0

    function tick() {
      // Smooth parallax offset toward mouse-driven target
      const targetX = ((mouseRef.current?.x ?? w / 2) / w - 0.5) * 24
      const targetY = ((mouseRef.current?.y ?? h / 2) / h - 0.5) * 16
      offsetX += (targetX - offsetX) * 0.04
      offsetY += (targetY - offsetY) * 0.04

      ctx!.clearRect(0, 0, w, h)

      for (const p of particles) {
        // Move
        p.x += p.vx
        p.y += p.vy

        // Wrap edges
        if (p.x < -10) p.x = w + 10
        if (p.x > w + 10) p.x = -10
        if (p.y < -10) p.y = h + 10
        if (p.y > h + 10) p.y = -10

        // Pulse alpha
        p.alpha += p.alphaDelta
        if (p.alpha >= p.alphaMax || p.alpha <= p.alphaMin) p.alphaDelta *= -1

        // Draw with parallax offset applied
        ctx!.beginPath()
        ctx!.arc(p.x + offsetX, p.y + offsetY, p.radius, 0, Math.PI * 2)
        ctx!.fillStyle = p.color
        ctx!.globalAlpha = p.alpha
        ctx!.fill()
      }

      ctx!.globalAlpha = 1
      rafId = requestAnimationFrame(tick)
    }

    tick()

    function onResize() {
      w = window.innerWidth
      h = window.innerHeight
      canvas!.width  = w
      canvas!.height = h
      particles = initParticles(w, h)
    }

    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
    }
  }, [mouseRef])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function LoginClient() {
  const router = useRouter()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const mouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      mouseRef.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [])

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    setLoading(false)

    if (signInError) {
      setError('Invalid email or password. Contact your FTE account manager if you need access.')
      return
    }

    router.push('/adviewer/dashboard')
  }

  return (
    <div
      className="relative min-h-screen flex flex-col items-center justify-center px-4 overflow-hidden"
      style={{ background: 'radial-gradient(ellipse 120% 90% at 50% 60%, #12101a 0%, #0d0d11 55%, #0a0a0e 100%)' }}
    >
      {/* Ambient glow blobs */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: 700, height: 500,
          top: '-10%', left: '50%',
          transform: 'translateX(-50%)',
          background: 'radial-gradient(ellipse at center, rgba(124,58,237,0.13) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          width: 500, height: 400,
          bottom: '5%', right: '10%',
          background: 'radial-gradient(ellipse at center, rgba(6,182,212,0.10) 0%, transparent 70%)',
          filter: 'blur(50px)',
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          width: 400, height: 350,
          bottom: '15%', left: '5%',
          background: 'radial-gradient(ellipse at center, rgba(139,92,246,0.08) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }}
      />

      {/* Particle canvas */}
      <ParticleCanvas mouseRef={mouseRef} />

      {/* Subtle grid overlay */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.025]"
        style={{
          backgroundImage: 'linear-gradient(rgba(167,139,250,1) 1px, transparent 1px), linear-gradient(90deg, rgba(167,139,250,1) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center w-full max-w-sm">
        {/* Brand mark */}
        <div className="mb-10 flex flex-col items-center gap-3">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)',
              boxShadow: '0 0 32px rgba(124,58,237,0.45), 0 0 64px rgba(6,182,212,0.15)',
            }}
          >
            <span className="text-white font-black text-xl tracking-tight">FTE</span>
          </div>
          <p
            className="text-[11px] font-semibold tracking-[0.22em] uppercase"
            style={{ color: '#a78bfa' }}
          >
            Adviewer
          </p>
        </div>

        {/* Glass card */}
        <div
          className="w-full rounded-2xl px-8 py-10"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.09)',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.07)',
          }}
        >
          <>
            <h1 className="text-xl font-semibold text-white mb-1">Sign in</h1>
            <p className="text-sm mb-7" style={{ color: 'rgba(255,255,255,0.4)' }}>
              FTE Adviewer — staff access only.
            </p>

            <form onSubmit={handleSignIn} className="space-y-4">
              <div>
                <label className="block text-[11px] font-medium mb-1.5 uppercase tracking-wide" style={{ color: 'rgba(167,139,250,0.7)' }}>
                  Email address
                </label>
                <input
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-4 py-3 text-sm rounded-xl text-white placeholder-white/20 focus:outline-none transition"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}
                  onFocus={(e) => { e.currentTarget.style.border = '1px solid rgba(124,58,237,0.6)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(124,58,237,0.15)' }}
                  onBlur={(e) => { e.currentTarget.style.border = '1px solid rgba(255,255,255,0.12)'; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium mb-1.5 uppercase tracking-wide" style={{ color: 'rgba(167,139,250,0.7)' }}>
                  Password
                </label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-4 py-3 text-sm rounded-xl text-white placeholder-white/20 focus:outline-none transition"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }}
                  onFocus={(e) => { e.currentTarget.style.border = '1px solid rgba(124,58,237,0.6)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(124,58,237,0.15)' }}
                  onBlur={(e) => { e.currentTarget.style.border = '1px solid rgba(255,255,255,0.12)'; e.currentTarget.style.boxShadow = 'none' }}
                />
              </div>

              {error && (
                <p className="text-xs text-red-300 rounded-xl px-4 py-3" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || !email.trim() || !password}
                className="w-full py-3 text-white text-sm font-semibold rounded-xl transition-all disabled:cursor-not-allowed disabled:opacity-30"
                style={{
                  background: loading || !email.trim() || !password
                    ? 'rgba(124,58,237,0.4)'
                    : 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)',
                  boxShadow: loading || !email.trim() || !password ? 'none' : '0 4px 20px rgba(124,58,237,0.35)',
                }}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </>
        </div>

        <p className="mt-8 text-[10px] uppercase tracking-[0.25em]" style={{ color: 'rgba(255,255,255,0.12)' }}>
          Follow The Eyes
        </p>
      </div>
    </div>
  )
}
