import { externalRefLabel, type ExternalRefKind } from '@/lib/externalRef'

interface ExternalRefProps {
  url?: string | null
  note?: string
  kind?: ExternalRefKind
  className?: string
}

// Non-clickable stand-in for a link to a working file (see lib/externalRef.ts).
export default function ExternalRef({ url, note, kind, className = '' }: ExternalRefProps) {
  return (
    <span
      title="Reference only: links to working files are not included in this showcase"
      className={`inline-flex items-center gap-1 text-xs text-gray-400 select-none ${className}`}
    >
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
      </svg>
      <span>[{externalRefLabel(url, note, kind)}]</span>
    </span>
  )
}
