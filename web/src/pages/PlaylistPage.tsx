import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, setShareToken } from '../api'
import { PlaylistView } from '../components/PlaylistView'
import type { Playlist, Track } from '../types'
import { Icon } from '../components/Icon'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

export function PlaylistPage() {
  const { id } = useParams<{ id: string }>()
  const playlistId = Number(id)

  const [playlist, setPlaylist] = useState<Playlist | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDocumentTitle(playlist?.title)

  useEffect(() => {
    // Reached by id rather than a share link, so no share token applies.
    setShareToken('')

    if (!Number.isFinite(playlistId) || playlistId <= 0) {
      setError('Invalid playlist.')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    api.getPlaylist(playlistId)
      .then((res) => {
        if (cancelled) return
        const { tracks: t, ...rest } = res
        setPlaylist(rest as Playlist)
        setTracks(t ?? [])
        setError('')
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [playlistId])

  if (loading) {
    return <div className="row"><div className="spin" /> <span className="dim">Loading…</span></div>
  }

  if (error || !playlist) {
    return (
      <div className="col">
        <div className="notice error">{error || 'Playlist not found.'}</div>
        <Link to="/">Back to your playlists</Link>
      </div>
    )
  }

  const canEdit = playlist.role === 'owner' || playlist.role === 'collaborator'

  return (
    <div className="col">
      <Link to="/" className="small row" style={{ gap: 4, display: 'inline-flex' }}>
        <Icon name="arrow-left" size={13} /> All playlists
      </Link>
      <PlaylistView
        playlist={playlist}
        tracks={tracks}
        canEdit={canEdit}
        onPlaylistChange={setPlaylist}
        onTracksChange={setTracks}
      />
    </div>
  )
}
