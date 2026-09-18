import { useEffect, useState } from 'react'
import { api } from '../api'
import { formatDuration } from '../utils'
import { bcSource, usePreview, type PreviewSource } from '../audio/usePreview'
import { capsOf, sourceMeta, useSourceCaps } from '../sources'
import type { AddPayload, SourceId, Tralbum, YTResult } from '../types'
import { Icon } from './Icon'
import { YTPlaylistTracks } from './YouTubeBrowser'

interface CommonProps {
  onAdd: (payload: AddPayload) => Promise<void>
  /** Called once the whole release (a single track, or "Add whole album")
   *  has been added, closing the popup: there is nothing left to add. Not
   *  called for a single song picked off an album's track list, that album
   *  may still have more to add. */
  onClose: () => void
  onBack?: () => void
  /** "source:source_id" for every row already in the playlist, so a repeat add
   *  can be caught before it happens rather than after. */
  existingTracks: Set<string>
}

/** A Bandcamp album or track. */
interface BandcampProps extends CommonProps {
  source?: 'bandcamp'
  type: 'a' | 't'
  id: number
  bandId: number
  /**
   * A pasted link already resolves to full detail server-side (see AddTracks'
   * runResolveUrl), so this skips fetching it a second time here purely to
   * re-derive what the caller already has. Only used when it matches this
   * type/id: a search result picked while one of these is still on screen
   * has no detail of its own yet, and must fetch normally.
   */
  initialDetail?: Tralbum
}

/**
 * A YouTube video or playlist, as a link lookup returned it. The lookup already
 * holds everything the header shows, so the panel fetches nothing for it. A
 * playlist lists its videos with the same component that the YouTube browser
 * uses.
 */
interface YouTubeProps extends CommonProps {
  source: 'youtube'
  item: YTResult
}

type Props = BandcampProps | YouTubeProps

/** A track add held for confirmation because it already exists in the
 *  playlist; `all` marks the single-track "Add track" button rather than a
 *  particular row inside an album's track list. */
type PendingDuplicate = { trackId: number; trackBandId: number; title: string; all: boolean }

/**
 * Expanded view of one release, with a preview available before committing to
 * adding anything: the whole release can be added with a single button, or
 * individual songs previewed and picked off one at a time. Shared by every
 * "look at this release" entry point in the app, search results and a pasted
 * link both land here.
 *
 * One panel serves both sources, so a pasted Bandcamp link and a pasted
 * YouTube link look and behave the same. A YouTube video takes the layout of a
 * Bandcamp track, and a YouTube playlist takes the layout of an album.
 */
