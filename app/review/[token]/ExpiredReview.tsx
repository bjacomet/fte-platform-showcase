// Shown when a /review/<token> link no longer resolves — a rotated or mistyped
// token, or a client whose portal token was cleared. Replaces a bare 404 so the
// recipient knows the link is stale and what to do, rather than hitting a dead end.
export default function ExpiredReview() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0f1117] px-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-gray-800 border border-gray-700">
          <svg className="h-7 w-7 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-white">This review link isn&apos;t active</h1>
        <p className="mt-3 text-sm text-gray-400">
          The link may have expired or been replaced. Please ask your Follow The Eyes
          contact to send you a current review link.
        </p>
        <p className="mt-8 text-xs text-gray-600">Powered by Follow The Eyes Creative Platform</p>
      </div>
    </main>
  )
}
