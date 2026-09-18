import { useCallback, useState } from 'react'
import { api } from '../api'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import { YTPlaylistTracks, YTRow } from './YouTubeBrowser'
import { capsOf, playlistUrl, useSourceCaps } from '../sources'
import type { AddPayload, Playlist, YTChannel, YTResult } from '../types'

/** Everything the YouTube half of the sidebar has loaded, held by the parent so
 *  it survives the panel closing and reopening, the same way the Bandcamp half
 *  keeps its fan and items. */
export interface YTWishlistCache {
  channel: YTChannel | null
  playlists: YTResult[]
  token: string
}

export const EMPTY_YT_CACHE: YTWishlistCache = { channel: null, playlists: [], token: '' }

interface Props {
  canEdit: boolean
  cache: YTWishlistCache
  onCacheChange: (next: YTWishlistCache | ((prev: YTWishlistCache) => YTWishlistCache)) => void
  onAdd: (payload: AddPayload) => Promise<void>
  /** The user's other editable playlists, for sending a copy elsewhere. */
  otherPlaylists: Playlist[]
  onAddToOther: (playlistId: number, payload: AddPayload) => Promise<void>
}

/**
 * Browse any YouTube account's public playlists and pull videos into the
 * playlist, which is what the Bandcamp half of this sidebar does for a
 * wishlist. A playlist can be added whole, or expanded in place to pick
 * individual videos, exactly as an album can.
 *
 * YouTube has no wishlist. Public playlists are the nearest thing: they are
 * what somebody has gathered and chosen to publish, which is the same reason to
 * look at a stranger's wishlist.
 */
export function YouTubeWishlist({
  canEdit, cache, onCacheChange, onAdd, otherPlaylists, onAddToOther,
}: Props) {
  const { channel, playlists, token } = cache
  const [input, setInput] = useState(channel?.handle ?? '')
  const [looking, setLooking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())

  const caps = capsOf(useSourceCaps(), 'youtube')

  const loadPage = useCallback(async (channelId: string, pageToken: string, replace: boolean) => {
    setLoading(true)
    setError('')
    try {
      const page = await api.ytPlaylists(channelId, pageToken)
      onCacheChange((prev) => ({
        ...prev,
        playlists: replace ? page.results : [...prev.playlists, ...page.results],
        token: page.next_page_token,
      }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [onCacheChange])

  const lookup = useCallback(async (name: string) => {
    const wanted = name.trim()
    if (!wanted) return

    setLooking(true)
    setError('')
    try {
      const found = await api.ytChannel(wanted)
      onCacheChange({ channel: found, playlists: [], token: '' })
      setAdded(new Set())
      setExpanded(null)
      await loadPage(found.id, '', true)
    } catch (e) {
      setError((e as Error).message)
      onCacheChange((prev) => ({ ...prev, channel: null }))
    } finally {
      setLooking(false)
    }
  }, [loadPage, onCacheChange])

  const clearChannel = () => {
    onCacheChange(EMPTY_YT_CACHE)
    setInput('')
    setExpanded(null)
  }

  const addWhole = async (item: YTResult) => {
    setBusy(item.id)
    setError('')
    try {
      await onAdd({ url: item.url })
      setAdded((prev) => new Set(prev).add(item.id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Every channel has an uploads playlist, and it is the only thing worth
  // showing for an account that posts videos but curates no playlists. It is
  // presented as one more playlist rather than as a special case, so it adds,
  // expands and links out like the rest.
  const uploads: YTResult | null = channel?.uploads_playlist_id
    ? {
        kind: 'p',
        id: channel.uploads_playlist_id,
        title: 'All uploads',
        artist: channel.title,
        channel_id: channel.id,
        art_url: channel.image_url,
        url: playlistUrl(channel.uploads_playlist_id),
        duration: 0,
        item_count: 0,
        playable: true,
      }
    : null

  const rows = uploads ? [uploads, ...playlists] : playlists

  return (
    <div className="col">
      {!channel && (
        <div className="col" style={{ gap: 8 }}>
          <div className="field">
            <label htmlFor="yt-channel-input">YouTube account</label>
            <input
              id="yt-channel-input"
              value={input}
              placeholder="@handle, channel link, or name"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void lookup(input) }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
          <button className="primary" onClick={() => void lookup(input)} disabled={looking || !input.trim()}>
            {looking ? <div className="spin" /> : null} View playlists
          </button>
          <span className="faint small">
            Public playlists only. Not saved to the playlist, this is just for browsing while you build it.
          </span>
        </div>
      )}

      {channel && (
        <div className="row small dim">
          {channel.image_url && (
            <img className="cover" src={channel.image_url} alt="" style={{ width: 22, height: 22 }} />
          )}
          <span className="truncate">
            {channel.handle && channel.handle !== channel.title
              ? `${channel.title} (${channel.handle})`
              : channel.title}
          </span>
          <div className="spacer" />
          <span className="faint" style={{ whiteSpace: 'nowrap' }}>
            {rows.length}{token ? '+' : ''} shown
          </span>
          <button className="icon" onClick={clearChannel} aria-label="Choose a different account">
            change
          </button>
        </div>
      )}

      {error && <div className="notice error">{error}</div>}

      {channel && rows.length === 0 && !loading && !error && (
        <div className="empty">This account has no public playlists.</div>
      )}

      {rows.map((item) => {
        const isOpen = expanded === item.id
        return (
          <div key={item.id}>
            <YTRow
              item={item}
              canEdit={canEdit}
              canPreview={caps.stream}
              added={added.has(item.id)}
              busy={busy === item.id}
              onAdd={() => void addWhole(item)}
              onToggle={() => setExpanded((id) => (id === item.id ? null : item.id))}
              expanded={isOpen}
            >
              <AddToPlaylistButton
                playlists={otherPlaylists}
                disabled={busy !== null}
                label={item.title}
                onAdd={(playlistId) => onAddToOther(playlistId, { url: item.url })}
              />
            </YTRow>

            {isOpen && (
              <YTPlaylistTracks
                playlistId={item.id}
                canEdit={canEdit}
                canPreview={caps.stream}
                onAdd={onAdd}
                rowExtra={(video) => (
                  <AddToPlaylistButton
                    playlists={otherPlaylists}
                    label={video.title}
                    onAdd={(playlistId) => onAddToOther(playlistId, { url: video.url })}
                  />
                )}
              />
            )}
          </div>
        )
      })}

      {loading && <div className="row"><div className="spin" /> <span className="dim small">Loading…</span></div>}

      {token && !loading && channel && (
        <button onClick={() => void loadPage(channel.id, token, false)}>Load more</button>
      )}
    </div>
  )
}
