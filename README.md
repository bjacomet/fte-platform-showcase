# FTE Platform — showcase

An internal creative-operations platform built for **Follow The Eyes (FTE)**, a digital advertising agency. It replaced a mix of Trello, Box folders, spreadsheets and email threads with a single system in which every creative deliverable is a card, from brief to live ad.

> **This is a portfolio copy.** It is a scrubbed, single-commit snapshot of a private, production codebase. Client names, staff names, account IDs, internal docs, SQL migrations and seed data have been removed or replaced with placeholders such as `Acme Glass`, `Example Motors` and `admin@example.com`. It is not wired to a live database, and it will not run end to end without your own Supabase project and integration keys.

---

## What it does

| Area | What it covers |
|---|---|
| **Kanban board** | ~25 workflow columns, Trello-style drag and drop, multi-select bulk moves, live sync across every open tab (Supabase Realtime with own-echo suppression and reconnect reconciliation) |
| **Card drawer** | Brief, copy, files and flight history per deliverable; Facebook, carousel, Messenger and Instant Experience editors with live ad mockups |
| **Adviewer** | A token-gated client review portal: pin-on-creative comments, per-size and per-slide feedback, change-request history that survives file replacement, per-location review links, a Lookbook of approved work |
| **Content calendar** | Grid, feed and list views of scheduled social posts; paste-a-content-plan bulk import that parses HTML tables, TSV or flattened text |
| **Box integration** | OAuth, a webhook that syncs revised creatives from Box into cards, one-click "Download Build" ZIPs with pre-filled Meta Ads Manager / The Trade Desk upload sheets |
| **Pacing** | Planned versus delivered spend and impressions per campaign, flight-aware expected spend, severity triage, daily TapClicks sync |
| **Brenda (AI assistant)** | Claude-powered chat with read tools over the board, confirm-before-write tools, and vision-based brand-compliance checks on creatives |
| **Atlas workspace** | A dedicated board and copy generator for a multi-location healthcare client, including Box tree sync with shape filtering |

## Stack

- **Next.js 16** (App Router), **React 19**, **TypeScript 5** (strict), **Tailwind CSS 4**
- **Supabase**: Postgres, Auth, Storage, Realtime, `SECURITY DEFINER` RPCs for the public portals
- **Anthropic SDK** for the assistant and copy generation
- Box, Meta Marketing API, Slack, Resend and TapClicks integrations
- `exceljs` and `archiver` for upload sheets and ZIP builds; `sharp` for image inspection
- Deployed on **Vercel** (crons for keep-alives and sync backstops)

## Design notes worth a look

- **Security model.** Every table has RLS. Staff read broadly; writes are gated by `is_writer()`/`is_admin()` SQL functions mirrored in `lib/writers.ts` for service-role routes. Public pages (review, calendar, Adviewer, video review) reach data only through token-validating RPCs. Storage listing is closed to anonymous callers.
- **Realtime correctness.** `hooks/useRealtimeBoard.ts` handles the cases that usually go wrong: echoes of your own optimistic writes, missed events after a socket drop, and stale tabs left open for days (`UpdateAvailableBanner`).
- **Upload sheets that import cleanly.** `app/api/box/download-build/route.ts` reproduces Meta's full 136-column import schema, because a hand-picked subset silently dropped carousel ads, and it classifies images by their real pixel dimensions rather than their filenames.
- **Pure helpers with tests.** `lib/**/*.test.ts` (node:test via tsx) covers URL normalization, client-form validation, Box shared links, Atlas folder matching and more.

## Running it locally

```bash
npm install
cp .env.example .env.local   # fill in your own Supabase + integration keys
npm run dev
```

```bash
npx tsc --noEmit
npm run lint
npm test
```

You will need your own Supabase project with a matching schema. The migrations are not included in this copy.

## Layout

```
app/          Next.js routes and API handlers
components/   UI (board, drawer, previews, calendar, Atlas)
hooks/        Realtime + drag helpers
lib/          Supabase clients, Box/Meta/Slack helpers, pure utilities + tests
scripts/      One-off build helpers
types/        Shared TypeScript types
```
