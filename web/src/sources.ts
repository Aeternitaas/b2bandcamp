import { useEffect, useState } from 'react'
import { api } from './api'
import type { IconName } from './components/Icon'
import type { SourceCaps, SourceId, SourceInfo, Track } from './types'

/**
 * Everything the app knows about where a track came from.
 *
 * Two kinds of knowledge live here and they are deliberately separate. What a
 * source is called and which link belongs to it is fixed, known offline, and
 * needed before any request. What a source can do is not: it depends on how the
 * server was configured, so it is asked for once and cached.
 */

interface SourceMeta {
  label: string
  /** The brand mark shown on a row's link-out button. */
  icon: IconName
  /** Used in "Open on Bandcamp", and as the name of the search tab. */
  linkLabel: string
}

const META: Record<SourceId, SourceMeta> = {
  bandcamp: { label: 'Bandcamp', icon: 'bandcamp', linkLabel: 'Open on Bandcamp' },
  youtube: { label: 'YouTube', icon: 'youtube', linkLabel: 'Watch on YouTube' },
}

/** Falls back to Bandcamp's wording for a source this build has never heard of,
 *  which is also what an old row with no `source` field is. */
export function sourceMeta(id: string | undefined): SourceMeta {
  return META[id as SourceId] ?? META.bandcamp
}

/**
 * The source a row came from.
 *
 * Rows added before the column existed have no `source`, and every one of those
 * is a Bandcamp row, which is exactly what the server's own column default
 * says.
 */
export function trackSource(track: Pick<Track, 'source'>): SourceId {
  return track.source === 'youtube' ? 'youtube' : 'bandcamp'
}

// ---------------------------------------------------------------------------
// Link recognition
// ---------------------------------------------------------------------------

/** What a pasted link turned out to be. `kind` follows the source's own
 *  taxonomy: Bandcamp albums and tracks, YouTube videos and playlists. */
export interface ParsedLink {
  source: SourceId
  kind: 'a' | 't' | 'v' | 'p'
  /** Present for YouTube, where the id is in the link itself. Bandcamp needs a
   *  server round trip to learn its numeric ids, so this stays empty there. */
  id: string
  /** The link itself, tidied up: this is what gets sent to the server. */
  url: string
}

/**
 * Recognises a link without asking the server.
 *
 * Parsed with the URL constructor rather than matched with one big regular
 * expression, because the interesting cases are all about the parts of a URL:
 * a video id that must come from `v` and not from some other parameter, a
 * tracking parameter that must be ignored rather than swallowed into the id,
 * and a host that must be checked against a list rather than found anywhere in
 * the string. `youtu.be/xyz?si=abc&t=42` and
 * `music.youtube.com/watch?app=desktop&v=xyz&list=RD` are both ordinary here.
 *
 * Returns null for anything that is not a link this app can add, which is what
 * tells a search field it is looking at a search term.
 */
export function parseLink(value: string): ParsedLink | null {
  const raw = value.trim()
  if (!raw || /\s/.test(raw)) return null

  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const segments = url.pathname.split('/').filter(Boolean)

  if (host === 'youtu.be') {
    // The short form carries the id as the first path segment; everything
    // after it is a timestamp or a share tag.
    return videoLink(segments[0])
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com'
      || host === 'youtube-nocookie.com') {
    // A watch link carrying a list= is one video seen inside a playlist.
    // Whoever copied it meant the video, so the video wins; only an explicit
    // /playlist means the whole thing.
    const v = url.searchParams.get('v')
    if (isVideoId(v)) return { source: 'youtube', kind: 'v', id: v!, url: watchUrl(v!) }

    if (segments[0] === 'playlist') {
      const list = url.searchParams.get('list')
      if (isPlaylistId(list)) {
        return { source: 'youtube', kind: 'p', id: list!, url: playlistUrl(list!) }
      }
      return null
    }
    if (['shorts', 'embed', 'live', 'v'].includes(segments[0] ?? '')) {
      return videoLink(segments[1])
    }
    return null
  }

  if (host.endsWith('.bandcamp.com') && (segments[0] === 'album' || segments[0] === 'track') && segments[1]) {
    // Bandcamp's own ids are not in the link, so the whole URL goes to the
    // server, which resolves it. Query parameters are dropped: they are
    // referral tags, and the path alone identifies the release.
    return {
      source: 'bandcamp',
      kind: segments[0] === 'album' ? 'a' : 't',
      id: '',
      url: `${url.origin}/${segments[0]}/${segments[1]}`,
    }
  }

  return null
}

