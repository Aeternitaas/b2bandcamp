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
  cover_art_id: number | null
  visibility: Visibility
  has_share_link: boolean
  sort_index: number
  track_count: number
  duration_seconds: number
  created_at: string
  updated_at: string
  role: Role
}

export interface Track {
  id: number
  playlist_id: number
  position: number
  bc_track_id: number
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
  art_id: number | null
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
