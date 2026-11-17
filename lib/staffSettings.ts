// Browser helper for the staff-owned app_settings keys (video designer, Atlas
// location contacts). Writes go through /api/settings/[key] because RLS keeps
// app_settings writes admin-only. Returns an error message, or null on success.

export async function saveStaffSetting(key: string, value: string | null): Promise<string | null> {
  try {
    const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
      method: value === null ? 'DELETE' : 'PUT',
      headers: value === null ? undefined : { 'Content-Type': 'application/json' },
      body: value === null ? undefined : JSON.stringify({ value }),
    })
    if (res.ok) return null
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return body.error ?? `Save failed (${res.status})`
  } catch {
    return 'Save failed — check your connection and try again.'
  }
}
