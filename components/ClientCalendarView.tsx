'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import type { Card, CarouselSlide, Client, TemplateOption } from '@/types'
import {
  formatMonth,
  formatPostDate,
  nextMonth,
  prevMonth,
} from '@/lib/calendar'
import FacebookAdPreview from './FacebookAdPreview'
import FacebookCarouselPreview from './FacebookCarouselPreview'
import ExternalRef from './ExternalRef'
import ViewToggle from './calendar/ViewToggle'
import { useCalendarView } from './calendar/useCalendarView'
import CalendarGridView from './calendar/CalendarGridView'
import CalendarListView from './calendar/CalendarListView'

export interface CalendarClient {
  id: string
  name: string
  fb_page_logo_url: string | null
}

export interface CalendarPost {
  id: string
  title: string
  media_type: string | null
  flight_start_date: string | null
  fb_page_name: string | null
  fb_body_text: string | null
  fb_headline: string | null
  fb_link_description: string | null
  fb_cta: string | null
  landing_page_url: string | null
  image_url: string | null
  carousel_slides: Array<{
    id: string
    position: number
    headline: string | null
    link_description: string | null
    landing_page_url: string | null
    image_url: string | null
    adpiler_preview_url?: string | null
  }>
}

interface Props {
  token: string
  client: CalendarClient
  year: number
  month: number
  boxLinkUrl: string | null
  posts: CalendarPost[]
}

// Build a Card-shaped object carrying only the fields the FB preview components
// actually read. Unused fields get safe defaults so TypeScript is happy.
function toCard(post: CalendarPost, clientId: string): Card {
  return {
    id: post.id,
    title: post.title,
    client_id: clientId,
    column_id: '',
    atlas_location_id: null,
    media_type: post.media_type as TemplateOption | null,
    assignee_id: null,
    referenced_card_id: null,
    description: null,
    position: 0,
    approval_token: null,
    approval_status: 'none',
    work_status: null,
    adviewer_standalone: false,
    archived: false,
    landing_page_url: post.landing_page_url,
    utm_campaign: null,
    utm_channel: null,
    creative_name: null,
    flight_month: null,
    flight_start_date: post.flight_start_date,
    flight_end_date: null,
    box_folder_id: null,
    ttd_ad_group_id: null,
    ttd_ad_group_ids: null,
    client_comments: null,
    creative_brief: null,
    fb_page_name: post.fb_page_name,
    fb_body_text: post.fb_body_text,
    fb_headline: post.fb_headline,
    fb_subheadline: null,
    fb_link_description: post.fb_link_description,
    fb_cta: post.fb_cta,
    calendar_only: false,
    preview_image_url: post.image_url,
    source_card_id: null,
    run_number: 1,
    adpiler_preview_url: null,
    tier: null,
    first_draft_deadline: null,
    build_link: null,
    display_build_link: null,
    heading: null,
    subheading: null,
    button_text: null,
    caption: null,
    boost_budget: null,
    companion_banner_link: null,
    event_description: null,
    revisions: null,
    client_portal_status: null,
    inventory_unit_id: null,
    fb_campaign_id: null,
    fb_ad_id: null,
    fb_published_at: null,
    messenger_welcome: null,
    instant_experience: null,
    restart_requested_at: null,
    restart_requested_by: null,
    restart_note: null,
    is_pending: false,
    pre_pending_column_id: null,
    created_at: '',
    updated_at: '',
  }
}

function toClient(c: CalendarClient): Client {
  return {
    id: c.id,
    name: c.name,
    abbreviation: null,
    adpiler_campaign_code: null,
    fb_page_logo_url: c.fb_page_logo_url,
    utm_config: null,
    calendar_share_token: null,
    review_token: null,
    active: true,
    created_at: '',
    brand_notes: null,
    box_brand_file_id: null,
    brand_website_url: null,
    fb_ad_account_id: null,
  }
}

function toSlides(post: CalendarPost): CarouselSlide[] {
  return post.carousel_slides.map((s) => ({
    id: s.id,
    card_id: post.id,
    position: s.position,
    headline: s.headline,
    subheadline: null,
    link_description: s.link_description,
    display_link: null,
    graphic_headline: null,
    graphic_subhead: null,
    landing_page_url: s.landing_page_url,
    image_url: s.image_url,
    adpiler_preview_url: s.adpiler_preview_url ?? null,
    created_at: '',
    updated_at: '',
  }))
}

