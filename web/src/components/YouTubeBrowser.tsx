import { useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from './Icon'
import { formatDuration } from '../utils'
import { usePreview } from '../audio/usePreview'
import type { AddPayload, YTResult } from '../types'

/**
 * The YouTube rows.
 *
 * Every YouTube list in the app is one of these: search results, a channel's
 * playlists, and the videos inside a playlist all arrive in the same shape from
 * the server, so they render through the same row here rather than three
 * near-identical ones. The classes are the wishlist's own, so a YouTube list
 * and a Bandcamp list are the same object on screen.
 */

interface RowProps {
  item: YTResult
  canEdit: boolean
  /** False while this build cannot play YouTube audio, which hides the preview
   *  control rather than offering one that cannot work. */
  canPreview: boolean
  added: boolean
  busy: boolean
  onAdd: () => void
  /** Only for playlists: opens the track list underneath this row. */
  onToggle?: () => void
  expanded?: boolean
  /** Extra controls for the right-hand end, such as "add to another playlist". */
  children?: React.ReactNode
}

export function YTRow({
  item, canEdit, canPreview, added, busy, onAdd, onToggle, expanded, children,
}: RowProps) {
  const preview = usePreview()
  const isPlaylist = item.kind === 'p'
  const playing = !isPlaylist && preview.isPreviewing('youtube', item.id)

  const previewThis = () => preview.press({
    source: 'youtube',
    source_id: item.id,
    title: item.title,
    artist: item.artist,
    art_url: item.art_url,
    duration: item.duration,
    track_url: item.url,
  })

  const art = item.art_url
    ? <img src={item.art_url} alt="" loading="lazy" />
    : <Icon name={isPlaylist ? 'list' : 'music'} size={18} />

  return (
    <div className={`wish-item${playing ? ' playing' : ''}`}>
      {canPreview && !isPlaylist ? (
        <button
          className="wish-art"
          onClick={previewThis}
          aria-label={`Preview ${item.title}`}
          title="Preview, press again to skip ahead"
        >
          {art}
          <span className="popover-art-overlay">
            <Icon name={playing ? 'pause' : 'play'} size={12} />
          </span>
        </button>
      ) : (
        <div className="wish-art">{art}</div>
      )}

      <button
        className="track-meta ghost"
        style={{ justifyContent: 'flex-start', textAlign: 'left', padding: 0, minHeight: 0 }}
        onClick={() => (onToggle ? onToggle() : canPreview && !isPlaylist && previewThis())}
        aria-expanded={onToggle ? expanded : undefined}
      >
        <span style={{ minWidth: 0 }}>
          <span className="track-title truncate" style={{ display: 'block' }}>{item.title}</span>
          {/* A zero here means "not reported", not "empty": a playlist found
              through search carries no length, and a video has no duration on
              an instance with no API key. Either way, saying nothing beats
              saying 0. */}
          <span className="track-sub truncate" style={{ display: 'block' }}>
            {item.artist}
            {isPlaylist
              ? (item.item_count > 0 ? ` · ${item.item_count} video${item.item_count === 1 ? '' : 's'}` : '')
              : item.duration > 0 ? ` · ${formatDuration(item.duration)}` : ''}
          </span>
        </span>
        {onToggle && <Icon name="chevron-down" size={13} className={expanded ? 'flip-v' : undefined} />}
      </button>

      <a
        className="ghost icon"
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`Open ${item.title} on YouTube`}
        title="Watch on YouTube"
        style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px' }}
      >
        <Icon name="youtube" size={13} />
      </a>

      <button
        className={added ? 'ghost icon' : 'icon'}
        disabled={!canEdit || busy || added || !item.playable}
        onClick={onAdd}
        aria-label={`Add ${item.title}`}
        title={item.playable
          ? (isPlaylist
              ? (item.item_count > 0 ? `Add all ${item.item_count} videos` : 'Add every video in this playlist')
              : 'Add video')
          : 'This video cannot be played here'}
      >
        {busy ? <div className="spin" /> : <Icon name={added ? 'check' : 'plus'} />}
      </button>

      {children}
    </div>
  )
}

interface TracksProps {
  playlistId: string
  canEdit: boolean
  canPreview: boolean
  onAdd: (payload: AddPayload) => Promise<void>
  /** Rendered at the end of each video's row, for "add to another playlist". */
  rowExtra?: (video: YTResult) => React.ReactNode
}

/**
 * One playlist's videos, expanded in place under its row.
 *
 * Fetched on expansion rather than up front, for the same reason an album's
 * tracks are: a channel can hold dozens of playlists and nobody opens all of
 * them. Only the first page loads, with the rest behind a button, because a
 * YouTube playlist can run to thousands of entries.
 */
export function YTPlaylistTracks({ playlistId, canEdit, canPreview, onAdd, rowExtra }: TracksProps) {
  const [videos, setVideos] = useState<YTResult[]>([])
  const [pageToken, setPageToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api.ytPlaylistTracks(playlistId)
      .then((res) => {
        if (cancelled) return
        setVideos(res.results)
        setPageToken(res.next_page_token)
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [playlistId])

  const loadMore = async () => {
    setLoading(true)
    try {
      const res = await api.ytPlaylistTracks(playlistId, pageToken)
      setVideos((prev) => [...prev, ...res.results])
      setPageToken(res.next_page_token)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const addOne = async (video: YTResult) => {
    setAdding(video.id)
    try {
      await onAdd({ url: video.url })
      setAdded((prev) => new Set(prev).add(video.id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAdding(null)
    }
  }

  if (loading && videos.length === 0) {
    return (
      <div className="row wish-album-tracks" style={{ gap: 6 }}>
        <div className="spin" /> <span className="dim small">Loading videos…</span>
      </div>
    )
  }
  if (error && videos.length === 0) return <div className="notice error wish-album-tracks">{error}</div>

  return (
    <div className="wish-album-tracks">
      {error && <div className="notice error">{error}</div>}

      {videos.map((video) => (
        <YTRow
          key={video.id}
          item={video}
          canEdit={canEdit}
          canPreview={canPreview}
          added={added.has(video.id)}
          busy={adding === video.id}
          onAdd={() => void addOne(video)}
        >
          {rowExtra?.(video)}
        </YTRow>
      ))}

      {videos.length === 0 && <div className="empty">This playlist has no playable videos.</div>}

      {pageToken && (
        <button onClick={() => void loadMore()} disabled={loading}>
          {loading ? <div className="spin" /> : null} Load more
        </button>
      )}
    </div>
  )
}
