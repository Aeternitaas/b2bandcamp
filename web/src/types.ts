export type Visibility = 'private' | 'shared' | 'public'
export type Role = 'owner' | 'collaborator' | 'guest' | 'viewer' | 'none'

export interface User {
  id: number
  username: string
  email?: string
  created_at: string
  bandcamp_username?: string
  bandcamp_fan_id?: number
  avatar_url?: string
}

export interface Playlist {
  id: number
  owner_id: number
  owner_name: string
  title: string
  description: string
  cover_url: string
  /** Both describe the first track that has any art, so exactly one is set. */
  cover_art_id: number | null
  cover_art_url: string
  visibility: Visibility
  has_share_link: boolean
  sort_index: number
  track_count: number
  duration_seconds: number
  created_at: string
  updated_at: string
  role: Role
}

/** The integrations this build knows by name. The server is the authority on
 *  which are actually available; see useSourceCaps. */
export type SourceId = 'bandcamp' | 'youtube'

/** What a client may do with one source's tracks, from GET /api/sources.
 *  These depend on how the server is configured, not on which source it is. */
export interface SourceCaps {
  /** The server can resolve a playable audio URL for these rows. */
  stream: boolean
  /** Raw audio is reachable same-origin, so tempo and key detection can run. */
  analyze: boolean
  /** The source has a catalog search this server can proxy. */
  search: boolean
  /** Playback is the source's own embedded player. */
  embed: boolean
}

export interface SourceInfo {
  id: string
  name: string
  caps: SourceCaps
}

export interface Track {
  id: number
  playlist_id: number
  position: number
  /** Which integration this row came from, and that integration's own id for
   *  it. Together they are the row's identity: they key the analysis cache and
   *  are what playback resolves against. */
  source: SourceId
  source_id: string
  /** An opaque handle the integration needs to act on the row later. For
   *  Bandcamp that is the band id; YouTube needs none. Meaningless elsewhere. */
  source_ref: string
  /** The older Bandcamp-only identity, kept working for existing clients and
   *  null on any row that did not come from Bandcamp. New code reads
   *  source/source_id instead. */
  bc_track_id: number | null
  bc_album_id: number | null
  bc_band_id: number | null
  title: string
  artist: string
  album_title: string
  duration: number
  /** Hand-entered override for this row; null means use detected_bpm. */
  bpm: number | null
  /** Hand-entered Camelot code; empty means use key_camelot from analysis. */
  key_override: string
  /** Free-text, hand-entered; empty when nobody has written one. */
  note: string
  /** From the shared analysis cache. */
  detected_bpm: number | null
  key_camelot: string
  key_name: string
  /** Art comes as either an id or a URL, never both: Bandcamp's id lets each
   *  view pick its own pixel size, where a source that only publishes images
   *  fills art_url. Use trackArt rather than reading these directly. */
  art_id: number | null
  art_url: string
  track_url: string
  added_by: number | null
  added_at: string
  added_by_name: string
  added_by_avatar: string
}

export interface ShareLink {
  playlist_id: number
  title: string
  visibility: Visibility
  token: string
  cover_url: string
  cover_art_id: number | null
  cover_art_url: string
  track_count: number
  collaborators: number
  updated_at: string
}

export interface Collaborator {
  user_id: number
  username: string
  avatar_url: string
  added_at: string
}

/** A bearer credential for a non-browser client (the Chrome extension). The
 *  raw token itself is never returned here, only once, at creation. */
export interface ApiToken {
  id: number
  label: string
  created_at: string
  last_used_at: string | null
}

export interface SearchResult {
  type: 'b' | 'a' | 't' | 'f'
  id: number
  name: string
  band_id?: number
  band_name?: string
  album_name?: string
  url?: string
  art_url?: string
  location?: string
  username?: string
}

export interface BCTrack {
  track_id: number
  track_num: number
  title: string
  artist: string
  album_title: string
  album_id: number | null
  band_id: number
  duration: number
  /** Hand-entered override for this row; null means use detected_bpm. */
  bpm: number | null
  /** Hand-entered Camelot code; empty means use key_camelot from analysis. */
  key_override: string
  /** From the shared analysis cache. */
  detected_bpm: number | null
  key_camelot: string
  key_name: string
  art_id: number | null
  art_url: string
  track_url: string
  streamable: boolean
}

export interface Tralbum {
  id: number
  type: 'a' | 't'
  title: string
  artist: string
  band_id: number
  art_id: number | null
  art_url: string
  url: string
  about?: string
  release_date?: string
  /** Up to 3 tags that match one of Bandcamp's own established genres. */
  genres?: string[]
  tracks: BCTrack[]
}

export interface WishlistItem {
  tralbum_id: number
  tralbum_type: 'a' | 't'
  band_id: number
  title: string
  band_name: string
  item_url: string
  art_url: string
  track_count: number
}

export interface WishlistPage {
  items: WishlistItem[]
  last_token: string
  more_available: boolean
}

export interface Fan {
  fan_id: number
  username: string
  name: string
  image_url: string
  wishlist_count: number
}

/** A b2bandcamp account, as returned by the collaborator invite search. */
export interface AccountSummary {
  id: number
  username: string
  created_at: string
  avatar_url?: string
}

/** A reference to something on Bandcamp that can be added to a playlist. */
export interface TrackRef {
  type: 'a' | 't'
  id: number
  band_id: number
}

/**
 * What an "add to this playlist" call carries: Bandcamp's own ids, a link from
 * any source, or both at once. This is the request body of
 * POST /api/playlists/{id}/tracks, and the one shape every add path in the app
 * hands around, so a Bandcamp album and a YouTube link travel the same way.
 */
export interface AddPayload {
  url?: string
  items?: TrackRef[]
}

/**
 * One thing found on YouTube: a video, a playlist, or a channel.
 *
 * Search results, a channel's playlists and a playlist's contents all arrive in
 * this one shape, so the views that list them share their rendering the way the
 * Bandcamp views share theirs.
 */
export interface YTResult {
  kind: 'v' | 'p' | 'c'
  id: string
  title: string
  /** The channel, already split out of the video title where the two were
   *  combined. See the server's metadata rules. */
  artist: string
  channel_id: string
  art_url: string
  url: string
  /** Seconds; 0 for a playlist, or for a video on an instance with no API key. */
  duration: number
  /** How many videos a playlist holds; 0 for anything else. */
  item_count: number
  /** False for a video that cannot be played here at all, such as one taken
   *  down. Adding it would produce a row nobody could play. */
  playable: boolean
}

/** A YouTube account, as the wishlist view's YouTube half browses one. */
export interface YTChannel {
  id: string
  title: string
  /** The @handle, when the channel has one. */
  handle: string
  image_url: string
  /** The playlist holding everything the channel has posted. Every channel has
   *  one, which is what there is to show for an account that curates no
   *  playlists of its own. */
  uploads_playlist_id: string
}
