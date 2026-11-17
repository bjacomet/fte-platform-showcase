const BADGE_COLORS: Record<string, string> = {
  'Display Request':    'bg-blue-900/60 text-blue-300 border-blue-700/50',
  'Social Ad Request':  'bg-purple-900/60 text-purple-300 border-purple-700/50',
  'Organic Post':       'bg-green-900/60 text-green-300 border-green-700/50',
  'Eblast':             'bg-yellow-900/60 text-yellow-300 border-yellow-700/50',
  'Web Banner':         'bg-cyan-900/60 text-cyan-300 border-cyan-700/50',
  'Proposal Request':   'bg-orange-900/60 text-orange-300 border-orange-700/50',
  'FB Event Cover':     'bg-indigo-900/60 text-indigo-300 border-indigo-700/50',
  'Reel Request':       'bg-pink-900/60 text-pink-300 border-pink-700/50',
  'Video Request':      'bg-red-900/60 text-red-300 border-red-700/50',
  'Audio Request':      'bg-teal-900/60 text-teal-300 border-teal-700/50',
  'Flyer':              'bg-lime-900/60 text-lime-300 border-lime-700/50',
  'Carousel Ad':        'bg-violet-900/60 text-violet-300 border-violet-700/50',
  'Messenger Ad':       'bg-sky-900/60 text-sky-300 border-sky-700/50',
}

export default function MediaTypeBadge({ type }: { type: string | null }) {
  if (!type) return null
  const colors = BADGE_COLORS[type] ?? 'bg-gray-700/60 text-gray-300 border-gray-600/50'
  return (
    <span className={`inline-block text-[11px] font-medium px-1.5 py-0.5 rounded border ${colors} leading-none`}>
      {type}
    </span>
  )
}
