'use client'

import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import type { AdviewerProject, AdviewerProjectCard } from '@/types'
import ParticleBackground from '../components/ParticleBackground'

const MEDIA_COLORS: Record<string, string> = {
  'Display Request':   'bg-violet-500/20 text-violet-300 border-violet-500/25',
  'Social Ad Request': 'bg-sky-500/20 text-sky-300 border-sky-500/25',
  'Carousel Ad':       'bg-blue-500/20 text-blue-300 border-blue-500/25',
  'Video Request':     'bg-rose-500/20 text-rose-300 border-rose-500/25',
  'Reel Request':      'bg-pink-500/20 text-pink-300 border-pink-500/25',
  'Audio Request':     'bg-amber-500/20 text-amber-300 border-amber-500/25',
  'Web Banner':        'bg-violet-500/20 text-violet-300 border-violet-500/25',
}

function fmt(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

interface Props {
  projects: AdviewerProject[]
  clientEmail: string
}

export default function DashboardClient({ projects, clientEmail }: Props) {
  const router = useRouter()

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/adviewer/login')
  }

  const clientName = projects[0]?.client?.name ?? null

  return (
    <div className="relative min-h-screen" style={{ background: 'radial-gradient(ellipse 120% 90% at 50% 60%, #12101a 0%, #0d0d11 55%, #0a0a0e 100%)' }}>
      <ParticleBackground />

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-white/[0.07]" style={{ background: 'rgba(13,13,17,0.85)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}>
        <div className="max-w-2xl mx-auto px-5 py-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-none" style={{ background: 'linear-gradient(135deg, #7c3aed 0%, #06b6d4 100%)' }}>
            <span className="text-white font-black text-[10px] tracking-tight">FTE</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate leading-tight">
              {clientName ?? 'My Projects'}
            </p>
            <p className="text-[10px] text-white/30 uppercase tracking-widest">Adviewer</p>
          </div>
          <button
            onClick={handleSignOut}
            className="text-xs text-white/30 hover:text-white/60 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="relative z-10 max-w-2xl mx-auto px-5 py-8">
        <div className="mb-7">
          <h1 className="text-2xl font-semibold text-white mb-0.5">Your Projects</h1>
          <p className="text-sm text-white/35">{clientEmail}</p>
        </div>

        {projects.length === 0 ? (
          <div className="bg-white/[0.05] border border-white/10 rounded-2xl p-12 text-center">
            <div className="w-12 h-12 bg-white/[0.06] rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-white/20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-white/60 mb-1">No active projects yet</h2>
            <p className="text-xs text-white/30 max-w-xs mx-auto">
              The team will share creative projects here when they&apos;re ready for your review.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {projects.map((project) => {
              const cardCount    = project.cards?.length ?? 0
              const pendingCount = project.cards?.filter(
                (pc: AdviewerProjectCard) => pc.card?.client_portal_status === 'pending_approval'
              ).length ?? 0
              const mediaTypes = Array.from(
                new Set(project.cards?.map((pc: AdviewerProjectCard) => pc.card?.media_type).filter(Boolean))
              ) as string[]

              return (
                <button
                  key={project.id}
                  onClick={() => router.push(`/adviewer/projects/${project.id}`)}
                  className="w-full text-left bg-white/[0.05] border border-white/10 rounded-2xl p-5 hover:bg-white/[0.08] hover:border-white/20 transition-all group"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <h2 className="text-[15px] font-semibold text-white group-hover:text-[#5cc8e8] transition-colors leading-snug">
                      {project.title}
                    </h2>
                    {pendingCount > 0 && (
                      <span className="flex-none text-[11px] font-semibold bg-amber-400/15 text-amber-300 border border-amber-400/25 px-2.5 py-1 rounded-full whitespace-nowrap">
                        {pendingCount} awaiting review
                      </span>
                    )}
                  </div>

                  {project.description && (
                    <p className="text-xs text-white/35 mb-3 line-clamp-1">{project.description}</p>
                  )}

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      {mediaTypes.map((type) => (
                        <span
                          key={type}
                          className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${MEDIA_COLORS[type] ?? 'bg-white/10 text-white/50 border-white/15'}`}
                        >
                          {type}
                        </span>
                      ))}
                    </div>
                    <p className="text-[11px] text-white/30 flex-none">
                      {cardCount} {cardCount === 1 ? 'ad' : 'ads'} · {fmt(project.updated_at.split('T')[0])}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
