import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, setShareToken } from '../api'
import { formatTotal, playlistCover } from '../utils'
import type { Playlist, Visibility } from '../types'
import { Icon } from '../components/Icon'

/**
 * A user's profile page. Visitors see only playlists marked public; the owner
 * sees all of theirs and can change each one's visibility from here.
 */
export function ProfilePage() {
  const { username } = useParams<{ username: string }>()
  const navigate = useNavigate()

  const [profile, setProfile] = useState<{ username: string; created_at: string } | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [isSelf, setIsSelf] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | null>(null)

  useEffect(() => {
    if (!username) return
    // Public playlists are readable without a share token.
    setShareToken('')

    let cancelled = false
    setLoading(true)

    api.userProfile(username)
      .then((res) => {
        if (cancelled) return
        setProfile(res.user)
        setPlaylists(res.playlists)
        setIsSelf(res.is_self)
        setError('')
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [username])

  if (loading) {
    return <div className="row"><div className="spin" /> <span className="dim">Loading profile…</span></div>
  }

  if (error || !profile) {
    return (
      <div className="col">
        <div className="notice error">{error || 'No such user.'}</div>
        <Link to="/">Back</Link>
      </div>
    )
  }

  const setVisibility = async (playlist: Playlist, visibility: Visibility) => {
    setBusy(playlist.id)
    setError('')
    try {
      const updated = await api.updatePlaylist(playlist.id, { visibility })
      setPlaylists((prev) => prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="col">
      <Link to="/" className="small row" style={{ gap: 4, display: 'inline-flex' }}>
        <Icon name="arrow-left" size={13} /> Back
      </Link>

      <div className="row">
        <div className="cover lg" aria-hidden>{profile.username.slice(0, 1).toUpperCase()}</div>
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <h1 className="truncate">{profile.username}</h1>
          <span className="faint small">
            Joined {new Date(profile.created_at).toLocaleDateString()}
          </span>
          <span className="dim small">
            {isSelf
              ? `${playlists.length} playlist${playlists.length === 1 ? '' : 's'} · ${playlists.filter((p) => p.visibility === 'public').length} public`
              : `${playlists.length} public playlist${playlists.length === 1 ? '' : 's'}`}
          </span>
        </div>
      </div>

      {isSelf && (
        <div className="notice info">
          This is your profile. You can see all your playlists here and change who they are
          visible to; visitors only ever see the <strong>public</strong> ones.
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      {playlists.length === 0 ? (
        <div className="empty">
          {isSelf
            ? 'You have no playlists yet.'
            : `${profile.username} has no public playlists.`}
        </div>
      ) : (
        <div className="playlist-list">
          {playlists.map((p) => (
            <div className="playlist-row" key={p.id} onClick={() => navigate(`/p/${p.id}`)}>
              {playlistCover(p)
                ? <img className="cover" src={playlistCover(p)} alt="" loading="lazy" />
                : <div className="cover"><Icon name="music" size={20} /></div>}

              <div className="track-meta">
                <div className="track-title truncate">{p.title}</div>
                <div className="track-sub truncate">
                  {formatTotal(p.track_count, p.duration_seconds)}
                  {p.description ? ` · ${p.description}` : ''}
                </div>
              </div>

              {isSelf ? (
                <select
                  value={p.visibility}
                  disabled={busy === p.id}
                  aria-label={`Visibility of ${p.title}`}
                  style={{ width: 'auto' }}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation()
                    void setVisibility(p, e.target.value as Visibility)
                  }}
                >
                  <option value="private">private</option>
                  <option value="shared">shared</option>
                  <option value="public">public</option>
                </select>
              ) : (
                <span className="badge public">public</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
