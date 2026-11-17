/**
 * Copy text to the clipboard without ever throwing.
 *
 * navigator.clipboard.writeText rejects when the tab isn't focused or the
 * permission is denied; an unhandled rejection there is why "Copy link" buttons
 * could silently do nothing. Returns whether the copy succeeded so callers can
 * gate their "Copied!" feedback on a real result.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy execCommand path below.
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
