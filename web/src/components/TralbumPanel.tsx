import { useEffect, useState } from 'react'
import { api } from '../api'
import { formatDuration } from '../utils'
import { usePreview } from '../audio/usePreview'
import type { Tralbum, TrackRef } from '../types'
import { Icon } from './Icon'

interface Props {
  type: 'a' | 't'
  id: number
  bandId: number
  onAdd: (refs: TrackRef[]) => Promise<void>
  onBack?: () => void
}

/**
 * Expanded view of one Bandcamp album or track, with a preview available
 * before committing to adding anything: the whole release can be added with
 * a single button, or individual songs previewed and picked off one at a
 * time. Shared by every "look at this release" entry point in the app,
 * search results and a pasted link both land here.
 */
export function TralbumPanel({ type, id, bandId, onAdd, onBack }: Props) {
  const [detail, setDetail] = useState<Tralbum | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const [added, setAdded] = useState<Set<number>>(new Set())
  const preview = usePreview()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    api.details(type, id, bandId)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [type, id, bandId])

  const addAll = async () => {
    if (!detail) return
    setBusy('all')
    try {
      await onAdd([{ type, id, band_id: bandId }])
      setAdded(new Set(detail.tracks.map((t) => t.track_id)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const addOne = async (trackId: number, trackBandId: number) => {
    setBusy(trackId)
    try {
      await onAdd([{ type: 't', id: trackId, band_id: trackBandId || bandId }])
      setAdded((prev) => new Set(prev).add(trackId))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return <div className="row" style={{ padding: 16 }}><div className="spin" /> <span className="dim">Loading…</span></div>
  }
  if (error && !detail) {
    return (
      <div className="col">
        {onBack && <button className="ghost" onClick={onBack}><Icon name="arrow-left" /> Back</button>}
        <div className="notice error">{error}</div>
      </div>
    )
  }
  if (!detail) return null

  const streamable = detail.tracks.filter((t) => t.streamable)

  return (
    <div className="col">
      {onBack && (
        <button className="ghost" onClick={onBack} style={{ alignSelf: 'flex-start' }}>
          <Icon name="arrow-left" /> Back
        </button>
      )}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        {type === 't' && streamable.length === 1 ? (
          <button
            className="wish-art"
            style={{ width: 96, height: 96, borderRadius: 8 }}
            onClick={() => preview.press({
              trackId: streamable[0].track_id,
              bandId: streamable[0].band_id || bandId,
              title: streamable[0].title,
              artist: streamable[0].artist,
              artId: streamable[0].art_id,
              duration: streamable[0].duration,
              trackUrl: streamable[0].track_url,
            })}
            aria-label={`Preview ${detail.title}`}
            title="Preview, press again to skip ahead"
          >
            {detail.art_url
              ? <img src={detail.art_url} alt="" loading="lazy" />
              : <Icon name="music" size={34} />}
            <span className="popover-art-overlay">
              <Icon name={preview.isPreviewing(streamable[0].track_id) ? 'pause' : 'play'} size={20} />
            </span>
          </button>
        ) : (
          detail.art_url
            ? <img className="cover lg" src={detail.art_url} alt="" loading="lazy" />
            : <div className="cover lg"><Icon name="music" size={34} /></div>
        )}

        <div className="col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
          <h2 className="truncate">{detail.title}</h2>
          <div className="dim small truncate">{detail.artist}</div>
          <div className="faint small">
            {streamable.length} streamable track{streamable.length === 1 ? '' : 's'}
            {detail.release_date ? ` · ${detail.release_date.slice(0, 4)}` : ''}
          </div>

          {detail.genres && detail.genres.length > 0 && (
            <div className="row wrap" style={{ gap: 4 }}>
              {detail.genres.map((g) => <span className="badge" key={g}>{g}</span>)}
            </div>
          )}

          <button
            className="primary"
            onClick={addAll}
            disabled={busy !== null || streamable.length === 0}
            style={{ marginTop: 4 }}
          >
            {busy === 'all' ? <div className="spin" /> : <Icon name="plus" />}
            {type === 'a' ? ` Add whole album (${streamable.length})` : ' Add track'}
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {type === 'a' && (
        <div className="track-list">
          {detail.tracks.map((t) => {
            const isAdded = added.has(t.track_id)
            const isPlaying = preview.isPreviewing(t.track_id)
            return (
              <div
                className={`track-row${isPlaying ? ' playing' : ''}`}
                key={t.track_id}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <button
                  className="popover-art"
                  style={{ width: 26, height: 26 }}
                  onClick={() => preview.press({
                    trackId: t.track_id,
                    bandId: t.band_id || bandId,
                    title: t.title,
                    artist: t.artist,
                    albumTitle: detail.title,
                    artId: t.art_id,
                    duration: t.duration,
                    trackUrl: t.track_url,
                  })}
                  disabled={!t.streamable}
                  aria-label={`Preview ${t.title}`}
                  title={t.streamable ? 'Preview, press again to skip ahead' : 'Not streamable'}
                >
                  {t.art_url || detail.art_url
                    ? <img src={t.art_url || detail.art_url} alt="" loading="lazy" />
                    : <Icon name="music" size={12} />}
                  <span className="popover-art-overlay">
                    <Icon name={isPlaying ? 'pause' : 'play'} size={11} />
                  </span>
                </button>
                <div className="track-index">{t.track_num}</div>
                <div className="track-meta">
                  <div className="track-title truncate">{t.title}</div>
                  {!t.streamable && <div className="track-sub">not streamable</div>}
                </div>
                <div className="track-dur">{formatDuration(t.duration)}</div>
                <button
                  className={isAdded ? 'ghost icon' : 'icon'}
                  disabled={!t.streamable || busy !== null || isAdded}
                  onClick={() => addOne(t.track_id, t.band_id)}
                  aria-label={`Add ${t.title}`}
                >
                  {busy === t.track_id ? <div className="spin" /> : <Icon name={isAdded ? 'check' : 'plus'} />}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <a href={detail.url} target="_blank" rel="noreferrer noopener" className="small">
        Open on Bandcamp <Icon name="external-link" size={13} />
      </a>
    </div>
  )
}
