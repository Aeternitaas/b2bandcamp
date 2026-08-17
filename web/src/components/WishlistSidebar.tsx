import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { TralbumPanel } from './TralbumPanel'
import { WishlistAlbumMenu } from './WishlistAlbumMenu'
import { usePreview } from '../audio/usePreview'
import { useAuth } from '../state/auth'
import type { Fan, TrackRef, WishlistItem } from '../types'
import { Icon } from './Icon'

interface Props {
  canEdit: boolean
  /** Held by the parent so the chosen user survives closing and reopening the
   *  panel, but it is never sent to the server — the choice is per-session. */
  fan: Fan | null
  onFanChange: (fan: Fan | null) => void
  onClose: () => void
  onAdd: (refs: TrackRef[]) => Promise<void>
}

type Expanded = { type: 'a' | 't'; id: number; bandId: number; title: string }

/**
 * Browse any Bandcamp user's wishlist and pull releases into the playlist.
 * Albums can be added whole, or opened to pick individual songs.
 */
export function WishlistSidebar({ canEdit, fan, onFanChange, onClose, onAdd }: Props) {
  const [items, setItems] = useState<WishlistItem[]>([])
  const [token, setToken] = useState('')
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Expanded | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [added, setAdded] = useState<Set<number>>(new Set())

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
      setItems((prev) => (replace ? page.items : [...prev, ...page.items]))
      setToken(page.last_token)
      setMore(page.more_available)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const lookupName = useCallback(async (name: string) => {
    if (!name) return

    setLooking(true)
    setError('')
    try {
      const found = await api.fan(name)
      onFanChange(found)
      setItems([])
      setAdded(new Set())
      await loadPage(found.fan_id, '', true)
    } catch (e) {
      setError((e as Error).message)
      onFanChange(null)
    } finally {
      setLooking(false)
    }
  }, [loadPage, onFanChange])

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
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const clearFan = () => {
    onFanChange(null)
    setItems([])
    // Prefill with the linked account rather than clearing to nothing, so the
    // usual next action is one click.
    setInput(linked)
    setExpanded(null)
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
            {expanded ? expanded.title : fan ? `${fan.username}'s wishlist` : 'Browse a wishlist'}
          </h2>
          {fan && !expanded && (
            <button className="ghost icon" onClick={clearFan} aria-label="Choose a different user">
              change
            </button>
          )}
          <button className="ghost icon" onClick={close} aria-label="Close wishlist"><Icon name="x" /></button>
        </div>

        <div className="sidebar-body">
          {expanded ? (
            <TralbumPanel
              type={expanded.type}
              id={expanded.id}
              bandId={expanded.bandId}
              onAdd={onAdd}
              onBack={() => setExpanded(null)}
            />
          ) : (
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
                return (
                  <div className="wish-item" key={`${item.tralbum_type}-${item.tralbum_id}`}>
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
                      onClick={() => setExpanded({
                        type: item.tralbum_type,
                        id: item.tralbum_id,
                        bandId: item.band_id,
                        title: item.title,
                      })}
                    >
                      <span style={{ minWidth: 0 }}>
                        <span className="track-title truncate" style={{ display: 'block' }}>{item.title}</span>
                        <span className="track-sub truncate" style={{ display: 'block' }}>
                          {item.band_name}
                          {item.tralbum_type === 'a' ? ` · ${item.track_count} tracks` : ' · track'}
                        </span>
                      </span>
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

                    {item.tralbum_type === 'a' ? (
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
                  </div>
                )
              })}

              {loading && <div className="row"><div className="spin" /> <span className="dim small">Loading…</span></div>}

              {more && !loading && fan && (
                <button onClick={() => loadPage(fan.fan_id, token, false)}>Load more</button>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