// A video link is rebuilt from its id rather than passed through, which drops
// the start offsets and share tags that these forms carry.
function videoLink(id: string | undefined): ParsedLink | null {
  if (!isVideoId(id)) return null
  return { source: 'youtube', kind: 'v', id: id!, url: watchUrl(id!) }
}

/** YouTube video ids are exactly 11 characters of base64url. Checking that
 *  keeps a stray path segment from being sent onwards as an id. */
function isVideoId(id: string | null | undefined): boolean {
  return !!id && /^[A-Za-z0-9_-]{11}$/.test(id)
}

/** Playlist ids have had several prefixes and lengths over the years, so this
 *  checks the alphabet and a sane length rather than guessing at a format. */
function isPlaylistId(id: string | null | undefined): boolean {
  return !!id && /^[A-Za-z0-9_-]{2,64}$/.test(id)
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

export function playlistUrl(playlistId: string): string {
  return `https://www.youtube.com/playlist?list=${playlistId}`
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * What a source can do here, as the server reports it.
 *
 * These are not constants: the same source answers differently depending on
 * whether the instance has an API key and an audio extractor, which is why the
 * client asks instead of hard-coding a table. Until the answer arrives the app
 * assumes the historical one, so a first paint never shows a Bandcamp track as
 * unplayable.
 */
const ASSUMED: Record<SourceId, SourceCaps> = {
  bandcamp: { stream: true, analyze: true, search: true, embed: false },
  youtube: { stream: false, analyze: false, search: false, embed: true },
}

let cached: Record<string, SourceCaps> | null = null
let inFlight: Promise<Record<string, SourceCaps>> | null = null

function load(): Promise<Record<string, SourceCaps>> {
  if (cached) return Promise.resolve(cached)
  if (!inFlight) {
    inFlight = api.sources()
      .then((res: { sources: SourceInfo[] }) => {
        cached = Object.fromEntries(res.sources.map((s) => [s.id, s.caps]))
        return cached
      })
      .catch(() => ASSUMED) // unreachable server: assume what has always been true
      .finally(() => { inFlight = null })
  }
  return inFlight
}

/**
 * The capability table, fetched once per page load and shared by every caller.
 *
 * It describes the build rather than the signed-in user, so it never needs
 * refetching and there is nothing to invalidate.
 */
export function useSourceCaps(): Record<string, SourceCaps> {
  const [caps, setCaps] = useState<Record<string, SourceCaps>>(cached ?? ASSUMED)

  useEffect(() => {
    let live = true
    void load().then((next) => { if (live) setCaps(next) })
    return () => { live = false }
  }, [])

  return caps
}

/** One source's capabilities out of that table, with the historical answer as
 *  the fallback for a source the server did not list. */
export function capsOf(table: Record<string, SourceCaps>, id: string): SourceCaps {
  return table[id] ?? ASSUMED[id as SourceId] ?? ASSUMED.bandcamp
}

/**
 * Why a row cannot be played here, phrased for the person looking at it rather
 * than for a log. A source that can embed plays in its own player, so this is
 * only for a source that can neither stream nor embed.
 */
export function playbackUnavailable(source: string): string {
  return `This ${sourceMeta(source).label} track cannot be played here.`
}
