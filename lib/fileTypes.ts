// MIME handling for card file uploads that the browser often mislabels.
//
// The `creative-files` bucket enforces an allowed_mime_types list and Storage
// checks the request's Content-Type against it. Browsers are unreliable for
// audio and script files: macOS Safari/Chrome send "" for .wma, some send
// "audio/x-m4a" vs "audio/mp4", and an empty type falls back to
// application/octet-stream, which the bucket rejects. Resolving by extension
// keeps the upload's Content-Type, the stored card_files.file_type and the
// bucket allowlist (supabase/add_audio_mime_types.sql) in agreement.

const EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
  wma: 'audio/x-ms-wma',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  rtf: 'application/rtf',
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i + 1).toLowerCase()
}

export function resolveMimeType(file: File): string {
  return EXT_MIME[extOf(file.name)] ?? file.type
}

export function isAudioType(type: string | null): boolean {
  return !!type && type.startsWith('audio/')
}

// WMA is the one common audio format no current browser can decode, so it is
// stored and downloadable but never given a player that would silently fail.
export function isUnplayableAudio(type: string | null): boolean {
  return type === 'audio/x-ms-wma'
}

const SCRIPT_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/rtf',
  'text/rtf',
])

export function isScriptType(type: string | null): boolean {
  return !!type && SCRIPT_TYPES.has(type)
}

export const AUDIO_SCRIPT_ACCEPT = '.mp3,.m4a,.aac,.wav,.ogg,.oga,.flac,.weba,.wma,.doc,.docx,.txt,.rtf'
