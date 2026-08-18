import type { Track } from './types'

/** Formats seconds as m:ss, or h:mm:ss once past an hour. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Compact "time ago", e.g. "5m", "3h", "2d", matches the narrow track columns. */
export function formatAddedAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''

  const seconds = Math.max(0, (Date.now() - then) / 1000)
  if (seconds < 60) return 'now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`

  return `${Math.floor(days / 365)}y`
}

/** Human summary of a playlist's length, e.g. "12 tracks · 48 min". */
export function formatTotal(count: number, seconds: number): string {
  const tracks = `${count} track${count === 1 ? '' : 's'}`
  if (!seconds) return tracks
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${tracks} · ${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${tracks} · ${h}h ${m}m`
}

/** Bandcamp CDN art. Format 3 is a thumbnail, 9 is roughly 600px. */
export function artUrl(artId: number | null | undefined, format: 3 | 9 = 3): string {
  return artId ? `https://f4.bcbits.com/img/a${artId}_${format}.jpg` : ''
}

/**
 * The image to show for a playlist: the explicit cover if one is set, otherwise
 * the album art of its first track. `cover_art_id` is computed server-side so
 * list views work without loading tracks; `tracks` is an extra fallback for
 * views that already have them.
 */
export function playlistCover(
  playlist: { cover_url: string; cover_art_id: number | null },
  tracks: Track[] = [],
  format: 3 | 9 = 3,
): string {
  if (playlist.cover_url) return playlist.cover_url
  if (playlist.cover_art_id) return artUrl(playlist.cover_art_id, format)
  const withArt = tracks.find((t) => t.art_id)
  return withArt ? artUrl(withArt.art_id, format) : ''
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

/** Debounce for search-as-you-type. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

/**
 * Copies text, falling back for insecure contexts.
 *
 * navigator.clipboard is only exposed in a secure context, so it is absent when
 * the app is reached over plain http on a LAN address, which is exactly how
 * this gets used.
 */
/**
 * Absolute URL for a share link.
 *
 * Prefers the canonical address the server was configured with (PUBLIC_BASE_URL),
 * so links copied from a LAN address still point at the public hostname. Falls
 * back to whatever origin the browser is on, which is correct for LAN-only and
 * development use.
 */
export function shareUrl(path: string, canonical?: string): string {
  if (canonical) return canonical
  return `${window.location.origin}${path}`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }

  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.appendChild(field)
  try {
    field.select()
    field.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(field)
  }
}

export function looksLikeBandcampUrl(value: string): boolean {
  return /(^https?:\/\/)?[a-z0-9-]+\.bandcamp\.com\/(album|track)\//i.test(value.trim())
}
