'use client'

import { useState, useRef, useEffect } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface CardContext {
  title: string
  mediaType: string | null
  clientName: string | null
  brandNotes: string | null
  boxBrandFileId: string | null
  brandWebsiteUrl: string | null
  fbHeadline: string | null
  fbBodyText: string | null
  fbLinkDescription: string | null
  creativeBrief: string | null
  previewImageUrl: string | null
}

interface Props {
  userEmail?: string
  userFullName?: string
  activeCard?: CardContext | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

function ThinkingIndicator() {
  const bars = [3, 5, 8, 5, 9, 4, 7, 5, 3, 6]
  return (
    <div className="flex flex-col gap-2 py-1 px-1">
      {/* Waveform bars */}
      <div className="flex items-end gap-[3px] h-6">
        {bars.map((h, i) => (
          <span
            key={i}
            className="w-[3px] rounded-full"
            style={{
              height: `${h}px`,
              background: 'linear-gradient(to top, #06b6d4, #7c3aed)',
              animation: `brendaWave 1s ease-in-out ${i * 0.08}s infinite alternate`,
              boxShadow: '0 0 4px rgba(6,182,212,0.6)',
            }}
          />
        ))}
      </div>
      {/* Scan line */}
      <div className="relative h-[2px] w-full rounded-full overflow-hidden" style={{ background: 'rgba(6,182,212,0.1)' }}>
        <div
          className="absolute top-0 left-0 h-full w-8 rounded-full"
          style={{
            background: 'linear-gradient(to right, transparent, #06b6d4, transparent)',
            animation: 'brendaScan 1.4s ease-in-out infinite',
          }}
        />
      </div>
      <span className="text-[10px] tracking-widest uppercase" style={{ color: 'rgba(6,182,212,0.5)' }}>
        Processing
      </span>
    </div>
  )
}

export default function AIChatWidget({
  userEmail = '',
  userFullName = '',
  activeCard = null,
  open: controlledOpen,
  onOpenChange,
  expanded: controlledExpanded,
  onExpandedChange,
}: Props) {
  const firstName = userFullName?.split(' ')[0] || userEmail?.split('@')[0] || 'there'
  const [internalOpen, setInternalOpen] = useState(false)
  const [internalExpanded, setInternalExpanded] = useState(false)

  const open = controlledOpen ?? internalOpen
  const expanded = controlledExpanded ?? internalExpanded

  function setOpen(val: boolean) {
    setInternalOpen(val)
    onOpenChange?.(val)
  }
  function setExpanded(val: boolean) {
    setInternalExpanded(val)
    onExpandedChange?.(val)
  }
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sessionCost, setSessionCost] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const COST_PER_TOKEN = {
    sonnet: { input: 3 / 1_000_000, output: 15 / 1_000_000 },
    haiku:  { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  }

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function send(override?: string) {
    const text = (override ?? input).trim()
    if (!text || loading) return

    const newMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, userFullName, userEmail, cardContext: activeCard ?? undefined }),
      })

      if (!res.ok || !res.body) throw new Error('Request failed')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let assistantText = ''

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        assistantText += decoder.decode(value, { stream: true })

        // Strip usage sentinel (everything from \x00 onward) before displaying
        const sentinelIdx = assistantText.indexOf('\x00')
        const displayText = sentinelIdx === -1 ? assistantText : assistantText.slice(0, sentinelIdx)

        setMessages((prev) => {
          const updated = [...prev]
          updated[updated.length - 1] = { role: 'assistant', content: displayText }
          return updated
        })
      }

      // Parse usage sentinel and accumulate session cost
      const sentinelIdx = assistantText.indexOf('\x00')
      if (sentinelIdx !== -1) {
        try {
          const usage = JSON.parse(assistantText.slice(sentinelIdx + 1)) as {
            input_tokens: number
            output_tokens: number
            model: 'sonnet' | 'haiku'
          }
          const rates = COST_PER_TOKEN[usage.model] ?? COST_PER_TOKEN.sonnet
          const callCost = usage.input_tokens * rates.input + usage.output_tokens * rates.output
          setSessionCost((prev) => prev + callCost)
        } catch { /* ignore malformed sentinel */ }
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' },
      ])
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  function close() {
    setOpen(false)
    setMessages([])
    setSessionCost(0)
  }

  return (
    <>
      <style>{`
        @keyframes brendaPulse {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
        @keyframes brendaGlow {
          0%, 100% { box-shadow: 0 0 12px 2px rgba(6,182,212,0.25); }
          50% { box-shadow: 0 0 20px 4px rgba(139,92,246,0.35); }
        }
        @keyframes brendaOnline {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes brendaWave {
          0% { transform: scaleY(0.4); opacity: 0.5; }
          100% { transform: scaleY(1.6); opacity: 1; }
        }
        @keyframes brendaScan {
          0% { left: -2rem; }
          100% { left: 100%; }
        }
        @keyframes brendaHalo {
          0%, 100% { box-shadow: 0 0 8px 3px rgba(6,182,212,0.7); }
          33%  { box-shadow: 0 0 10px 3px rgba(139,92,246,0.7); }
          66%  { box-shadow: 0 0 9px 3px rgba(236,72,153,0.65); }
        }
        @keyframes brendaBeat {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.07); }
        }
      `}</style>

      {/* Slide-in panel */}
      <div
        className={`fixed top-0 left-0 h-full z-50 flex flex-col transition-all duration-300 ease-in-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        } ${expanded ? 'w-[520px]' : 'w-80'}`}
        style={{
          background: 'linear-gradient(160deg, #0a0e1a 0%, #0d1220 60%, #0a0f1f 100%)',
          borderRight: '1px solid rgba(6,182,212,0.15)',
          boxShadow: '4px 0 40px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid rgba(6,182,212,0.12)' }}
        >
          <div className="flex items-center gap-3">
            {/* Avatar */}
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
              style={{
                background: 'linear-gradient(135deg, #06b6d4 0%, #7c3aed 100%)',
                animation: 'brendaGlow 3s ease-in-out infinite',
              }}
            >
              B
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-white text-sm font-semibold tracking-wide">Brenda</span>
                <span
                  className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"
                  style={{ animation: 'brendaOnline 2.5s ease-in-out infinite' }}
                />
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs" style={{ color: 'rgba(6,182,212,0.6)' }}>
                  {activeCard ? `Analyzing: ${activeCard.title}` : 'FTE AI Assistant'}
                </span>
                {sessionCost > 0 && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{
                      background: sessionCost >= 1
                        ? 'rgba(239,68,68,0.15)'
                        : sessionCost >= 0.5
                        ? 'rgba(245,158,11,0.15)'
                        : 'rgba(255,255,255,0.06)',
                      color: sessionCost >= 1
                        ? '#f87171'
                        : sessionCost >= 0.5
                        ? '#fbbf24'
                        : 'rgba(255,255,255,0.35)',
                      border: `1px solid ${sessionCost >= 1 ? 'rgba(239,68,68,0.3)' : sessionCost >= 0.5 ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.1)'}`,
                    }}
                    title={sessionCost >= 0.5 ? 'High credit usage this session — Vision calls are expensive' : 'Estimated session cost'}
                  >
                    {sessionCost >= 1 ? '⚠️ ' : ''}{`~$${sessionCost.toFixed(2)}`}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setExpanded(!expanded)}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
              style={{ color: 'rgba(255,255,255,0.3)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.8)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              aria-label={expanded ? 'Collapse chat' : 'Expand chat'}
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </button>
            <button
              onClick={close}
              className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
              style={{ color: 'rgba(255,255,255,0.3)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.8)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
              aria-label="Close chat"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4" style={{ scrollbarWidth: 'none' }}>
          {messages.length === 0 && (
            <div className="mt-6 text-center space-y-3">
              <div
                className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center text-2xl font-bold text-white"
                style={{
                  background: 'linear-gradient(135deg, #06b6d4 0%, #7c3aed 100%)',
                  boxShadow: '0 0 24px rgba(6,182,212,0.3)',
                }}
              >
                B
              </div>
              <p className="text-white/70 text-sm font-medium">Hi {firstName}, I&apos;m Brenda.</p>
              {activeCard ? (
                <p className="text-white/35 text-xs leading-relaxed px-2">
                  I can see <span className="text-white/60 font-medium">{activeCard.title}</span>. Ask me how well this ad would perform, what could be improved, or how it compares to similar ads.
                </p>
              ) : (
                <p className="text-white/35 text-xs leading-relaxed px-2">
                  Ask me about the board, deadlines, client work, or how to use the platform.
                </p>
              )}
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'assistant' && (
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 mr-2 mt-0.5"
                  style={{ background: 'linear-gradient(135deg, #06b6d4 0%, #7c3aed 100%)' }}
                >
                  B
                </div>
              )}
              <div
                className="max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap"
                style={
                  msg.role === 'user'
                    ? {
                        background: 'linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%)',
                        color: 'white',
                        borderBottomRightRadius: '4px',
                        boxShadow: '0 2px 12px rgba(37,99,235,0.3)',
                      }
                    : {
                        background: 'rgba(255,255,255,0.05)',
                        color: 'rgba(255,255,255,0.88)',
                        borderBottomLeftRadius: '4px',
                        border: '1px solid rgba(6,182,212,0.12)',
                      }
                }
              >
                {msg.content === '' && msg.role === 'assistant' ? <ThinkingIndicator /> : msg.content}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Quick prompts */}
        {messages.length === 0 && (
          <div className="px-4 pb-2 flex flex-wrap gap-1.5">
            {(activeCard
              ? [
                  'Is this on-brand?',
                  'How well would this ad perform?',
                  'What could be improved?',
                  'How does this compare to similar ads?',
                ]
              : [
                  "What's overdue?",
                  "What's in Client Review?",
                  'Board summary',
                  'Cards pending approval',
                ]
            ).map((prompt) => (
              <button
                key={prompt}
                onClick={() => void send(prompt)}
                className="text-xs px-2.5 py-1 rounded-full transition-all"
                style={{
                  background: 'rgba(6,182,212,0.08)',
                  border: '1px solid rgba(6,182,212,0.2)',
                  color: 'rgba(6,182,212,0.8)',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(6,182,212,0.15)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(6,182,212,0.08)' }}
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(6,182,212,0.1)' }}>
          <div
            className="flex gap-2 items-end rounded-2xl px-3 py-2"
            style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(6,182,212,0.15)' }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = `${e.target.scrollHeight}px`
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder="Message Brenda..."
              disabled={loading}
              className="flex-1 bg-transparent text-white placeholder-white/25 text-sm resize-none outline-none disabled:opacity-50"
              style={{ maxHeight: '160px', overflowY: 'auto' }}
            />
            <button
              onClick={() => void send()}
              disabled={loading || !input.trim()}
              className="shrink-0 w-7 h-7 rounded-xl flex items-center justify-center transition-all"
              style={{
                background: input.trim() && !loading
                  ? 'linear-gradient(135deg, #06b6d4 0%, #7c3aed 100%)'
                  : 'rgba(255,255,255,0.08)',
                opacity: loading ? 0.4 : 1,
              }}
              aria-label="Send"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
          <p className="text-center text-xs mt-2" style={{ color: 'rgba(255,255,255,0.15)' }}>
            Enter to send · Shift+Enter for new line
          </p>
        </div>
      </div>

      {/* Backdrop — only covers the panel width so the board remains interactive */}
      {open && (
        <div
          className="fixed top-0 left-0 h-full z-40"
          style={{ width: expanded ? '520px' : '320px' }}
          onClick={close}
        />
      )}

      {/* FAB */}
      <div className="fixed bottom-6 right-6 z-50">
        <button
          onClick={() => { if (open) setMessages([]); setOpen(!open) }}
          className="h-12 rounded-full text-white flex items-center justify-center transition-all duration-200"
          style={{
            background: 'linear-gradient(135deg, #06b6d4 0%, #7c3aed 100%)',
            width: open ? '48px' : 'auto',
            padding: open ? '0' : '0 18px',
            gap: '8px',
            animation: !open ? 'brendaHalo 3s ease-in-out infinite, brendaBeat 3s ease-in-out infinite' : 'none',
          }}
          aria-label="Chat with Brenda"
          title="Chat with Brenda"
        >
        {open ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span className="text-sm font-semibold tracking-wide">Brenda</span>
          </>
        )}
        </button>
      </div>
    </>
  )
}
