import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { api } from '../api'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import { WishlistAlbumMenu } from './WishlistAlbumMenu'
import { WishlistAlbumTracks } from './WishlistAlbumTracks'
import { usePreview } from '../audio/usePreview'
import { useAuth } from '../state/auth'
import type { Fan, Playlist, TrackRef, WishlistItem } from '../types'
import { Icon } from './Icon'

/** Everything about the last-loaded wishlist, held by the parent so it
 *  survives the panel closing and reopening — closing this panel is meant to
 *  be dismissal, not a reason to lose what was already fetched. */
export interface WishlistCache {
  fan: Fan | null
  items: WishlistItem[]
  token: string
  more: boolean
}

export const EMPTY_WISHLIST_CACHE: WishlistCache = { fan: null, items: [], token: '', more: false }

interface Props {
  canEdit: boolean
  /** So "add to another playlist" can leave the currently open one out of
   *  its own list of options. */
  currentPlaylistId: number
  cache: WishlistCache
  onCacheChange: Dispatch<SetStateAction<WishlistCache>>
  onClose: () => void
  onAdd: (refs: TrackRef[]) => Promise<void>
}

/**
 * Browse any Bandcamp user's wishlist and pull releases into the playlist.
 * Albums can be added whole, or expanded in place to pick individual songs.
 */
