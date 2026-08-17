import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AddTracks } from './AddTracks'
import { PlaylistSettings } from './PlaylistSettings'
import { SortableList } from './SortableList'
import { WishlistSidebar } from './WishlistSidebar'
import { usePlayer } from '../state/player'
import { artUrl, formatDuration, formatTotal, playlistCover } from '../utils'
import type { Playlist, Track, TrackRef } from '../types'

interface Props {
  playlist: Playlist
  tracks: Track[]
  canEdit: boolean
  onPlaylistChange: (p: Playlist) => void
  onTracksChange: (t: Track[]) => void
  /** Shown instead of the settings button when viewing through a share link. */
  shareMode?: boolean
}

export function PlaylistView({
  playlist, tracks, canEdit, onPlaylistChange, onTracksChange, shareMode,
}: Props) {
  const navigate = useNavigate()
  const player = usePlayer()

  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showWishlist, setShowWishlist] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const isOwner = playlist.role === 'owner'
  const cover = useMemo(() => playlistCover(playlist.cover_url, tracks, 9), [playlist.cover_url, tracks])

  const addRefs = useCallback(async (refs: TrackRef[]) => {
    const res = await api.addTracks(playlist.id, { items: refs })
    onTracksChange(res.tracks)
    onPlaylistChange({ ...playlist, track_count: res.tracks.length })
  }, [playlist, onPlaylistChange, onTracksChange])

  const addUrl = useCallback(async (url: string) => {
    const res = await api.addTracks(playlist.id, { url })
    onTracksChange(res.tracks)
    onPlaylistChange({ ...playlist, track_count: res.tracks.length })
  }, [playlist, onPlaylistChange, onTracksChange])

  const reorder = useCallback(async (next: Track[]) => {
    // Show the new order immediately; reconcile with the server afterwards.
    onTracksChange(next)
    try {
      const res = await api.reorderTracks(playlist.id, next.map((t) => t.id))
      onTracksChange(res.tracks)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [playlist.id, onTracksChange])

  const removeTrack = useCallback(async (track: Track) => {
    setBusy(true)
    try {
      await api.deleteTrack(playlist.id, track.id)
      const next = tracks.filter((t) => t.id !== track.id)
      onTracksChange(next)
      onPlaylistChange({ ...playlist, track_count: next.length })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [playlist, tracks, onPlaylistChange, onTracksChange])

  const setFan = useCallback(async (username: string) => {
    onPlaylistChange(await api.updatePlaylist(playlist.id, { base_fan_username: username }))
  }, [playlist.id, onPlaylistChange])

  return (
    <div className="col">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {cover
          ? <img className="cover lg" src={cover} alt="" />
          : <div className="cover lg">♪</div>}

        <div className="col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
          <h1 className="truncate">{playlist.title}</h1>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className={`badge ${playlist.visibility}`}>{playlist.visibility}</span>
            <span className="faint small">{formatTotal(tracks.length, playlist.duration_seconds)}</span>
            {!isOwner && <span className="faint small">by {playlist.owner_name}</span>}
          </div>
          {playlist.description && <p className="dim small" style={{ margin: 0 }}>{playlist.description}</p>}
        </div>
      </div>

      <div className="row wrap">
        <button
          className="primary"
          onClick={() => player.play(tracks, 0)}
          disabled={tracks.length === 0}
        >
          ▶ Play all
        </button>

        {canEdit && <button onClick={() => setShowAdd(true)}>+ Add music</button>}

        <button onClick={() => setShowWishlist(true)}>
          ♡ Wishlist{playlist.base_fan_username ? `: ${playlist.base_fan_username}` : ''}
        </button>

        <div className="spacer" />

        {!shareMode && canEdit && (
          <button className="ghost" onClick={() => setShowSettings(true)} aria-label="Playlist settings">⚙ Settings</button>
        )}
      </div>

      {!canEdit && (
        <div className="notice info">
          You're viewing this playlist read-only.
          {playlist.visibility === 'shared' && ' Sign in with the share link open to become a collaborator.'}
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      {tracks.length === 0 ? (
        <div className="empty">
          Nothing here yet.
          {canEdit && ' Add music with a Bandcamp link, a search, or from a wishlist.'}
        </div>
      ) : (
        <SortableList
          items={tracks}
          keyOf={(t) => t.id}
          onReorder={reorder}
          disabled={!canEdit}
          renderItem={(track, { index, dragging, handle }) => {
            const isCurrent = player.current?.id === track.id
            return (
              <div className={`track-row${isCurrent ? ' playing' : ''}${dragging ? ' dragging' : ''}`}>
                {canEdit && <div className="drag-handle" {...handle}>⠿</div>}

                <div className="track-index">{isCurrent && player.playing ? '▶' : index + 1}</div>

                {track.art_id
                  ? <img className="cover" style={{ width: 36, height: 36 }} src={artUrl(track.art_id, 3)} alt="" loading="lazy" />
                  : <div className="cover" style={{ width: 36, height: 36 }}>♪</div>}

                <button
                  className="track-meta ghost"
                  style={{ justifyContent: 'flex-start', textAlign: 'left', padding: 0, minHeight: 0 }}
                  onClick={() => player.play(tracks, index)}
                  aria-label={`Play ${track.title}`}
                >
                  <span style={{ minWidth: 0 }}>
                    <span className="track-title truncate" style={{ display: 'block' }}>{track.title}</span>
                    <span className="track-sub truncate" style={{ display: 'block' }}>
                      {track.artist}{track.album_title ? ` · ${track.album_title}` : ''}
                    </span>
                  </span>
                </button>

                <div className="track-dur">{formatDuration(track.duration)}</div>

                {canEdit && (
                  <button
                    className="ghost icon"
                    disabled={busy}
                    onClick={() => removeTrack(track)}
                    aria-label={`Remove ${track.title}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            )
          }}
        />
      )}

      {showAdd && (
        <AddTracks
          onClose={() => setShowAdd(false)}
          onAdd={addRefs}
          onAddUrl={addUrl}
        />
      )}

      {showSettings && (
        <PlaylistSettings
          playlist={playlist}
          isOwner={isOwner}
          onClose={() => setShowSettings(false)}
          onSaved={onPlaylistChange}
          onDeleted={() => navigate('/')}
        />
      )}

      {showWishlist && (
        <WishlistSidebar
          playlist={playlist}
          canEdit={canEdit}
          onClose={() => setShowWishlist(false)}
          onAdd={addRefs}
          onSetFan={setFan}
        />
      )}
    </div>
  )
}
