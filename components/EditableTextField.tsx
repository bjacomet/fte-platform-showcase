'use client'

import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import AutoGrowTextarea from './AutoGrowTextarea'
import ExternalRef from './ExternalRef'
import { externalRefKind } from '@/lib/externalRef'

type Props = {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
  rows?: number
  maxLines?: number
  linkify?: boolean
}

// Render plain text with clickable links: Markdown named links [text](url) show
// their text; bare http(s) URLs autolink. Links stop propagation so opening one
// doesn't also switch the field into edit mode.
//
// The named-link URL group is [^\s]+? (lazy, parens allowed) with a lookahead that
// only treats a ")" as the closing bracket when it's followed by whitespace, a
// sentence punctuation mark, another ")", or end of input. This lets a URL contain
// literal parentheses — e.g. dealer-inventory links — without the href being cut at
// the first inner ")". Bare (unbracketed) URLs still stop at ")" so a URL inside prose
// parens like "(see https://x.com)" doesn't swallow the closing paren.
export function renderWithLinks(text: string) {
  const nodes: ReactNode[] = []
  const regex = /\[([^\]]+)\]\((https?:\/\/[^\s]+?)\)(?=[\s).,;!?]|$)|(https?:\/\/[^\s)]+)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  const link = (href: string, label: string) => externalRefKind(href) ? (
    <ExternalRef key={key++} url={href} note={label === href ? undefined : label} />
  ) : (
    <a
      key={key++}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-blue-400 hover:text-blue-300 underline break-all"
    >
      {label}
    </a>
  )
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] && m[2]) nodes.push(link(m[2], m[1]))
    else if (m[3]) nodes.push(link(m[3], m[3]))
    last = regex.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export default memo(function EditableTextField({
  value, onChange, className = '', placeholder, rows = 3, maxLines = 4, linkify = false,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const displayRef = useRef<HTMLDivElement>(null)
  // Set true just before an explicit Cancel/Escape so the ensuing blur doesn't
  // re-commit the draft we're about to discard. Any other way of leaving the
  // field (clicking elsewhere, the footer Save, the close button) commits.
  const skipBlurCommitRef = useRef(false)

  // Reflect external value changes (e.g. "Sync slides → Description") into the editor.
  // value only changes via the parent (field Save or Sync), never from local typing,
  // so this won't clobber in-progress edits.
  useEffect(() => { setDraft(value) }, [value])

  // Only show "Show more" when the clamped text actually overflows its box.
  useLayoutEffect(() => {
    const el = displayRef.current
    if (!el || editing || expanded) return
    setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [value, editing, expanded, maxLines])

  const startEdit = () => { skipBlurCommitRef.current = false; setDraft(value); setEditing(true) }
  const save = () => { onChange(draft); setEditing(false); setExpanded(false) }
  const cancel = () => { skipBlurCommitRef.current = true; setDraft(value); setEditing(false) }
  // Commit an in-progress edit when focus leaves the field so typed text is never
  // silently dropped by the two-step (inline Save → footer Save) flow.
  const commitOnBlur = () => {
    if (skipBlurCommitRef.current) { skipBlurCommitRef.current = false; return }
    save()
  }

  if (editing) {
    return (
      <div>
        <AutoGrowTextarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={rows}
          className={className}
          placeholder={placeholder}
          autoFocus
          onBlur={commitOnBlur}
          onFocus={(e) => {
            const end = e.currentTarget.value.length
            e.currentTarget.setSelectionRange(end, end)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); cancel() }
            else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save() }
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Save
          </button>
          <button
            type="button"
            onMouseDown={() => { skipBlurCommitRef.current = true }}
            onClick={cancel}
            className="text-xs font-medium px-3 py-1.5 rounded-md text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  const hasValue = value.trim().length > 0
  return (
    <div>
      <div
        ref={displayRef}
        onClick={linkify ? undefined : startEdit}
        role={linkify ? undefined : 'button'}
        tabIndex={linkify ? undefined : 0}
        onKeyDown={linkify ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit() }
        }}
        className={`${className} ${linkify ? 'cursor-auto' : 'cursor-text hover:border-gray-500'} whitespace-pre-wrap break-words transition-colors ${hasValue ? '' : '!text-gray-500'}`}
        style={expanded ? undefined : {
          display: '-webkit-box',
          WebkitLineClamp: maxLines,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {hasValue ? (linkify ? renderWithLinks(value) : value) : (placeholder ?? 'Click to add…')}
      </div>
      <div className="mt-1 flex items-center gap-3">
        {overflowing && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
            className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {linkify && (
          <button
            type="button"
            onClick={startEdit}
            className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
          >
            Edit
          </button>
        )}
      </div>
    </div>
  )
})
