import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { TralbumPanel } from './TralbumPanel'
import type { Playlist, TrackRef, WishlistItem } from '../types'

interface Props {
  playlist: Playlist
  canEdit: boolean
  onClose: () => void
  onAdd: (refs: TrackRef[]) => Promise<void>
  onSetFan: (username: string) => Promise<void>
}

type Expanded = { type: 'a' | 't'; id: number; bandId: number; title: string }

/**
 * Toggleable panel showing a chosen Bandcamp user's wishlist. Albums can be
 * added whole with one button, or opened to pick individual songs.
 */
export function WishlistSidebar({ playlist, canEdit, onClose, onAdd, onSetFan }: Props) {
  const [items, setItems] = useState<WishlistItem[]>([])
  const [token, setToken] = useState('')
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Expanded | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [addedItems, setAddedItems] = useState<Set<number>>(new Set())

  const [editingFan, setEditingFan] = useState(!playlist.base_fan_id)
  const [fanInput, setFanInput] = useState(playlist.base_fan_username)
  const [savingFan, setSavingFan] = useState(false)

  const fanId = playlist.base_fan_id

  const loadPage = useCallback(async (nextToken: string, replace: boolean) => {
    if (!fanId) return
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
  }, [fanId])

  useEffect(() => {
    if (!fanId) {
      setItems([])
      return
    }
    setEditingFan(false)
    void loadPage('', true)
  }, [fanId, loadPage])

  const saveFan = async () => {
    const name = fanInput.trim()
    if (!name) return
    setSavingFan(true)
    setError('')
    try {
      await onSetFan(name)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSavingFan(false)
    }
  }

  const addWhole = async (item: WishlistItem) => {
    setBusy(item.tralbum_id)
    setError('')
    try {
      await onAdd([{ type: item.tralbum_type, id: item.tralbum_id, band_id: item.band_id }])
      setAddedItems((prev) => new Set(prev).add(item.tralbum_id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} role="presentation" />

      <aside className="sidebar" aria-label="Bandcamp wishlist">
        <div className="sidebar-head">
          <h2 className="truncate" style={{ flex: 1 }}>
            {expanded ? expanded.title : playlist.base_fan_username ? `${playlist.base_fan_username}'s wishlist` : 'Wishlist'}
          </h2>
          {playlist.base_fan_id && canEdit && !expanded && (
            <button className="ghost icon" onClick={() => setEditingFan((v) => !v)} aria-label="Change Bandcamp user">
              ⚙
            </button>
          )}
          <button className="ghost icon" onClick={onClose} aria-label="Close wishlist">✕</button>
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
              {(editingFan || !playlist.base_fan_id) && (
                <div className="col" style={{ gap: 8 }}>
                  <div className="field">
                    <label htmlFor="fan-input">Bandcamp username</label>
                    <input
                      id="fan-input"
                      value={fanInput}
                      placeholder="username or bandcamp.com/username"
                      onChange={(e) => setFanInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void saveFan() }}
                      disabled={!canEdit}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="row">
                    <button className="primary" onClick={saveFan} disabled={savingFan || !canEdit || !fanInput.trim()}>
                      {savingFan ? <div className="spin" /> : null} Use this wishlist
                    </button>
                    {playlist.base_fan_id && (
                      <button className="ghost" onClick={() => setEditingFan(false)}>Cancel</button>
                    )}
                  </div>
                  {!canEdit && <div className="notice info">You need edit access to change the wishlist source.</div>}
                </div>
              )}

              {error && <div className="notice error">{error}</div>}

              {playlist.base_fan_id && !editingFan && items.length === 0 && !loading && !error && (
                <div className="empty">This wishlist is empty or private.</div>
              )}

              {items.map((item) => {
                const isAdded = addedItems.has(item.tralbum_id)
                return (
                  <div className="wish-item" key={`${item.tralbum_type}-${item.tralbum_id}`}>
                    {item.art_url
                      ? <img className="cover" style={{ width: 44, height: 44 }} src={item.art_url} alt="" loading="lazy" />
                      : <div className="cover" style={{ width: 44, height: 44 }}>♪</div>}

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

                    <button
                      className={isAdded ? 'ghost icon' : 'icon'}
                      disabled={!canEdit || busy !== null || isAdded}
                      onClick={() => addWhole(item)}
                      aria-label={item.tralbum_type === 'a' ? `Add whole album ${item.title}` : `Add ${item.title}`}
                      title={item.tralbum_type === 'a' ? 'Add whole album' : 'Add track'}
                    >
                      {busy === item.tralbum_id ? <div className="spin" /> : isAdded ? '✓' : '+'}
                    </button>
                  </div>
                )
              })}

              {loading && <div className="row"><div className="spin" /> <span className="dim small">Loading…</span></div>}

              {more && !loading && (
                <button onClick={() => loadPage(token, false)}>Load more</button>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
