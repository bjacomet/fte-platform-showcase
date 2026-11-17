'use client'

import { useMemo, useState } from 'react'
import type {
  MessengerWelcome,
  MessengerButton,
  MessengerGenericElement,
} from '@/types'
import { drawerInputClass, drawerLabelClass } from '@/lib/formStyles'

// The Messenger Ad welcome-message editor. Builds the click-to-Messenger
// `{ message: ... }` blob that gets pasted into the Ads Manager creative.
// Pure content editor — no Facebook API involvement.

const TITLE_MAX = 20

type MsgType = 'button' | 'quick' | 'generic' | 'text'

interface BtnModel { type: 'web_url' | 'postback'; title: string; url: string; reply: string }
interface QrModel { title: string; reply: string }
interface CardModel { title: string; subtitle: string; image_url: string; buttons: BtnModel[] }
interface Model { type: MsgType; text: string; buttons: BtnModel[]; quick: QrModel[]; cards: CardModel[] }

const TYPE_HINTS: Record<MsgType, string> = {
  button: 'A message with up to 3 tappable buttons — links, or preset questions that show a pre-made answer when tapped (Facebook FAQ style, no bot).',
  quick: 'Preset question chips shown under the message — tapping one shows your pre-made answer. Mirrors Facebook’s FAQ / preset-answer builder; no bot or payload delivery.',
  generic: 'A horizontally scrollable carousel of cards with image, text, and buttons.',
  text: 'A plain welcome message with no buttons.',
}

function emptyBtn(): BtnModel { return { type: 'web_url', title: '', url: '', reply: '' } }
function emptyCard(): CardModel { return { title: '', subtitle: '', image_url: '', buttons: [emptyBtn()] } }

// Postback buttons still need a payload in the emitted JSON (Meta requires it), but
// it's no longer user-editable — derive a stable one from the title.
function toPayload(title: string): string {
  return title.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'POSTBACK'
}

function mapBtnIn(b: MessengerButton, replies: Record<string, string>): BtnModel {
  return b.type === 'web_url'
    ? { type: 'web_url', title: b.title, url: b.url, reply: '' }
    : { type: 'postback', title: b.title, url: '', reply: replies[b.title] ?? '' }
}

function parseValue(v: MessengerWelcome | null): Model {
  const base: Model = { type: 'button', text: '', buttons: [emptyBtn()], quick: [], cards: [] }
  const m = v?.message
  const replies = v?.replies ?? {}
  if (!m) return base
  if (m.quick_replies?.length) {
    return { type: 'quick', text: m.text ?? '', buttons: [], quick: m.quick_replies.map((q) => ({ title: q.title, reply: replies[q.title] ?? '' })), cards: [] }
  }
  const p = m.attachment?.payload
  if (p?.template_type === 'button') {
    return { type: 'button', text: p.text, buttons: p.buttons.length ? p.buttons.map((b) => mapBtnIn(b, replies)) : [emptyBtn()], quick: [], cards: [] }
  }
  if (p?.template_type === 'generic') {
    return { type: 'generic', text: '', buttons: [], quick: [], cards: p.elements.length ? p.elements.map((e) => ({ title: e.title, subtitle: e.subtitle ?? '', image_url: e.image_url ?? '', buttons: (e.buttons ?? []).map((b) => mapBtnIn(b, replies)) })) : [emptyCard()] }
  }
  if (typeof m.text === 'string') return { type: 'text', text: m.text, buttons: [], quick: [], cards: [] }
  return base
}

function cleanBtns(btns: BtnModel[]): MessengerButton[] {
  return btns
    .filter((b) => b.title.trim())
    .map((b): MessengerButton =>
      b.type === 'web_url'
        ? { type: 'web_url', title: b.title, url: b.url }
        : { type: 'postback', title: b.title, payload: toPayload(b.title) })
}