export function TralbumPanel(props: Props) {
  const { onAdd, onClose, onBack, existingTracks } = props
  const yt = props.source === 'youtube' ? props.item : null
  const bc = props.source === 'youtube' ? null : props

  // The layout follows Bandcamp's two kinds. A playlist is laid out as an
  // album, and a video as a track.
  const type: 'a' | 't' = yt ? (yt.kind === 'p' ? 'a' : 't') : bc!.type
  const id = bc?.id ?? 0
  const bandId = bc?.bandId ?? 0
  const initialDetail = bc?.initialDetail
  const source: SourceId = yt ? 'youtube' : 'bandcamp'

  const matchesInitial = !!initialDetail && initialDetail.type === type && initialDetail.id === id
  const [detail, setDetail] = useState<Tralbum | null>(matchesInitial ? initialDetail! : null)
  const [loading, setLoading] = useState(!yt && !matchesInitial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [pendingDuplicate, setPendingDuplicate] = useState<PendingDuplicate | null>(null)
  const preview = usePreview()
  const canPreviewYT = capsOf(useSourceCaps(), 'youtube').stream

  useEffect(() => {
    if (yt) return
    if (initialDetail && initialDetail.type === type && initialDetail.id === id) {
      setDetail(initialDetail)
      setError('')
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError('')

    api.details(type, id, bandId)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [yt, type, id, bandId, initialDetail])

  const addAll = async (skipDuplicateCheck = false) => {
    if (!yt && !detail) return
    const title = yt ? yt.title : detail!.title
    const key = yt ? `youtube:${yt.id}` : `bandcamp:${id}`
    if (!skipDuplicateCheck && type === 't' && existingTracks.has(key)) {
      setPendingDuplicate({ trackId: id, trackBandId: bandId, title, all: true })
      return
    }
    setPendingDuplicate(null)
    setBusy('all')
    try {
      await onAdd(yt ? { url: yt.url } : { items: [{ type, id, band_id: bandId }] })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const addOne = async (trackId: number, trackBandId: number, title: string, skipDuplicateCheck = false) => {
    if (!skipDuplicateCheck && existingTracks.has(`bandcamp:${trackId}`)) {
      setPendingDuplicate({ trackId, trackBandId, title, all: false })
      return
    }
    setPendingDuplicate(null)
    setBusy(trackId)
    try {
      await onAdd({ items: [{ type: 't', id: trackId, band_id: trackBandId || bandId }] })
      setAdded((prev) => new Set(prev).add(trackId))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const confirmDuplicateAdd = () => {
    if (!pendingDuplicate) return
    if (pendingDuplicate.all) void addAll(true)
    else void addOne(pendingDuplicate.trackId, pendingDuplicate.trackBandId, pendingDuplicate.title, true)
  }

  if (!yt) {
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
  }

  const streamable = detail ? detail.tracks.filter((t) => t.streamable) : []

  // What the header shows. Bandcamp reads it from the fetched detail, and
  // YouTube reads it from the lookup result.
  const title = yt ? yt.title : detail!.title
  const artist = yt ? yt.artist : detail!.artist
  const artUrl = yt ? yt.art_url : detail!.art_url
  const pageUrl = yt ? yt.url : detail!.url
  const summary = yt
    ? (yt.kind === 'p'
        ? (yt.item_count > 0 ? `${yt.item_count} video${yt.item_count === 1 ? '' : 's'}` : 'Playlist')
        : (yt.duration > 0 ? formatDuration(yt.duration) : 'Video'))
    : `${streamable.length} streamable track${streamable.length === 1 ? '' : 's'}`
      + (detail!.release_date ? ` · ${detail!.release_date.slice(0, 4)}` : '')
  const addAllLabel = yt
    ? (yt.kind === 'p'
        ? ` Add whole playlist${yt.item_count > 0 ? ` (${yt.item_count})` : ''}`
        : ' Add track')
    : (type === 'a' ? ` Add whole album (${streamable.length})` : ' Add track')
  const canAddAll = yt ? yt.playable : streamable.length > 0

  // A single track previews from its cover, as a Bandcamp track always has.
  let coverPreview: { play: PreviewSource; key: string } | null = null
  if (!yt && type === 't' && streamable.length === 1) {
    const t = streamable[0]
    coverPreview = {
      key: String(t.track_id),
      play: {
        ...bcSource(t.track_id, t.band_id || bandId),
        title: t.title,
        artist: t.artist,
        art_id: t.art_id,
        duration: t.duration,
        track_url: t.track_url,
      },
    }
  } else if (yt && yt.kind === 'v' && yt.playable && canPreviewYT) {
    coverPreview = {
      key: yt.id,
      play: {
        source: 'youtube',
        source_id: yt.id,
        title: yt.title,
        artist: yt.artist,
        art_url: yt.art_url,
        duration: yt.duration,
        track_url: yt.url,
      },
    }
  }

  const link = sourceMeta(source)

  return (
    <div className="col">
      {onBack && (
        <button className="ghost" onClick={onBack} style={{ alignSelf: 'flex-start' }}>
          <Icon name="arrow-left" /> Back
        </button>
      )}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        {coverPreview ? (
          <button
            className="wish-art"
            style={{ width: 96, height: 96, borderRadius: 8 }}
            onClick={() => preview.press(coverPreview!.play)}
            aria-label={`Preview ${title}`}
            title="Preview, press again to skip ahead"
          >
            {artUrl
              ? <img src={artUrl} alt="" loading="lazy" />
              : <Icon name="music" size={34} />}
            <span className="popover-art-overlay">
              <Icon name={preview.isPreviewing(source, coverPreview.key) ? 'pause' : 'play'} size={20} />
            </span>
          </button>
        ) : (
          artUrl
            ? <img className="cover lg" src={artUrl} alt="" loading="lazy" />
            : <div className="cover lg"><Icon name="music" size={34} /></div>
        )}

        <div className="col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
          <h2 className="truncate">{title}</h2>
          <div className="dim small truncate">{artist}</div>
          <div className="faint small">{summary}</div>

          {detail?.genres && detail.genres.length > 0 && (
            <div className="row wrap" style={{ gap: 4 }}>
              {detail.genres.map((g) => <span className="badge" key={g}>{g}</span>)}
            </div>
          )}

          <button
            className="primary"
            onClick={() => void addAll()}
            disabled={busy !== null || !canAddAll}
            style={{ marginTop: 4 }}
          >
            {busy === 'all' ? <div className="spin" /> : <Icon name="plus" />}
            {addAllLabel}
          </button>
        </div>
      </div>

      {error && <div className="notice error">{error}</div>}

      {pendingDuplicate && (
        <div className="notice info">
          <span>“{pendingDuplicate.title}” is already in this playlist.</span>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button className="icon" disabled={busy !== null} onClick={confirmDuplicateAdd}>Add anyway</button>
            <button className="ghost icon" disabled={busy !== null} onClick={() => setPendingDuplicate(null)}>Cancel</button>
          </div>
        </div>
      )}

      {yt && yt.kind === 'p' && (
        <YTPlaylistTracks playlistId={yt.id} canEdit canPreview={canPreviewYT} onAdd={onAdd} />
      )}

      {detail && type === 'a' && (
        <div className="track-list">
          {detail.tracks.map((t) => {
            const isAdded = added.has(t.track_id)
            const isPlaying = preview.isPreviewing('bandcamp', String(t.track_id))
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
                    ...bcSource(t.track_id, t.band_id || bandId),
                    title: t.title,
                    artist: t.artist,
                    album_title: detail.title,
                    art_id: t.art_id,
                    duration: t.duration,
                    track_url: t.track_url,
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
                  onClick={() => void addOne(t.track_id, t.band_id, t.title)}
                  aria-label={`Add ${t.title}`}
                >
                  {busy === t.track_id ? <div className="spin" /> : <Icon name={isAdded ? 'check' : 'plus'} />}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <a href={pageUrl} target="_blank" rel="noreferrer noopener" className="small">
        {link.linkLabel}{' '}<Icon name={link.icon} size={13} />
      </a>
    </div>
  )
}
