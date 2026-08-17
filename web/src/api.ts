import type {
  AccountSummary, Collaborator, Fan, Playlist, SearchResult, Track, TrackRef,
  ShareLink, Tralbum, User, Visibility, WishlistPage,
} from './types'

export interface CachedAnalysis {
  bc_track_id: number
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
    // the other untouched.
    patch: { bpm?: number | null; key_override?: string | null },
  ) =>
    request<{ ok: boolean }>(`/api/playlists/${playlistId}/tracks/${trackRowId}`,
      { method: 'PATCH', body: body(patch) }),

  deleteTracks: (playlistId: number, ids: number[]) =>
    request<{ removed: number; tracks: Track[] }>(`/api/playlists/${playlistId}/tracks/delete`,
      { method: 'POST', body: body({ ids }) }),

  deleteTrack: (playlistId: number, trackRowId: number) =>
    request<{ ok: boolean }>(`/api/playlists/${playlistId}/tracks/${trackRowId}`, { method: 'DELETE' }),

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

  /** Cached analysis for a Bandcamp track, or null when not yet analysed. */
  getAnalysis: async (trackId: number) => {
    try {
      return await request<CachedAnalysis>(`/api/analysis/${trackId}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },

  saveAnalysis: (trackId: number, body_: CachedAnalysisInput) =>
    request<{ ok: boolean }>(`/api/analysis/${trackId}`, { method: 'PUT', body: body(body_) }),

  /** Playback URL. The server resolves a freshly signed stream and redirects. */
  streamUrl: (trackId: number, bandId: number) =>
    `/api/bc/stream/${trackId}?band_id=${bandId}`,

  /**
   * Same audio, relayed same-origin so Web Audio may read the samples.
   * Only used when the analysis panel is open — see the Go handler for why.
   */
  audioUrl: (trackId: number, bandId: number) =>
    `/api/bc/audio/${trackId}?band_id=${bandId}`,
}
