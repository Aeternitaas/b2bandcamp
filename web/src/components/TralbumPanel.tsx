import { useEffect, useState } from 'react'
import { api } from '../api'
import { formatDuration } from '../utils'
import type { Tralbum, TrackRef } from '../types'

interface Props {
  type: 'a' | 't'
  id: number
  bandId: number
  onAdd: (refs: TrackRef[]) => Promise<void>
  onBack?: () => void
}

/**
 * Expanded view of one Bandcamp album or track: the whole release can be added
 * with a single button, or individual songs picked off one at a time. Shared by
 * the search flow and the wishlist sidebar so both behave identically.
 */
export function TralbumPanel({ type, id, bandId, onAdd, onBack }: Props) {
  const [detail, setDetail] = useState<Tralbum | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const [added, setAdded] = useState<Set<number>>(new Set())

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
        {onBack && <button className="ghost" onClick={onBack}>← Back</button>}
        <div className="notice error">{error}</div>
      </div>
    )
  }
  if (!detail) return null

  const streamable = detail.tracks.filter((t) => t.streamable)

  return (
    <div className="col">
      {onBack && (
        <button className="ghost" onClick={onBack} style={{ alignSelf: 'flex-start' }}>← Back</button>
      )}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        {detail.art_url
          ? <img className="cover lg" src={detail.art_url} alt="" loading="lazy" />
          : <div className="cover lg">♪</div>}

        <div className="col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
          <h2 className="truncate">{detail.title}</h2>
          <div className="dim small truncate">{detail.artist}</div>
          <div className="faint small">
            {streamable.length} streamable track{streamable.length === 1 ? '' : 's'}
            {detail.release_date ? ` · ${detail.release_date.slice(0, 4)}` : ''}
          </div>

          <button
            className="primary"
            onClick={addAll}
            disabled={busy !== null || streamable.length === 0}
            style={{ marginTop: 4 }}
          >
            {busy === 'all' ? <div className="spin" /> : '+'}
            {type === 'a' ? ` Add whole album (${streamable.length})` : ' Add track'}
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {type === 'a' && (
        <div className="track-list">
          {detail.tracks.map((t) => {
            const isAdded = added.has(t.track_id)
            return (
              <div className="track-row" key={t.track_id}>
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
                  {busy === t.track_id ? <div className="spin" /> : isAdded ? '✓' : '+'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <a href={detail.url} target="_blank" rel="noreferrer noopener" className="small">
        Open on Bandcamp ↗
      </a>
    </div>
  )
}