export function WishlistSidebar({ canEdit, currentPlaylistId, cache, onCacheChange, onClose, onAdd }: Props) {
  const { fan, items, token, more } = cache
  // Other playlists this item could go to instead of (or as well as) the one
  // that is open. Fetched once — the "+" next to each item covers the open
  // playlist already, this is only for sending a copy somewhere else.
  const [otherPlaylists, setOtherPlaylists] = useState<Playlist[]>([])
  useEffect(() => {
    api.listPlaylists()
      .then((res) => setOtherPlaylists(res.playlists.filter((p) => (
        p.id !== currentPlaylistId && (p.role === 'owner' || p.role === 'collaborator')
      ))))
      .catch(() => {}) // the extra button just won't have anywhere to offer
  }, [currentPlaylistId])

  const addToOtherPlaylist = useCallback(async (playlistId: number, refs: TrackRef[]) => {
    await api.addTracks(playlistId, { items: refs })
  }, [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Which wishlisted album is showing its track list inline, right under its
  // own row — an accordion, not a navigation, so the list underneath it never
  // unmounts and its scroll position survives opening one.
  const [expandedAlbum, setExpandedAlbum] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [added, setAdded] = useState<Set<number>>(new Set())
  // What the currently loaded preview came from, so the row it was pressed
  // from can be highlighted. Re-checked against the live player on every
  // render (via preview.isPreviewing) rather than trusted on its own, so a
  // stale entry here never shows a highlight nothing is actually playing.
  const [previewSource, setPreviewSource] = useState<{ type: 'a' | 't'; id: number; trackId: number } | null>(null)

  const [input, setInput] = useState(fan?.username ?? '')
  const [autoTried, setAutoTried] = useState(false)
  const preview = usePreview()
  const { user } = useAuth()
  const linked = user?.bandcamp_username ?? ''
  const [looking, setLooking] = useState(false)

  const loadPage = useCallback(async (fanId: number, nextToken: string, replace: boolean) => {
    setLoading(true)
    setError('')
    try {
      const page = await api.wishlist(fanId, nextToken)
      onCacheChange((prev) => ({
        ...prev,
        items: replace ? page.items : [...prev.items, ...page.items],
        token: page.last_token,
        more: page.more_available,
      }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [onCacheChange])

  const lookupName = useCallback(async (name: string) => {
    if (!name) return

    setLooking(true)
    setError('')
    try {
      const found = await api.fan(name)
      onCacheChange((prev) => ({ ...prev, fan: found, items: [], token: '', more: false }))
      setAdded(new Set())
      await loadPage(found.fan_id, '', true)
    } catch (e) {
      setError((e as Error).message)
      onCacheChange((prev) => ({ ...prev, fan: null }))
    } finally {
      setLooking(false)
    }
  }, [loadPage, onCacheChange])

  /** Re-fetches the current fan's wishlist from scratch — for picking up a
   *  track added on Bandcamp since it was last loaded. */
  const reload = useCallback(() => {
    if (fan) void loadPage(fan.fan_id, '', true)
  }, [fan, loadPage])

  const lookup = useCallback(() => lookupName(input.trim()), [lookupName, input])

  // Open straight onto the account linked in Settings, so the common case needs
  // no typing. Only once per mount, and never over a choice already made.
  useEffect(() => {
    if (autoTried || fan || !linked) return
    setAutoTried(true)
    setInput(linked)
    void lookupName(linked)
  }, [autoTried, fan, linked, lookupName])

  const addWhole = async (item: WishlistItem) => {
    setBusy(item.tralbum_id)
    setError('')
    try {
      await onAdd([{ type: item.tralbum_type, id: item.tralbum_id, band_id: item.band_id }])
      setAdded((prev) => new Set(prev).add(item.tralbum_id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  /** Albums have no audio of their own, so preview their first playable track. */
  const previewItem = async (item: WishlistItem) => {
    try {
      if (item.tralbum_type === 't') {
        preview.press({
          trackId: item.tralbum_id,
          bandId: item.band_id,
          title: item.title,
          artist: item.band_name,
          trackUrl: item.item_url,
        })
        setPreviewSource({ type: 't', id: item.tralbum_id, trackId: item.tralbum_id })
        return
      }

      // Pressing again should scrub rather than refetch the album.
      const detail = await api.details('a', item.tralbum_id, item.band_id)
      const first = detail.tracks.find((t) => t.streamable)
      if (!first) {
        setError('No streamable tracks on this release.')
        return
      }
      preview.press({
        trackId: first.track_id,
        bandId: first.band_id || item.band_id,
        title: first.title,
        artist: first.artist,
        albumTitle: detail.title,
        artId: first.art_id,
        duration: first.duration,
        trackUrl: first.track_url,
      })
      setPreviewSource({ type: 'a', id: item.tralbum_id, trackId: first.track_id })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** True while the last thing pressed from this row is what is actually
   *  loaded in the player right now. */
  const isRowPlaying = (type: 'a' | 't', id: number) => (
    !!previewSource && previewSource.type === type && previewSource.id === id
    && preview.isPreviewing(previewSource.trackId)
  )

  const clearFan = () => {
    onCacheChange({ fan: null, items: [], token: '', more: false })
    // Prefill with the linked account rather than clearing to nothing, so the
    // usual next action is one click.
    setInput(linked)
    setExpandedAlbum(null)
  }

  // Leaving the panel ends any preview it started; a half-heard track playing
  // on from a sidebar you have closed is just confusing.
  const close = () => {
    preview.stopPreview()
    onClose()
  }

  return (
    <>
      <div className="sidebar-backdrop" onClick={close} role="presentation" />

      <aside className="sidebar" aria-label="Bandcamp wishlist">
        <div className="sidebar-head">
          <h2 className="truncate" style={{ flex: 1 }}>
            {fan ? `${fan.username}'s wishlist` : 'Browse a wishlist'}
          </h2>
          {fan && (
            <>
              <button
                className="icon"
                onClick={reload}
                disabled={loading}
                aria-label={`Reload ${fan.username}'s wishlist`}
                title="Reload — pick up anything added on Bandcamp since this last loaded"
              >
                <Icon name="rotate-ccw" size={13} />
              </button>
              <button className="icon" onClick={clearFan} aria-label="Choose a different user">
                change
              </button>
            </>
          )}
          <button className="icon" onClick={close} aria-label="Close wishlist"><Icon name="x" /></button>
        </div>

        <div className="sidebar-body">
          <div className="col">
              {!fan && (
                <div className="col" style={{ gap: 8 }}>
                  <div className="field">
                    <label htmlFor="fan-input">Bandcamp username</label>
                    <input
                      id="fan-input"
                      value={input}
                      placeholder="username, display name, or profile link"
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void lookup() }}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <button className="primary" onClick={lookup} disabled={looking || !input.trim()}>
                      {looking ? <div className="spin" /> : null} View wishlist
                    </button>
                    {linked && input.trim().toLowerCase() !== linked.toLowerCase() && (
                      <button
                        className="ghost"
                        onClick={() => { setInput(linked); void lookupName(linked) }}
                        disabled={looking}
                      >
                        Use mine ({linked})
                      </button>
                    )}
                  </div>
                  <span className="faint small">
                    Not saved to the playlist — this is just for browsing while you build it.
                    {!linked && ' Link your Bandcamp account in Settings to open your own wishlist by default.'}
                  </span>
                </div>
              )}

              {fan && (
                <div className="row small dim">
                  <span className="truncate">
                    {fan.name && fan.name !== fan.username ? `${fan.name} (${fan.username})` : fan.username}
                  </span>
                  <div className="spacer" />
                  {/* The count on the profile page reads 0 for some accounts
                      even when the wishlist is populated, so report what was
                      actually loaded rather than that unreliable figure. */}
                  <span className="faint">
                    {items.length}{more ? '+' : ''} shown
                  </span>
                </div>
              )}

              {error && <div className="notice error">{error}</div>}

              {fan && items.length === 0 && !loading && !error && (
                <div className="empty">This wishlist is empty or private.</div>
              )}

              {items.map((item) => {
                const isAdded = added.has(item.tralbum_id)
                const isAlbum = item.tralbum_type === 'a'
                const isOpen = isAlbum && expandedAlbum === item.tralbum_id
                return (
                  <div key={`${item.tralbum_type}-${item.tralbum_id}`}>
                    <div className={`wish-item${isRowPlaying(item.tralbum_type, item.tralbum_id) ? ' playing' : ''}`}>
                      <button
                        className="wish-art"
                        onClick={() => previewItem(item)}
                        aria-label={`Preview ${item.title}`}
                        title="Preview — press again to skip ahead"
                      >
                        {item.art_url
                          ? <img src={item.art_url} alt="" loading="lazy" />
                          : <Icon name="music" size={18} />}
                        <span className="popover-art-overlay">
                          <Icon name="play" size={12} />
                        </span>
                      </button>

                      <button
                        className="track-meta ghost"
                        style={{ justifyContent: 'flex-start', textAlign: 'left', padding: 0, minHeight: 0 }}
                        onClick={() => (isAlbum
                          ? setExpandedAlbum((id) => (id === item.tralbum_id ? null : item.tralbum_id))
                          : previewItem(item))}
                        aria-expanded={isAlbum ? isOpen : undefined}
                      >
                        <span style={{ minWidth: 0 }}>
                          <span className="track-title truncate" style={{ display: 'block' }}>{item.title}</span>
                          <span className="track-sub truncate" style={{ display: 'block' }}>
                            {item.band_name}
                            {isAlbum ? ` · ${item.track_count} tracks` : ' · track'}
                          </span>
                        </span>
                        {isAlbum && (
                          <Icon name="chevron-down" size={13} className={isOpen ? 'flip-v' : undefined} />
                        )}
                      </button>

                      <a
                        className="ghost icon"
                        href={item.item_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label={`Open ${item.title} on Bandcamp`}
                        style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 8px' }}
                      >
                        <Icon name="external-link" size={13} />
                      </a>

                      {isAlbum ? (
                        <WishlistAlbumMenu
                          item={item}
                          canEdit={canEdit}
                          added={isAdded}
                          busy={busy === item.tralbum_id}
                          onAddAlbum={() => addWhole(item)}
                          onAddTrack={(ref) => onAdd([ref])}
                        />
                      ) : (
                        <button
                          className={isAdded ? 'ghost icon' : 'icon'}
                          disabled={!canEdit || busy !== null || isAdded}
                          onClick={() => addWhole(item)}
                          aria-label={`Add ${item.title}`}
                          title="Add track"
                        >
                          {busy === item.tralbum_id
                            ? <div className="spin" />
                            : <Icon name={isAdded ? 'check' : 'plus'} />}
                        </button>
                      )}

                      <AddToPlaylistButton
                        playlists={otherPlaylists}
                        disabled={busy !== null}
                        label={item.title}
                        onAdd={(playlistId) => addToOtherPlaylist(playlistId,
                          [{ type: item.tralbum_type, id: item.tralbum_id, band_id: item.band_id }])}
                      />
                    </div>

                    {isOpen && (
                      <WishlistAlbumTracks
                        item={item}
                        canEdit={canEdit}
                        preview={preview}
                        onTrackPreviewed={(trackId) => setPreviewSource({ type: 'a', id: item.tralbum_id, trackId })}
                        onAdd={onAdd}
                      />
                    )}
                  </div>
                )
              })}

              {loading && <div className="row"><div className="spin" /> <span className="dim small">Loading…</span></div>}

              {more && !loading && fan && (
                <button onClick={() => loadPage(fan.fan_id, token, false)}>Load more</button>
              )}
          </div>
        </div>
      </aside>
    </>
  )
}
