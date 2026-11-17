import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveReviewToken } from '@/lib/adviewerReviewToken'

const resend = new Resend(process.env.RESEND_API_KEY)

interface ReviewedItem {
  title: string
  status: 'approved' | 'needs_revision'
  note?: string
}

interface NotifyPayload {
  /**
   * The token the reviewer's page was opened with — a campaign token for
   * corporate, a per-location scope token for a location. Named for history;
   * it is resolved through resolveReviewToken, not assumed to be a campaign.
   */
  campaign_token: string
  reviewer: string
  reviewerEmail?: string
  campaignTitle: string
  clientName: string
  items: ReviewedItem[]
  // NOTE: which board cards get moved is derived server-side from the campaign's
  // own linked cards (adviewer_campaign_cards.status), NOT from the request body.
  // Trusting body-supplied card IDs let any token holder mutate arbitrary cards.
}

function statusLabel(s: string) {
  return s === 'approved' ? '✅ Approved' : '📌 Change Request'
}

function buildHtml(payload: NotifyPayload, hasRevisions: boolean, locationName: string | null) {
  const rows = payload.items.map(item => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:10px 12px;font-size:13px;color:#111827;">${item.title}</td>
      <td style="padding:10px 12px;font-size:13px;">${statusLabel(item.status)}</td>
      <td style="padding:10px 12px;font-size:13px;color:#6b7280;">${item.note ?? '—'}</td>
    </tr>
  `).join('')

  // Atlas sends ~22 of these per campaign, one per location. Without the location
  // on the face of the email they are indistinguishable from each other.
  const scopeLine = locationName
    ? `<p style="font-size:13px;color:#111827;margin:0 0 16px;"><strong>Location:</strong> ${locationName}</p>`
    : ''
  const bannerBg = hasRevisions ? 'linear-gradient(135deg,#f59e0b,#ef4444)' : 'linear-gradient(135deg,#10b981,#06b6d4)'
  const bannerLabel = hasRevisions ? 'CHANGE REQUEST' : 'APPROVED'
  const headingText = hasRevisions ? 'Changes requested' : 'Creative approved'
  const subText = hasRevisions
    ? `<strong style="color:#111827;">${payload.reviewer}</strong>${payload.reviewerEmail ? ` (${payload.reviewerEmail})` : ''} has left feedback on <strong style="color:#111827;">${payload.campaignTitle}</strong> for <strong style="color:#111827;">${payload.clientName}</strong>. The card has been moved to <strong style="color:#d97706;">Change Request</strong> on the FTE Board.`
    : `<strong style="color:#111827;">${payload.reviewer}</strong>${payload.reviewerEmail ? ` (${payload.reviewerEmail})` : ''} approved <strong style="color:#111827;">${payload.campaignTitle}</strong> for <strong style="color:#111827;">${payload.clientName}</strong>.`

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#fff;">
      <div style="margin-bottom:24px;display:flex;align-items:center;gap:10px;">
        <span style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#06b6d4);color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;letter-spacing:.05em;">FTE ADVIEWER</span>
        <span style="display:inline-block;background:${bannerBg};color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;letter-spacing:.05em;">${bannerLabel}</span>
      </div>
      <h1 style="font-size:20px;font-weight:700;color:#111827;margin:0 0 8px;">${headingText}</h1>
      <p style="font-size:14px;color:#6b7280;margin:0 0 24px;line-height:1.5;">${subText}</p>
      ${scopeLine}
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Creative</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Status</th>
            <th style="text-align:left;padding:10px 12px;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#9ca3af;margin-top:24px;">This notification was sent automatically by FTE Adviewer.</p>
    </div>
  `
}

export async function POST(req: NextRequest) {
  const payload = await req.json() as NotifyPayload

  // Validate the campaign token exists — prevents unauthenticated spam
  if (!payload.campaign_token) {
    return NextResponse.json({ error: 'Missing campaign token' }, { status: 400 })
  }
  const supabase = createAdminClient()
  const resolved = await resolveReviewToken(supabase, payload.campaign_token)
  if (!resolved) {
    return NextResponse.json({ error: 'Invalid campaign token' }, { status: 403 })
  }
  const { campaignId, scope } = resolved

  const hasRevisions = payload.items.some(i => i.status === 'needs_revision')
  const allApproved = payload.items.every(i => i.status === 'approved')

  // SECURITY: derive which board cards to move from THIS campaign's own linked
  // cards and their stored per-card status — never from the request body. The
  // client writes each card's decision to adviewer_campaign_cards.status before
  // calling notify, so this is the same outcome without the injection vector.
  //
  // On a per-location scope token the same rule has to bite harder: derive from
  // THIS LOCATION'S cards only. Without the location filter, one location
  // submitting its four creatives would restamp approval_status on all ~60
  // board cards in the campaign, including the locations that had not
  // looked yet.
  const { data: campaignCards } = await supabase
    .from('adviewer_campaign_cards')
    .select('card_id, status, location_status, card:cards(atlas_location_id)')
    .eq('campaign_id', campaignId)

  const scopedCards = ((campaignCards ?? []) as unknown as {
    card_id: string | null
    status: string | null
    location_status: string | null
    card: { atlas_location_id: string | null } | null
  }[]).filter((c) => !scope || c.card?.atlas_location_id === scope.atlasLocationId)

  // A location's answer lives in location_status (add_location_card_verdicts.sql).
  // Its change requests still flag the board card — that only surfaces work. Its
  // approval marks the board card approved only where corporate hasn't asked for
  // changes, so a location can never clear corporate's flag — and the same the
  // other way round: corporate's approval doesn't clear a location's flag.
  const verdict = (c: (typeof scopedCards)[number]) => (scope ? c.location_status : c.status)
  const otherSideWantsChanges = (c: (typeof scopedCards)[number]) =>
    (scope ? c.status : c.location_status) === 'needs_revision'
  const approvedCardIds = scopedCards
    .filter((c) => verdict(c) === 'approved' && c.card_id && !otherSideWantsChanges(c))
    .map((c) => c.card_id as string)
  const revisionCardIds = scopedCards
    .filter((c) => verdict(c) === 'needs_revision' && c.card_id)
    .map((c) => c.card_id as string)

  // ── Revision cards: flag only — do NOT auto-move the column ─────────────────
  // Setting approval_status='changes_requested' lights up the orange "Changes"
  // flag on the board card wherever it currently sits. We deliberately do NOT
  // move it to the Change Request column: once a team member has pulled a card
  // into their work lane, a later round of client changes must not yank it back
  // out from under them. The team moves cards; the flag tells them a round came in.
  if (revisionCardIds.length > 0) {
    await supabase
      .from('cards')
      .update({
        approval_status: 'changes_requested',
        updated_at: new Date().toISOString(),
      })
      .in('id', revisionCardIds)
  }

  // ── Approved cards: mark approval_status only — do NOT auto-move the column ──
  // The team moves approved cards to "Approved for Build Out" manually. Auto-
  // moving on approval was too aggressive (a designer may still have build steps
  // before it's build-out ready). We only record the client's approval so the
  // board can badge it; the column change is a deliberate human action.
  if (approvedCardIds.length > 0) {
    await supabase
      .from('cards')
      .update({
        approval_status: 'approved',
        updated_at: new Date().toISOString(),
      })
      .in('id', approvedCardIds)
  }

  const who = scope?.locationName ? `${payload.clientName} — ${scope.locationName}` : payload.clientName
  const subject = allApproved
    ? `✅ ${who} approved "${payload.campaignTitle}"`
    : `📌 ${who} — Change Request on "${payload.campaignTitle}"`

  // Recipients are the staff who opted in on the Settings page. Read via the
  // service-role client (bypasses RLS) so we see every opted-in row.
  const { data: subs } = await supabase
    .from('adviewer_email_prefs')
    .select('email')
    .eq('notify_on_review', true)
  const toEmails = (subs ?? []).map((s) => s.email).filter(Boolean)

  // Nobody opted in — the board cards were already moved above, so there's
  // nothing to email. Not an error.
  if (toEmails.length === 0) {
    return NextResponse.json({ ok: true, emailed: 0 })
  }

  const { error } = await resend.emails.send({
    from: 'FTE Adviewer <onboarding@resend.dev>',
    to: toEmails,
    subject,
    html: buildHtml(payload, hasRevisions, scope?.locationName ?? null),
  })

  if (error) {
    console.error('[notify] Resend error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
