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

/** The image to show for a playlist: an explicit cover, else the first track. */
export function playlistCover(coverUrl: string, tracks: Track[], format: 3 | 9 = 3): string {
  if (coverUrl) return coverUrl
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

export function looksLikeBandcampUrl(value: string): boolean {
  return /(^https?:\/\/)?[a-z0-9-]+\.bandcamp\.com\/(album|track)\//i.test(value.trim())
}