// Collect the preview-only auto-replies, keyed by button / quick-reply title.
function collectReplies(m: Model): Record<string, string> {
  const out: Record<string, string> = {}
  const add = (title: string, reply: string) => {
    const t = title.trim()
    const r = reply.trim()
    if (t && r) out[t] = r
  }
  if (m.type === 'button') m.buttons.forEach((b) => { if (b.type === 'postback') add(b.title, b.reply) })
  if (m.type === 'quick') m.quick.forEach((q) => add(q.title, q.reply))
  if (m.type === 'generic') m.cards.forEach((c) => c.buttons.forEach((b) => { if (b.type === 'postback') add(b.title, b.reply) }))
  return out
}

// The full stored value: the Meta-faithful message plus the preview-only replies.
function buildValue(m: Model): MessengerWelcome | null {
  const built = buildMessage(m)
  if (!built) return null
  const replies = collectReplies(m)
  return Object.keys(replies).length ? { message: built.message, replies } : { message: built.message }
}

// The copyable page_welcome_message — message only, no replies (Meta schema).
function buildMessage(m: Model): MessengerWelcome | null {
  if (m.type === 'text') {
    return m.text.trim() ? { message: { text: m.text } } : null
  }
  if (m.type === 'quick') {
    const qrs = m.quick.filter((q) => q.title.trim()).map((q) => ({ content_type: 'text' as const, title: q.title, payload: toPayload(q.title) }))
    return qrs.length ? { message: { text: m.text, quick_replies: qrs } } : null
  }
  if (m.type === 'button') {
    const buttons = cleanBtns(m.buttons)
    return buttons.length ? { message: { attachment: { type: 'template', payload: { template_type: 'button', text: m.text, buttons } } } } : null
  }
  const elements: MessengerGenericElement[] = m.cards
    .filter((c) => c.title.trim())
    .map((c) => {
      const el: MessengerGenericElement = { title: c.title }
      if (c.subtitle.trim()) el.subtitle = c.subtitle
      if (c.image_url.trim()) el.image_url = c.image_url
      const b = cleanBtns(c.buttons)
      if (b.length) el.buttons = b
      return el
    })
  return elements.length ? { message: { attachment: { type: 'template', payload: { template_type: 'generic', elements } } } } : null
}

function validate(m: Model): { errs: string[]; warns: string[] } {
  const errs: string[] = []
  const warns: string[] = []
  const isHttps = (u: string) => /^https:\/\//i.test(u)

  const checkBtns = (btns: BtnModel[], where: string) => {
    if (btns.length > 3) errs.push(`${where}: more than 3 buttons (max 3).`)
    btns.forEach((b, i) => {
      const tag = `${where} button ${i + 1}`
      if (!b.title.trim()) { errs.push(`${tag}: title is empty.`); return }
      if (b.title.length > TITLE_MAX) errs.push(`${tag}: title over ${TITLE_MAX} chars.`)
      if (b.type === 'web_url') {
        if (!b.url.trim()) errs.push(`${tag}: link URL is empty.`)
        else if (!isHttps(b.url)) warns.push(`${tag}: URL should start with https://`)
      } else if (!b.reply.trim()) {
        warns.push(`${tag}: no preset answer set (nothing shows when tapped).`)
      }
    })
  }

  if (m.type !== 'generic' && !m.text.trim()) errs.push('Message text is empty.')

  if (m.type === 'button') {
    const b = m.buttons.filter((x) => x.title.trim())
    if (!b.length) errs.push('Add at least one button.')
    checkBtns(b, 'Buttons')
  }
  if (m.type === 'quick') {
    const qs = m.quick.filter((q) => q.title.trim())
    if (!qs.length) errs.push('Add at least one quick reply.')
    if (qs.length > 13) errs.push('More than 13 quick replies (max 13).')
    qs.forEach((q, i) => {
      if (q.title.length > TITLE_MAX) errs.push(`Quick reply ${i + 1}: title over ${TITLE_MAX} chars.`)
      if (!q.reply.trim()) warns.push(`Preset question ${i + 1}: no preset answer set (nothing shows when tapped).`)
    })
  }
  if (m.type === 'generic') {
    const cs = m.cards.filter((c) => c.title.trim())
    if (!cs.length) errs.push('Add at least one card (with a title).')
    if (cs.length > 10) errs.push('More than 10 cards (max 10).')
    cs.forEach((c, i) => {
      checkBtns(c.buttons.filter((x) => x.title.trim()), `Card ${i + 1}`)
      if (c.image_url.trim() && !isHttps(c.image_url)) warns.push(`Card ${i + 1}: image URL should start with https://`)
    })
  }
  return { errs, warns }
}

