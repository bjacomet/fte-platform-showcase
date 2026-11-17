'use client'

import { useEffect, useRef, useState } from 'react'

export type MotionPreset = 'aurora' | 'particles' | 'gradient' | 'shapes'

export const MOTION_PRESETS: { key: MotionPreset; label: string }[] = [
  { key: 'aurora', label: 'Aurora orbs' },
  { key: 'particles', label: 'Drifting particles' },
  { key: 'gradient', label: 'Gradient drift' },
  { key: 'shapes', label: 'Floating shapes' },
]

// FTE brand-derived palette (navy / blue / bright blue / purple / light purple)
const PARTICLE_COLORS = ['#0075a9', '#38b6ff', '#7c3aed', '#c084fc', '#005b8a']

// Keyframes injected inline so the component is self-contained (does not depend
// on globals.css). Names are prefixed `ab-` to avoid collisions.
const KEYFRAMES = `
@keyframes ab-aurora-a { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(22vw,15vh) scale(1.4); } }
@keyframes ab-aurora-b { 0%,100% { transform: translate(0,0) scale(1.15); } 50% { transform: translate(-20vw,-12vh) scale(0.8); } }
@keyframes ab-aurora-c { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(16vw,-18vh) scale(1.3); } }
@keyframes ab-gradient { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
@keyframes ab-shape { 0% { transform: translateY(0) rotate(0deg); opacity: 0; } 12% { opacity: .55; } 88% { opacity: .55; } 100% { transform: translateY(-112vh) rotate(200deg); opacity: 0; } }
`

function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return reduced
}

function ParticleCanvas({ reduced }: { reduced: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvasEl = canvasRef.current
    if (!canvasEl) return
    const ctxMaybe = canvasEl.getContext('2d')
    if (!ctxMaybe) return
    // Non-null bindings so narrowing holds inside the closures below
    const canvas: HTMLCanvasElement = canvasEl
    const ctx: CanvasRenderingContext2D = ctxMaybe

    let width = 0
    let height = 0
    let raf = 0

    interface P { x: number; y: number; vx: number; vy: number; r: number; color: string }
    let particles: P[] = []

    function resize() {
      const parent = canvas.parentElement
      width = parent?.clientWidth || window.innerWidth
      height = parent?.clientHeight || window.innerHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.floor(width * dpr))
      canvas.height = Math.max(1, Math.floor(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const count = Math.min(80, Math.floor((width * height) / 22000))
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: -0.15 - Math.random() * 0.35,
        r: 1 + Math.random() * 2.2,
        color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
      }))
    }

    function render() {
      ctx.clearRect(0, 0, width, height)
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        for (let j = i + 1; j < particles.length; j++) {
          const q = particles[j]
          const dx = p.x - q.x
          const dy = p.y - q.y
          const dist2 = dx * dx + dy * dy
          if (dist2 < 130 * 130) {
            ctx.strokeStyle = `rgba(56,182,255,${0.14 * (1 - Math.sqrt(dist2) / 130)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(q.x, q.y)
            ctx.stroke()
          }
        }
      }
      for (const p of particles) {
        ctx.fillStyle = p.color
        ctx.globalAlpha = 0.75
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    function step() {
      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.y < -10) { p.y = height + 10; p.x = Math.random() * width }
        if (p.x < -10) p.x = width + 10
        if (p.x > width + 10) p.x = -10
      }
      render()
      raf = requestAnimationFrame(step)
    }

    resize()
    if (reduced) {
      render()
    } else {
      raf = requestAnimationFrame(step)
    }
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [reduced])

  return <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
}

function Aurora({ reduced }: { reduced: boolean }) {
  const orbs = [
    { top: '-10%', left: '-5%', size: '46vw', color: '#0075a9', anim: 'ab-aurora-a 14s ease-in-out infinite' },
    { top: '30%', left: 'auto', right: '-8%', size: '40vw', color: '#7c3aed', anim: 'ab-aurora-b 17s ease-in-out infinite' },
    { top: 'auto', bottom: '-15%', left: '25%', size: '44vw', color: '#003057', anim: 'ab-aurora-c 15s ease-in-out infinite' },
  ]
  return (
    <>
      {orbs.map((o, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: o.top, bottom: o.bottom, left: o.left, right: o.right,
            width: o.size, height: o.size,
            borderRadius: '9999px',
            filter: 'blur(70px)',
            opacity: 0.55,
            willChange: 'transform',
            background: `radial-gradient(circle, ${o.color} 0%, transparent 70%)`,
            animation: reduced ? undefined : o.anim,
          }}
        />
      ))}
    </>
  )
}

const SHAPES = [
  { left: '8%', size: 60, dur: 26, delay: 0, color: 'rgba(56,182,255,0.55)', ring: true },
  { left: '22%', size: 26, dur: 20, delay: 6, color: 'rgba(124,58,237,0.55)', ring: false },
  { left: '38%', size: 80, dur: 34, delay: 12, color: 'rgba(0,117,169,0.5)', ring: true },
  { left: '52%', size: 34, dur: 24, delay: 3, color: 'rgba(192,132,252,0.55)', ring: false },
  { left: '66%', size: 52, dur: 30, delay: 9, color: 'rgba(56,182,255,0.5)', ring: true },
  { left: '80%', size: 22, dur: 18, delay: 15, color: 'rgba(124,58,237,0.55)', ring: false },
  { left: '90%', size: 68, dur: 36, delay: 2, color: 'rgba(0,117,169,0.45)', ring: true },
]

function Shapes({ reduced }: { reduced: boolean }) {
  if (reduced) return null
  return (
    <>
      {SHAPES.map((s, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            bottom: '-100px',
            left: s.left,
            width: s.size,
            height: s.size,
            borderRadius: '9999px',
            opacity: 0,
            border: s.ring ? `2px solid ${s.color}` : 'none',
            background: s.ring ? 'transparent' : s.color,
            willChange: 'transform, opacity',
            animation: `ab-shape ${s.dur}s linear infinite`,
            animationDelay: `${s.delay}s`,
          }}
        />
      ))}
    </>
  )
}

function GradientDrift({ reduced }: { reduced: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'linear-gradient(135deg, #001b30, #003057, #0075a9, #1b1145)',
        backgroundSize: '300% 300%',
        animation: reduced ? undefined : 'ab-gradient 22s ease infinite',
      }}
    />
  )
}

export default function AnimatedBackground({ preset }: { preset: MotionPreset }) {
  const reduced = useReducedMotion()
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ background: '#07090f' }} aria-hidden="true">
      <style>{KEYFRAMES}</style>
      {preset === 'aurora' && <Aurora reduced={reduced} />}
      {preset === 'particles' && <ParticleCanvas reduced={reduced} />}
      {preset === 'gradient' && <GradientDrift reduced={reduced} />}
      {preset === 'shapes' && <Shapes reduced={reduced} />}
    </div>
  )
}
