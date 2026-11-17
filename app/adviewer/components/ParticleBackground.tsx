'use client'

import { useEffect, useRef } from 'react'

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
  '#7c3aed',
  '#8b5cf6',
  '#a78bfa',
  '#06b6d4',
  '#22d3ee',
  '#67e8f9',
  '#c084fc',
  '#5b21b6',
]

function initParticles(w: number, h: number): Particle[] {
  return Array.from({ length: 40 }, () => {
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

export default function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mouseRef  = useRef({ x: 0, y: 0 })

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      mouseRef.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [])

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
      const targetX = ((mouseRef.current.x || w / 2) / w - 0.5) * 24
      const targetY = ((mouseRef.current.y || h / 2) / h - 0.5) * 16
      offsetX += (targetX - offsetX) * 0.04
      offsetY += (targetY - offsetY) * 0.04

      ctx!.clearRect(0, 0, w, h)

      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy

        if (p.x < -10) p.x = w + 10
        if (p.x > w + 10) p.x = -10
        if (p.y < -10) p.y = h + 10
        if (p.y > h + 10) p.y = -10

        p.alpha += p.alphaDelta
        if (p.alpha >= p.alphaMax || p.alpha <= p.alphaMin) p.alphaDelta *= -1

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
  }, [])

  return (
    <>
      {/* Particles */}
      <canvas ref={canvasRef} className="fixed inset-0 w-full h-full pointer-events-none z-0" />

      {/* Ambient glow blobs */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        <div style={{
          position: 'absolute', width: 700, height: 500,
          top: '-8%', left: '50%', transform: 'translateX(-50%)',
          background: 'radial-gradient(ellipse at center, rgba(124,58,237,0.12) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }} />
        <div style={{
          position: 'absolute', width: 500, height: 400,
          bottom: '5%', right: '5%',
          background: 'radial-gradient(ellipse at center, rgba(6,182,212,0.09) 0%, transparent 70%)',
          filter: 'blur(50px)',
        }} />
        <div style={{
          position: 'absolute', width: 400, height: 350,
          bottom: '20%', left: '5%',
          background: 'radial-gradient(ellipse at center, rgba(139,92,246,0.08) 0%, transparent 70%)',
          filter: 'blur(40px)',
        }} />
      </div>

      {/* Subtle grid */}
      <div className="fixed inset-0 pointer-events-none z-0 opacity-[0.022]" style={{
        backgroundImage: 'linear-gradient(rgba(167,139,250,1) 1px, transparent 1px), linear-gradient(90deg, rgba(167,139,250,1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />
    </>
  )
}
