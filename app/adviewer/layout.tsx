import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'FTE Adviewer',
  description: 'Follow The Eyes — Creative Review Portal',
}

export default function AdviewerLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-white text-gray-900 font-[family-name:var(--font-montserrat)]">
      {children}
    </div>
  )
}
