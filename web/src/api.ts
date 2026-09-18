import type {
  AccountSummary, ApiToken, Collaborator, Fan, Playlist, SearchResult, SourceId, SourceInfo,
  Track, TrackRef, ShareLink, Tralbum, User, Visibility, WishlistPage, YTChannel, YTResult,
} from './types'

export interface CachedAnalysis {
  source: string
  source_id: string
  analyzer_version: number
  bpm: number | null
  bpm_confidence: number | null
  key_name?: string
  key_camelot?: string
  key_tonic?: number | null
  key_scale?: string
  key_confidence?: number | null
  peaks?: string
  analyzed_at: string
}

export interface CachedAnalysisInput {
  bpm: number | null
  bpm_confidence: number | null
  key_name: string
  key_camelot: string
  key_tonic: number | null
  key_scale: string
  key_confidence: number | null
  peaks: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function readCookie(name: string): string {
  const match = document.cookie.match(new RegExp('(^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[2]) : ''
}

/**
 * The share token for the playlist currently being viewed through a share link.
 * It travels in a header rather than the URL of every request so it never ends
 * up in server logs as a query string.
 */
let shareToken = ''
export function setShareToken(token: string) { shareToken = token }
export function getShareToken() { return shareToken }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')

  // Double-submit CSRF: echo the cookie the server set back in a header.
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('X-CSRF-Token', readCookie('b2bandcamp_csrf'))
  }
  if (shareToken) headers.set('X-Share-Token', shareToken)

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' })

  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? JSON.parse(text) : null

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `request failed (${res.status})`)
  }
  return data as T
}

const body = (v: unknown) => JSON.stringify(v)

