// Reports the currently-deployed build id so open tabs can detect when a newer
// version has shipped and prompt a reload (see components/UpdateAvailableBanner.tsx).
// force-dynamic so this always reflects the live server, never a cached response.
export const dynamic = 'force-dynamic'

const VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.VERCEL_DEPLOYMENT_ID ??
  'dev'

export function GET() {
  return Response.json(
    { version: VERSION },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  )
}
