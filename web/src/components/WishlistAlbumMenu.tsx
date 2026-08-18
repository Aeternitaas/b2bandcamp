import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from './Icon'
import { formatDuration } from '../utils'
import { usePreview } from '../audio/usePreview'
import type { Tralbum, TrackRef, WishlistItem } from '../types'

interface Props {
  item: WishlistItem
  canEdit: boolean
  added: boolean
  busy: boolean
  onAddAlbum: () => void
  onAddTrack: (ref: TrackRef) => Promise<void>
}

/**
 * The add control for a wishlisted album: hovering lists the album's tracks
 * inline so a single song can be picked without leaving the wishlist, and each
 * one can be auditioned from its artwork.
 */
export function WishlistAlbumMenu({ item, canEdit, added, busy, onAddAlbum, onAddTrack }: Props) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<Tralbum | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [addedTracks, setAddedTracks] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState<number | null>(null)
  const preview = usePreview()

  // Fetched only once the menu is actually opened — a wishlist page can hold
  // dozens of albums and pre-fetching all of them would be wasteful.
  useEffect(() => {
    if (!open || detail || loading) return
    setLoading(true)
    api.details('a', item.tralbum_id, item.band_id)
      .then((d) => { setDetail(d); setError('') })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, detail, loading, item.tralbum_id, item.band_id])

  const addOne = async (trackId: number, bandId: number) => {
    setAdding(trackId)
    try {
      await onAddTrack({ type: 't', id: trackId, band_id: bandId || item.band_id })
      setAddedTracks((prev) => new Set(prev).add(trackId))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAdding(null)
    }
  }

  return (
    <div
      className="add-choice"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        className={added ? 'ghost icon' : 'icon'}
        disabled={!canEdit || busy || added}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Add from ${item.title}`}
        title="Add from this album"
      >
        {busy ? <div className="spin" /> : <Icon name={added ? 'check' : 'plus'} />}
      </button>

      {open && (
        <div className="add-choice-popover wide" role="menu">
          <button role="menuitem" disabled={!canEdit || busy} onClick={onAddAlbum}>
            <Icon name="disc" size={14} />
            Add whole album ({item.track_count})
          </button>

          <div className="popover-divider" />

          {loading && (
            <div className="row" style={{ gap: 6, padding: '4px 2px' }}>
              <div className="spin" /> <span className="dim small">Loading tracks…</span>
            </div>
          )}
          {error && <div className="notice error">{error}</div>}

          {detail?.genres && detail.genres.length > 0 && (
            <div className="row wrap" style={{ gap: 4, padding: '0 2px 4px' }}>
              {detail.genres.map((g) => <span className="badge" key={g}>{g}</span>)}
            </div>
          )}

          {detail && (
            <div className="popover-tracks">
              {detail.tracks.map((t) => {
                const isAdded = addedTracks.has(t.track_id)
                const isPlaying = preview.isPreviewing(t.track_id)
                return (
                  <div className={`popover-track${isPlaying ? ' playing' : ''}`} key={t.track_id}>
                    <button
                      className="popover-art"
                      onClick={() => preview.press({
                        trackId: t.track_id,
                        bandId: t.band_id || item.band_id,
                        title: t.title,
                        artist: t.artist,
                        albumTitle: detail.title,
                        artId: t.art_id,
                        duration: t.duration,
                        trackUrl: t.track_url,
                      })}
                      disabled={!t.streamable}
                      aria-label={`Preview ${t.title}`}
                      title={t.streamable ? 'Preview — press again to skip ahead' : 'Not streamable'}
                    >
                      {t.art_url || detail.art_url
                        ? <img src={t.art_url || detail.art_url} alt="" loading="lazy" />
                        : <Icon name="music" size={12} />}
                      <span className="popover-art-overlay">
                        <Icon name={isPlaying ? 'pause' : 'play'} size={10} />
                      </span>
                    </button>

                    <span className="track-index">{t.track_num}</span>
                    <span className="truncate small" style={{ flex: 1 }}>{t.title}</span>
                    <span className="faint small">{formatDuration(t.duration)}</span>

                    <button
                      className={isAdded ? 'ghost icon' : 'icon'}
                      disabled={!canEdit || !t.streamable || adding !== null || isAdded}
                      onClick={() => addOne(t.track_id, t.band_id)}
                      aria-label={`Add ${t.title}`}
                    >
                      {adding === t.track_id
                        ? <div className="spin" />
                        : <Icon name={isAdded ? 'check' : 'plus'} size={13} />}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
