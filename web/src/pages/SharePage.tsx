import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, setShareToken } from '../api'
import { PlaylistView } from '../components/PlaylistView'
import { useAuth } from '../state/auth'
import type { Playlist, Track } from '../types'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

/**
 * A playlist opened through a collaboration link. The token is held in memory
 * and sent as a header, so it stays out of request query strings and logs.
 */
export function SharePage() {
  const { token } = useParams<{ token: string }>()
  const { user, loading: authLoading } = useAuth()

  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [canEdit, setCanEdit] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDocumentTitle(playlist?.title)

  useEffect(() => {
    if (!token) {
      setError('Missing share token.')
      setLoading(false)
      return
    }
    // Wait for the session check: whether signing in upgrades a visitor to a
    // collaborator depends on knowing who they are first.
    if (authLoading) return

    let cancelled = false
    setShareToken(token)
    setLoading(true)

    api.resolveShare(token)
      .then((res) => {
        if (cancelled) return
        setPlaylist(res.playlist)
        setTracks(res.tracks ?? [])
        setCanEdit(res.can_edit)
        setError('')
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [token, authLoading, user?.id])

  if (loading || authLoading) {
    return <div className="row"><div className="spin" /> <span className="dim">Opening shared playlist…</span></div>
  }

  if (error || !playlist) {
    return (
      <div className="col">
        <div className="notice error">{error || 'This share link is no longer valid.'}</div>
        <Link to="/">Go to your playlists</Link>
      </div>
    )
  }

  return (
    <div className="col">
      {!user && playlist.visibility === 'shared' && (
        <div className="notice info">
          <Link to="/">Sign in</Link> while this link is open to join as a collaborator and edit this playlist.
        </div>
      )}

      <PlaylistView
        playlist={playlist}
        tracks={tracks}
        canEdit={canEdit}
        onPlaylistChange={setPlaylist}
        onTracksChange={setTracks}
        shareMode
      />
    </div>
  )
}