export const api = {
  // ---- auth ----
  me: () => request<{ user: User | null }>('/api/auth/me'),

  register: (username: string, email: string, password: string) =>
    request<User>('/api/auth/register', { method: 'POST', body: body({ username, email, password }) }),

  login: (login: string, password: string) =>
    request<User>('/api/auth/login', { method: 'POST', body: body({ login, password }) }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  updateAccount: (patch: { current_password: string; email?: string; new_password?: string }) =>
    request<{ user: User; other_sessions_ended: boolean }>('/api/account',
      { method: 'PATCH', body: body(patch) }),

  linkBandcamp: (username: string, useAvatar: boolean) =>
    request<{ user: User; bandcamp: Fan }>('/api/account/bandcamp',
      { method: 'POST', body: body({ username, use_avatar: useAvatar }) }),

  unlinkBandcamp: () =>
    request<{ user: User }>('/api/account/bandcamp', { method: 'DELETE' }),

  setAvatar: (avatarUrl: string) =>
    request<{ user: User }>('/api/account/avatar',
      { method: 'PUT', body: body({ avatar_url: avatarUrl }) }),

  // ---- playlists ----
  listPlaylists: () => request<{ playlists: Playlist[] }>('/api/playlists'),

  createPlaylist: (title: string, description = '') =>
    request<Playlist>('/api/playlists', { method: 'POST', body: body({ title, description }) }),

  getPlaylist: (id: number) =>
    request<Playlist & { tracks: Track[] }>(`/api/playlists/${id}`),

  updatePlaylist: (id: number, patch: Partial<{
    title: string
    description: string
    cover_url: string
    visibility: Visibility
  }>) => request<Playlist>(`/api/playlists/${id}`, { method: 'PATCH', body: body(patch) }),

  deletePlaylist: (id: number) =>
    request<{ ok: boolean }>(`/api/playlists/${id}`, { method: 'DELETE' }),

  reorderPlaylists: (ids: number[]) =>
    request<{ ok: boolean }>('/api/playlists/reorder', { method: 'POST', body: body({ ids }) }),

  // ---- tracks ----
  addTracks: (playlistId: number, payload: { url?: string; items?: TrackRef[] }) =>
    request<{ added: number; tracks: Track[] }>(`/api/playlists/${playlistId}/tracks`,
      { method: 'POST', body: body(payload) }),

  reorderTracks: (playlistId: number, ids: number[]) =>
    request<{ tracks: Track[] }>(`/api/playlists/${playlistId}/tracks/reorder`,
      { method: 'POST', body: body({ ids }) }),

  updateTrack: (
    playlistId: number,
    trackRowId: number,
    // Fields are applied only when present, so updating one override leaves
    // the others untouched.
    patch: {
      bpm?: number | null
      key_override?: string | null
      added_by?: number | null
      note?: string | null
    },
  ) =>
    request<{ ok: boolean }>(`/api/playlists/${playlistId}/tracks/${trackRowId}`,
      { method: 'PATCH', body: body(patch) }),

  deleteTracks: (playlistId: number, ids: number[]) =>
    request<{ removed: number; tracks: Track[] }>(`/api/playlists/${playlistId}/tracks/delete`,
      { method: 'POST', body: body({ ids }) }),

  deleteTrack: (playlistId: number, trackRowId: number) =>
    request<{ ok: boolean }>(`/api/playlists/${playlistId}/tracks/${trackRowId}`, { method: 'DELETE' }),

  // ---- API tokens (browser extension, etc.) ----
  listApiTokens: () => request<{ tokens: ApiToken[] }>('/api/account/tokens'),

  revokeApiToken: (id: number) =>
    request<{ ok: boolean }>(`/api/account/tokens/${id}`, { method: 'DELETE' }),

  // ---- sharing ----
  listShares: () => request<{ shares: ShareLink[] }>('/api/account/shares'),

  getShareLink: (playlistId: number) =>
    request<{ token: string; path: string; url?: string; visibility?: Visibility }>(
      `/api/playlists/${playlistId}/share`),

  createShareLink: (playlistId: number) =>
    request<{ token: string; path: string; url?: string; visibility: Visibility }>(
      `/api/playlists/${playlistId}/share`, { method: 'POST' }),

  revokeShareLink: (playlistId: number) =>
    request<{ ok: boolean }>(`/api/playlists/${playlistId}/share`, { method: 'DELETE' }),

  resolveShare: (token: string) =>
    request<{ playlist: Playlist; tracks: Track[]; can_edit: boolean; role: Playlist['role'] }>(
      `/api/share/${encodeURIComponent(token)}`),

  collaborators: (playlistId: number) =>
    request<{ collaborators: Collaborator[] }>(`/api/playlists/${playlistId}/collaborators`),

  addCollaborator: (playlistId: number, username: string) =>
    request<{ collaborators: Collaborator[] }>(`/api/playlists/${playlistId}/collaborators`,
      { method: 'POST', body: body({ username }) }),

  searchUsers: (q: string) =>
    request<{ users: AccountSummary[] }>(`/api/users/search?q=${encodeURIComponent(q)}`),

  userProfile: (username: string) =>
    request<{
      user: { username: string; created_at: string }
      playlists: Playlist[]
      is_self: boolean
    }>(`/api/users/${encodeURIComponent(username)}/profile`),

  removeCollaborator: (playlistId: number, userId: number) =>
    request<{ ok: boolean }>(`/api/playlists/${playlistId}/collaborators/${userId}`, { method: 'DELETE' }),

  // ---- integrations ----

  /** What this build's sources can do. Describes the server, not the user, so
   *  it needs no sign-in and is fetched once; see sources.ts. */
  sources: () => request<{ sources: SourceInfo[] }>('/api/sources'),

  // ---- bandcamp ----
  search: (q: string, type = '') =>
    request<{ results: SearchResult[] }>(
      `/api/bc/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`),

  resolveUrl: (url: string) =>
    request<Tralbum>('/api/bc/resolve', { method: 'POST', body: body({ url }) }),

  details: (type: 'a' | 't', id: number, bandId: number) =>
    request<Tralbum>(`/api/bc/details?type=${type}&id=${id}&band_id=${bandId}`),

  fan: (username: string) =>
    request<Fan>(`/api/bc/fan?username=${encodeURIComponent(username)}`),

  wishlist: (fanId: number, token = '', count = 40) =>
    request<WishlistPage>(
      `/api/bc/wishlist?fan_id=${fanId}&token=${encodeURIComponent(token)}&count=${count}`),

  // ---- youtube ----

  ytSearch: (q: string, kind = '') =>
    request<{ results: YTResult[] }>(
      `/api/yt/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}`),

  /** Describes the video or playlist behind a pasted link. Adds nothing. */
  ytLookup: (url: string) =>
    request<{ result: YTResult }>(`/api/yt/lookup?url=${encodeURIComponent(url)}`),

  /** Resolves a handle, a channel link or a display name to one channel. */
  ytChannel: (q: string) =>
    request<YTChannel>(`/api/yt/channel?q=${encodeURIComponent(q)}`),

  /** One page of a channel's public playlists. */
  ytPlaylists: (channelId: string, pageToken = '') =>
    request<{ results: YTResult[]; next_page_token: string }>(
      `/api/yt/playlists?channel_id=${encodeURIComponent(channelId)}&page_token=${encodeURIComponent(pageToken)}`),

  /** One page of the videos inside a playlist. */
  ytPlaylistTracks: (playlistId: string, pageToken = '') =>
    request<{ results: YTResult[]; next_page_token: string }>(
      `/api/yt/playlist?id=${encodeURIComponent(playlistId)}&page_token=${encodeURIComponent(pageToken)}`),

  // ---- cached analysis ----

  /**
   * Cached analysis for one track, or null when nobody has analysed it yet.
   *
   * Keyed by source and that source's own id, so one analysis is shared by
   * every playlist row pointing at the same track, whichever source it is.
   */
  getAnalysis: async (source: SourceId, sourceId: string) => {
    try {
      return await request<CachedAnalysis>(analysisPath(source, sourceId))
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },

  saveAnalysis: (source: SourceId, sourceId: string, body_: CachedAnalysisInput) =>
    request<{ ok: boolean }>(analysisPath(source, sourceId), { method: 'PUT', body: body(body_) }),

  // ---- audio ----

  /**
   * Playback URL for one row, by source.
   *
   * Bandcamp redirects to a freshly signed CDN URL, so the bytes never pass
   * through this server. YouTube has to be relayed instead; see the Go handler
   * for why. Both are same-origin as far as the audio element is concerned.
   */
  streamUrl: (track: Pick<Track, 'source' | 'source_id' | 'source_ref'>) =>
    (track.source === 'youtube'
      ? `/api/yt/stream/${encodeURIComponent(track.source_id)}`
      : `/api/bc/stream/${track.source_id}?band_id=${track.source_ref}`),

  /**
   * The same audio, delivered whole and same-origin so Web Audio may read the
   * samples. Only used while analysing, which is why both sources treat it as
   * the expensive path: Bandcamp relays the bytes, and YouTube downloads the
   * file, serves it and deletes it.
   */
  audioUrl: (track: Pick<Track, 'source' | 'source_id' | 'source_ref'>) =>
    (track.source === 'youtube'
      ? `/api/yt/audio/${encodeURIComponent(track.source_id)}`
      : `/api/bc/audio/${track.source_id}?band_id=${track.source_ref}`),
}

/** The analysis cache is addressed by source and id. */
function analysisPath(source: SourceId, sourceId: string): string {
  return `/api/analysis/${encodeURIComponent(source)}/${encodeURIComponent(sourceId)}`
}
