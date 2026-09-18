import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from './Icon'
import { formatDuration } from '../utils'
import { bcSource } from '../audio/usePreview'
import type { usePreview } from '../audio/usePreview'
import type { AddPayload, Tralbum, WishlistItem } from '../types'

interface Props {
  item: WishlistItem
  canEdit: boolean
  preview: ReturnType<typeof usePreview>
  onTrackPreviewed: (trackId: number) => void
  onAdd: (payload: AddPayload) => Promise<void>
}

/**
 * An album's track list, expanded inline under its row in the wishlist,
 * fetched once on expansion, not up front, since a wishlist page can hold
 * dozens of albums. Browsing and previewing a release no longer means
 * navigating away from the list (and losing your scroll position doing so);
 * this is that same track list, just opened in place.
 */
export function WishlistAlbumTracks({ item, canEdit, preview, onTrackPreviewed, onAdd }: Props) {
  const [detail, setDetail] = useState<Tralbum | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api.details('a', item.tralbum_id, item.band_id)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [item.tralbum_id, item.band_id])

  const addOne = async (trackId: number, bandId: number) => {
    setAdding(trackId)
    try {
      await onAdd({ items: [{ type: 't', id: trackId, band_id: bandId || item.band_id }] })
      setAdded((prev) => new Set(prev).add(trackId))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAdding(null)
    }
  }

  if (loading) {
    return (
      <div className="row wish-album-tracks" style={{ gap: 6 }}>
        <div className="spin" /> <span className="dim small">Loading tracks…</span>
      </div>
    )
  }
  if (error) return <div className="notice error wish-album-tracks">{error}</div>
  if (!detail) return null

  return (
    <div className="wish-album-tracks">
      {detail.genres && detail.genres.length > 0 && (
        <div className="row wrap" style={{ gap: 4, padding: '0 0 6px' }}>
          {detail.genres.map((g) => <span className="badge" key={g}>{g}</span>)}
        </div>
      )}
      <div className="popover-tracks">
        {detail.tracks.map((t) => {
        const isAdded = added.has(t.track_id)
        const isPlaying = preview.isPreviewing('bandcamp', String(t.track_id))
        return (
          <div className={`popover-track${isPlaying ? ' playing' : ''}`} key={t.track_id}>
            <button
              className="popover-art"
              onClick={() => {
                preview.press({
                  ...bcSource(t.track_id, t.band_id || item.band_id),
                  title: t.title,
                  artist: t.artist,
                  album_title: detail.title,
                  art_id: t.art_id,
                  duration: t.duration,
                  track_url: t.track_url,
                })
                onTrackPreviewed(t.track_id)
              }}
              disabled={!t.streamable}
              aria-label={`Preview ${t.title}`}
              title={t.streamable ? 'Preview, press again to skip ahead' : 'Not streamable'}
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
    </div>
  )
}
