export type Visibility = 'private' | 'shared' | 'public'
export type Role = 'owner' | 'collaborator' | 'guest' | 'viewer' | 'none'

export interface User {
  id: number
  username: string
  email?: string
  created_at: string
}

export interface Playlist {
  id: number
  owner_id: number
  owner_name: string
  title: string
  description: string
  cover_url: string
  visibility: Visibility
  has_share_link: boolean
  base_fan_id: number | null
  base_fan_username: string
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
  art_id: number | null
  track_url: string
  added_by: number | null
  added_at: string
}

export interface Collaborator {
  user_id: number
  username: string
  added_at: string
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

/** A reference to something on Bandcamp that can be added to a playlist. */
export interface TrackRef {
  type: 'a' | 't'
  id: number
  band_id: number
}