const TYPES: { key: MsgType; label: string }[] = [
  { key: 'button', label: 'Buttons' },
  { key: 'quick', label: 'Quick replies' },
  { key: 'generic', label: 'Cards' },
  { key: 'text', label: 'Text only' },
]

interface Props {
  value: MessengerWelcome | null
  onChange: (v: MessengerWelcome | null) => void
  /** Live page name (card.fb_page_name) — drives the preview's conversation header. */
  pageName?: string
  /** Client's Facebook page logo (clients.fb_page_logo_url) for the preview avatar. */
  pageLogoUrl?: string | null
}

export default function MessengerWelcomeEditor({ value, onChange, pageName, pageLogoUrl }: Props) {
  const [model, setModel] = useState<Model>(() => parseValue(value))
  const [copied, setCopied] = useState(false)
  const [convo, setConvo] = useState<{ user: string; reply: string }[]>([])

  const built = useMemo(() => buildMessage(model), [model])
  const json = useMemo(() => (built ? JSON.stringify(built, null, 2) : ''), [built])
  const { errs, warns } = useMemo(() => validate(model), [model])

  const lbl = drawerLabelClass
  const inp = drawerInputClass

  function update(next: Model) {
    setModel(next)
    onChange(buildValue(next))
  }
  function setType(type: MsgType) {
    const next: Model = { ...model, type }
    if (type === 'button' && !next.buttons.length) next.buttons = [emptyBtn()]
    if (type === 'quick' && !next.quick.length) next.quick = [{ title: '', reply: '' }]
    if (type === 'generic' && !next.cards.length) next.cards = [emptyCard()]
    setConvo([])
    update(next)
  }

  // ── button repeater helpers (shared by button template + card buttons) ──────
  function renderButtonRow(b: BtnModel, onB: (nb: BtnModel) => void, onRemove: () => void, label: string) {
    return (
      <div className="bg-gray-800/60 border border-gray-700/60 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{label}</span>
          <button type="button" onClick={onRemove} className="text-gray-600 hover:text-red-400 text-[10px] transition-colors">Remove</button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-0.5">
            <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Type</label>
            <select value={b.type} onChange={(e) => onB({ ...b, type: e.target.value as BtnModel['type'] })} className={inp}>
              <option value="web_url">Link (web_url)</option>
              <option value="postback">Postback</option>
            </select>
          </div>
          <div className="space-y-0.5">
            <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">
              Title <span className={`normal-case ${b.title.length > TITLE_MAX ? 'text-red-400' : 'text-gray-600'}`}>{b.title.length}/{TITLE_MAX}</span>
            </label>
            <input value={b.title} maxLength={40} onChange={(e) => onB({ ...b, title: e.target.value })} className={inp} placeholder="Show me the product!" />
          </div>
          {b.type === 'web_url' ? (
            <div className="col-span-2 space-y-0.5">
              <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">URL</label>
              <input value={b.url} onChange={(e) => onB({ ...b, url: e.target.value })} className={inp} placeholder="https://www.example.com/" />
            </div>
          ) : (
            <div className="col-span-2 space-y-0.5">
              <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Preset answer <span className="normal-case text-gray-600">(shown on tap · rebuild in Facebook)</span></label>
              <input value={b.reply} onChange={(e) => onB({ ...b, reply: e.target.value })} className={inp} placeholder="Thanks! A team member will reach out shortly." />
            </div>
          )}
        </div>
      </div>
    )
  }

  function updateButtons(list: BtnModel[]) { update({ ...model, buttons: list }) }
  function updateCards(list: CardModel[]) { update({ ...model, cards: list }) }
  function updateQuick(list: QrModel[]) { update({ ...model, quick: list }) }

  function sendConvo(user: string, reply: string) { setConvo((c) => [...c, { user, reply }]) }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest">Messenger Content</span>
        <div className="flex-1 h-px bg-gray-700/60" />
      </div>

      {/* type selector */}
      <div>
        <label className={lbl}>Message type</label>
        <div className="grid grid-cols-4 gap-1.5">
          {TYPES.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setType(t.key)}
              className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                model.type === t.key
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-gray-900 border-gray-600 text-gray-400 hover:text-white hover:border-blue-500'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-gray-500 leading-snug pt-1">{TYPE_HINTS[model.type]}</p>
      </div>

      {/* message text (not for generic) */}
      {model.type !== 'generic' && (
        <div>
          <label className={lbl}>Message text</label>
          <textarea
            value={model.text}
            maxLength={640}
            onChange={(e) => update({ ...model, text: e.target.value })}
            className={`${inp} resize-none`}
            rows={2}
            placeholder="Hi! Please let us know how we can help you."
          />
        </div>
      )}

      {/* Buttons */}
      {model.type === 'button' && (
        <div className="space-y-2">
          <label className={lbl}>Buttons <span className="normal-case text-gray-600">(max 3)</span></label>
          {model.buttons.map((b, i) => (
            <div key={i}>
              {renderButtonRow(
                b,
                (nb) => updateButtons(model.buttons.map((x, j) => (j === i ? nb : x))),
                () => updateButtons(model.buttons.filter((_, j) => j !== i)),
                'Button',
              )}
            </div>
          ))}
          {model.buttons.length < 3 && (
            <button type="button" onClick={() => updateButtons([...model.buttons, emptyBtn()])} className="w-full py-2 border border-dashed border-gray-600 rounded text-sm text-gray-400 hover:text-gray-200 hover:border-gray-400 transition-colors">+ Add button</button>
          )}
        </div>
      )}

      {/* Quick replies */}
      {model.type === 'quick' && (
        <div className="space-y-2">
          <label className={lbl}>Quick replies <span className="normal-case text-gray-600">(max 13)</span></label>
          {model.quick.map((q, i) => (
            <div key={i} className="bg-gray-800/60 border border-gray-700/60 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Quick reply</span>
                <button type="button" onClick={() => updateQuick(model.quick.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 text-[10px] transition-colors">Remove</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-0.5">
                  <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                    Title <span className={`normal-case ${q.title.length > TITLE_MAX ? 'text-red-400' : 'text-gray-600'}`}>{q.title.length}/{TITLE_MAX}</span>
                  </label>
                  <input value={q.title} maxLength={40} onChange={(e) => updateQuick(model.quick.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} className={inp} placeholder="Tell me more" />
                </div>
                <div className="space-y-0.5">
                  <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Preset answer <span className="normal-case text-gray-600">(shown on tap · rebuild in Facebook)</span></label>
                  <input value={q.reply} onChange={(e) => updateQuick(model.quick.map((x, j) => (j === i ? { ...x, reply: e.target.value } : x)))} className={inp} placeholder="Great — here's the link!" />
                </div>
              </div>
            </div>
          ))}
          {model.quick.length < 13 && (
            <button type="button" onClick={() => updateQuick([...model.quick, { title: '', reply: '' }])} className="w-full py-2 border border-dashed border-gray-600 rounded text-sm text-gray-400 hover:text-gray-200 hover:border-gray-400 transition-colors">+ Add quick reply</button>
          )}
        </div>
      )}

      {/* Cards */}
      {model.type === 'generic' && (
        <div className="space-y-2">
          <label className={lbl}>Cards <span className="normal-case text-gray-600">(max 10)</span></label>
          {model.cards.map((c, i) => (
            <div key={i} className="bg-gray-800/60 border border-gray-700/60 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Card {i + 1}</span>
                <button type="button" onClick={() => updateCards(model.cards.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400 text-[10px] transition-colors">Remove</button>
              </div>
              <div className="space-y-2">
                <div className="space-y-0.5">
                  <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Title</label>
                  <input value={c.title} maxLength={80} onChange={(e) => updateCards(model.cards.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} className={inp} placeholder="2024 Honda Accord" />
                </div>
                <div className="space-y-0.5">
                  <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Subtitle</label>
                  <input value={c.subtitle} maxLength={80} onChange={(e) => updateCards(model.cards.map((x, j) => (j === i ? { ...x, subtitle: e.target.value } : x)))} className={inp} placeholder="Starting at $28,990" />
                </div>
                <div className="space-y-0.5">
                  <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Image URL</label>
                  <input value={c.image_url} onChange={(e) => updateCards(model.cards.map((x, j) => (j === i ? { ...x, image_url: e.target.value } : x)))} className={inp} placeholder="https://.../accord.jpg" />
                </div>
              </div>
              <div className="border-t border-dashed border-gray-700 pt-2 space-y-2">
                <label className="block text-[10px] font-medium text-gray-500 uppercase tracking-wide">Card buttons <span className="normal-case text-gray-600">(max 3)</span></label>
                {c.buttons.map((b, bi) => (
                  <div key={bi}>
                    {renderButtonRow(
                      b,
                      (nb) => updateCards(model.cards.map((x, j) => (j === i ? { ...x, buttons: x.buttons.map((y, k) => (k === bi ? nb : y)) } : x))),
                      () => updateCards(model.cards.map((x, j) => (j === i ? { ...x, buttons: x.buttons.filter((_, k) => k !== bi) } : x))),
                      'Button',
                    )}
                  </div>
                ))}
                {c.buttons.length < 3 && (
                  <button type="button" onClick={() => updateCards(model.cards.map((x, j) => (j === i ? { ...x, buttons: [...x.buttons, emptyBtn()] } : x)))} className="w-full py-1.5 border border-dashed border-gray-600 rounded text-xs text-gray-400 hover:text-gray-200 hover:border-gray-400 transition-colors">+ Add button</button>
                )}
              </div>
            </div>
          ))}
          {model.cards.length < 10 && (
            <button type="button" onClick={() => updateCards([...model.cards, emptyCard()])} className="w-full py-2 border border-dashed border-gray-600 rounded text-sm text-gray-400 hover:text-gray-200 hover:border-gray-400 transition-colors">+ Add card</button>
          )}
        </div>
      )}

      {/* Output. The live preview is the deliverable. The raw page_welcome_message JSON is
          sidelined into a collapsed "Developer JSON" disclosure — it's only actionable once a
          payload-driven bot can be wired in Facebook. Meta's current click-to-Messenger flow
          builds the prompts in Ads Manager's UI (no JSON paste), so there's nothing to paste
          the blob into today; the preview + preset answers are what the team works from. */}
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        {/* status — content sanity, not paste-readiness */}
        <div className={`px-3 py-2 text-xs border-b border-gray-700 ${errs.length ? 'bg-red-950/40 text-red-300' : warns.length ? 'bg-amber-950/40 text-amber-300' : 'bg-emerald-950/40 text-emerald-300'}`}>
          {errs.length ? (
            <div><span className="font-bold">Needs attention</span><ul className="list-disc ml-4 mt-1">{errs.map((e, i) => <li key={i}>{e}</li>)}</ul></div>
          ) : warns.length ? (
            <div><span className="font-bold">Looks good, with notes</span><ul className="list-disc ml-4 mt-1">{warns.map((e, i) => <li key={i}>{e}</li>)}</ul></div>
          ) : (
            <span className="font-bold">Looks good</span>
          )}
        </div>

        <MessengerPreview model={model} convo={convo} onSend={sendConvo} onReset={() => setConvo([])} pageName={pageName} pageLogoUrl={pageLogoUrl} />

        {/* Developer JSON — sidelined until bots can be built in Facebook. Kept intact for that day. */}
        <details className="border-t border-gray-700 bg-gray-900">
          <summary className="px-3 py-2 text-[11px] text-gray-400 cursor-pointer select-none hover:text-gray-200">
            Developer JSON <span className="text-gray-600">— page_welcome_message, for future bot / API use only</span>
          </summary>
          <div className="px-3 pb-3">
            <div className="flex justify-end mb-2">
              <button
                type="button"
                disabled={!json}
                onClick={() => { if (json) { navigator.clipboard.writeText(json); setCopied(true); setTimeout(() => setCopied(false), 1400) } }}
                className="px-3 py-1 rounded text-xs font-semibold bg-gray-700 text-gray-200 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
            </div>
            <pre className="p-3 text-xs font-mono text-gray-200 bg-gray-950 rounded overflow-x-auto whitespace-pre" style={{ tabSize: 2 }}>{json || '// add content to generate JSON'}</pre>
          </div>
        </details>
      </div>
    </div>
  )
}

// ── interactive Messenger-style preview ─────────────────────────────────────
// Aesthetic tracks the Facebook feed preview (components/FacebookAdPreview.tsx):
// real page name/logo, FB system font, FB color tokens (#050505 / #65676B /
// #0084FF Messenger blue), so a Messenger Ad reads as authentically as an FB ad.

// Page avatar — real logo if the client has one, else a brand-blue initials chip.
// Mirrors PageAvatar in FacebookAdPreview.tsx.
function PageAvatar({ name, logoUrl, size }: { name: string; logoUrl?: string | null; size: number }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={name} className="rounded-full object-cover flex-none" style={{ width: size, height: size }} />
  }
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'P'
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold flex-none"
      style={{ width: size, height: size, backgroundColor: '#0084FF', fontSize: Math.round(size * 0.4) }}
    >
      {initials}
    </div>
  )
}

function PreviewButton({ b, onSend }: { b: BtnModel; onSend: (title: string, reply: string) => void }) {
  if (b.type === 'web_url') {
    return (
      <a href={b.url || '#'} target="_blank" rel="noopener noreferrer" className="block w-full text-center px-3 py-2.5 border-t border-gray-200 text-sm font-semibold text-[#0084FF] hover:bg-blue-50 transition-colors">
        {b.title || '(untitled)'} <span className="text-[11px] opacity-60">↗</span>
      </a>
    )
  }
  return (
    <button type="button" onClick={() => onSend(b.title || '(untitled)', b.reply)} className="block w-full text-center px-3 py-2.5 border-t border-gray-200 text-sm font-semibold text-[#0084FF] hover:bg-blue-50 transition-colors">
      {b.title || '(untitled)'}
    </button>
  )
}

function MessengerPreview({ model, convo, onSend, onReset, pageName, pageLogoUrl }: {
  model: Model
  convo: { user: string; reply: string }[]
  onSend: (title: string, reply: string) => void
  onReset: () => void
  pageName?: string
  pageLogoUrl?: string | null
}) {
  const text = model.text.trim()
  const name = pageName?.trim() || 'Your Page'
  const quicks = model.type === 'quick' ? model.quick.filter((q) => q.title.trim()) : []

  return (
    <div className="font-sans bg-white flex flex-col select-none" style={{ height: 460 }}>
      {/* Conversation header — page identity + Messenger chrome */}
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-gray-200 bg-white flex-none">
        <svg className="w-5 h-5 text-[#0084FF] flex-none" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        <PageAvatar name={name} logoUrl={pageLogoUrl} size={32} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-[#050505] leading-tight truncate">{name}</div>
          <div className="text-[11px] text-[#65676B] leading-tight flex items-center gap-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#31a24c]" />
            Active now
          </div>
        </div>
        <div className="flex items-center gap-3 text-[#0084FF] flex-none">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" /></svg>
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM14.553 7.106A1 1 0 0014 8v4a1 1 0 00.553.894l2 1A1 1 0 0018 13V7a1 1 0 00-1.447-.894l-2 1z" /></svg>
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" /></svg>
        </div>
      </div>

      {/* Message thread */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2 bg-white">
        {convo.length > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="self-center mb-1 flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#f0f2f5] text-[11px] font-medium text-[#65676B] hover:text-[#050505] hover:bg-gray-200 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Restart preview
          </button>
        )}
        {model.type === 'text' && (
          <Bubble>{text || <span className="text-[#8a8d91]">(empty message)</span>}</Bubble>
        )}

        {model.type === 'quick' && (
          text ? <Bubble>{text}</Bubble> : <Bubble><span className="text-[#8a8d91]">(add a message above the quick replies)</span></Bubble>
        )}

        {model.type === 'button' && (
          <div className="self-start max-w-[85%] bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
            <div className="px-3.5 py-2.5 text-sm text-[#050505] whitespace-pre-wrap">{text || <span className="text-[#8a8d91]">(empty message)</span>}</div>
            {model.buttons.filter((b) => b.title.trim()).map((b, i) => <PreviewButton key={i} b={b} onSend={onSend} />)}
          </div>
        )}

        {model.type === 'generic' && (
          <div className="flex gap-2.5 overflow-x-auto pb-1">
            {model.cards.filter((c) => c.title.trim()).length === 0 && <div className="text-xs text-[#8a8d91] italic">Add a card to preview the carousel.</div>}
            {model.cards.filter((c) => c.title.trim()).map((c, i) => (
              <div key={i} className="flex-none w-[230px] bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
                <div className="h-32 bg-gray-200 bg-cover bg-center flex items-center justify-center text-[11px] text-[#8a8d91]" style={c.image_url ? { backgroundImage: `url('${c.image_url.replace(/'/g, "%27")}')` } : undefined}>
                  {!c.image_url && 'No image'}
                </div>
                <div className="px-3 py-2.5">
                  <div className="text-[13px] font-semibold text-[#050505]">{c.title}</div>
                  {c.subtitle.trim() && <div className="text-xs text-[#65676B] mt-0.5">{c.subtitle}</div>}
                </div>
                {c.buttons.filter((b) => b.title.trim()).map((b, bi) => <PreviewButton key={bi} b={b} onSend={onSend} />)}
              </div>
            ))}
          </div>
        )}

        {convo.map((c, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="self-end max-w-[80%] text-white text-sm px-3.5 py-2 rounded-2xl rounded-br-md" style={{ backgroundColor: '#0084FF' }}>{c.user}</div>
            {c.reply.trim()
              ? <Bubble>{c.reply}</Bubble>
              : <div className="self-start text-[11px] text-[#8a8d91] italic">No preset answer set for this question yet.</div>}
          </div>
        ))}
      </div>

      {/* Quick replies — left-aligned, single horizontally-scrolling row above the composer (real Messenger placement) */}
      {quicks.length > 0 && (
        <div className="flex-none flex gap-2 px-3 py-2 overflow-x-auto border-t border-gray-100 bg-white">
          {quicks.map((q, i) => (
            <button key={i} type="button" onClick={() => onSend(q.title, q.reply)} className="flex-none px-3 py-1.5 rounded-full border-[1.5px] border-[#0084FF] text-[#0084FF] bg-white text-xs font-semibold whitespace-nowrap hover:bg-blue-50 transition-colors">{q.title}</button>
          ))}
        </div>
      )}

      {/* Faux composer bar */}
      <div className="flex-none flex items-center gap-2 px-3 py-2 border-t border-gray-200 bg-white">
        <div className="flex-1 bg-[#f0f2f5] rounded-full px-3.5 py-1.5 text-[13px] text-[#8a8d91]">Type a message…</div>
        <svg className="w-5 h-5 text-[#0084FF] flex-none" fill="currentColor" viewBox="0 0 20 20"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg>
      </div>
    </div>
  )
}

function Bubble({ children }: { children: React.ReactNode }) {
  return <div className="self-start max-w-[80%] bg-[#f0f0f0] text-[#050505] text-sm px-3.5 py-2 rounded-2xl rounded-bl-md whitespace-pre-wrap">{children}</div>
}
