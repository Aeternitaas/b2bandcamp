import type {
  Collaborator, Fan, Playlist, SearchResult, Track, TrackRef, Tralbum, User,
  Visibility, WishlistPage,
} from './types'

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
    headers.set('X-CSRF-Token', readCookie('b2b_csrf'))
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
    base_fan_username: string
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

  deleteTrack: (playlistId: number, trackRowId: number) =>
    request<{ ok: boolean }>(`/api/playlists/${playlistId}/tracks/${trackRowId}`, { method: 'DELETE' }),

  // ---- sharing ----
  createShareLink: (playlistId: number) =>
    request<{ token: string; path: string; visibility: Visibility }>(
      `/api/playlists/${playlistId}/share`, { method: 'POST' }),

  revokeShareLink: (playlistId: number) =>
    request<{ ok: boolean }>(`/api/playlists/${playlistId}/share`, { method: 'DELETE' }),

  resolveShare: (token: string) =>
    request<{ playlist: Playlist; tracks: Track[]; can_edit: boolean; role: Playlist['role'] }>(
      `/api/share/${encodeURIComponent(token)}`),

  collaborators: (playlistId: number) =>
    request<{ collaborators: Collaborator[] }>(`/api/playlists/${playlistId}/collaborators`),

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

  /** Playback URL. The server resolves a freshly signed stream and redirects. */
  streamUrl: (trackId: number, bandId: number) =>
    `/api/bc/stream/${trackId}?band_id=${bandId}`,
}