export default function ClientCalendarView({
  token,
  client,
  year,
  month,
  boxLinkUrl,
  posts,
}: Props) {
  const router = useRouter()
  const [view, setView] = useCalendarView()
  const prev = prevMonth(year, month)
  const next = nextMonth(year, month)
  const clientAsClient = toClient(client)

  // Pre-build Card shapes once per render — Grid and List both want Card[].
  const cards = useMemo(() => posts.map((p) => toCard(p, client.id)), [posts, client.id])
  const imageUrlByCardId = useMemo(() => {
    const out: Record<string, string | null> = {}
    for (const p of posts) out[p.id] = p.image_url
    return out
  }, [posts])
  const clientsById = useMemo(
    () => ({ [client.id]: clientAsClient }),
    [client.id, clientAsClient]
  )

  function navigateMonth(y: number, m: number) {
    router.push(`/calendar/${token}?year=${y}&month=${m}`)
  }

  // The shell colour depends on the active view — feed stays FB-themed (light)
  // while grid + list use the same dark surface as the staff calendar.
  const shellBg = view === 'feed' ? 'bg-[#F0F2F5]' : 'bg-[#0f1117]'

  return (
    <div className={`min-h-screen ${shellBg}`}>

      {/* Header — client identity + month navigation. Always FB-styled. */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-[640px] mx-auto px-4 py-4 flex items-center gap-3">
          {client.fb_page_logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={client.fb_page_logo_url}
              alt={client.name}
              className="w-12 h-12 rounded-full object-cover border border-gray-200"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-[#1877F2] text-white font-bold flex items-center justify-center text-sm">
              {client.name.split(' ').slice(0, 2).map((w) => w[0]).join('').toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-[#050505] leading-tight truncate">{client.name}</h1>
            <p className="text-xs text-[#65676B]">Content Calendar</p>
          </div>
        </div>

        {/* Month switcher + view toggle */}
        <div className="max-w-[640px] mx-auto px-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigateMonth(prev.year, prev.month)}
              className="text-xs text-[#1877F2] hover:underline flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              {formatMonth(prev.year, prev.month)}
            </button>
            <p className="text-sm font-semibold text-[#050505]">{formatMonth(year, month)}</p>
            <button
              onClick={() => navigateMonth(next.year, next.month)}
              className="text-xs text-[#1877F2] hover:underline flex items-center gap-1"
            >
              {formatMonth(next.year, next.month)}
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <ViewToggle value={view} onChange={setView} variant="light" />
        </div>

        {/* Monthly Box link */}
        {boxLinkUrl && (
          <div className="max-w-[640px] mx-auto px-4 pb-3">
            <ExternalRef url={boxLinkUrl} note="this month's creative" />
          </div>
        )}
      </header>

      {/* Body — switch by view */}
      <main className={view === 'feed' ? 'py-8 px-4' : 'text-gray-100'}>
        {posts.length === 0 ? (
          <div className="max-w-[500px] mx-auto text-center mt-16 py-8">
            <p className={`text-sm ${view === 'feed' ? 'text-[#65676B]' : 'text-gray-400'}`}>
              No posts scheduled for {formatMonth(year, month)} yet.
            </p>
            <p className={`text-xs mt-2 ${view === 'feed' ? 'text-[#8a8d91]' : 'text-gray-600'}`}>
              Check back soon, or use the month arrows above to browse.
            </p>
          </div>
        ) : view === 'grid' ? (
          <CalendarGridView
            cards={cards}
            year={year}
            month={month}
            imageUrlByCardId={imageUrlByCardId}
            onCardClick={() => { /* read-only on client share — no drawer */ }}
          />
        ) : view === 'list' ? (
          <CalendarListView
            cards={cards}
            imageUrlByCardId={imageUrlByCardId}
            clientsById={clientsById}
            onCardClick={() => { /* read-only on client share — no drawer */ }}
          />
        ) : (
          <div className="flex flex-col gap-8">
            {posts.map((post) => {
              const isCarousel = post.media_type === 'Carousel Ad'
              const card = toCard(post, client.id)
              return (
                <div key={post.id} className="flex flex-col items-center">
                  <div className="w-full max-w-[500px] mb-2">
                    <p className="text-xs text-[#65676B] font-medium">
                      {formatPostDate(post.flight_start_date)}
                    </p>
                  </div>
                  {isCarousel ? (
                    <FacebookCarouselPreview
                      card={card}
                      client={clientAsClient}
                      slides={toSlides(post)}
                    />
                  ) : (
                    <FacebookAdPreview
                      card={card}
                      client={clientAsClient}
                      previewImageUrl={post.image_url}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </main>

      <footer
        className={`py-6 text-center text-[11px] ${
          view === 'feed' ? 'text-[#8a8d91]' : 'text-gray-600'
        }`}
      >
        Follow The Eyes · Content Calendar
      </footer>
    </div>
  )
}
