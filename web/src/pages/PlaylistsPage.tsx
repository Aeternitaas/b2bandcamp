import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { SortableList } from '../components/SortableList'
import type { HandleProps } from '../components/SortableList'
import { formatTotal } from '../utils'
import type { Playlist } from '../types'

type SortMode = 'manual' | 'title' | 'updated' | 'tracks'

const SORTS: { key: SortMode; label: string }[] = [
  { key: 'manual', label: 'Custom order' },
  { key: 'title', label: 'Name A–Z' },
  { key: 'updated', label: 'Recently updated' },
  { key: 'tracks', label: 'Most tracks' },
]

export function PlaylistsPage() {
  const navigate = useNavigate()

  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sort, setSort] = useState<SortMode>(
    () => (localStorage.getItem('b2b:sort') as SortMode) || 'manual',
  )

  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api.listPlaylists()
      .then((res) => { setPlaylists(res.playlists); setError('') })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  useEffect(() => { localStorage.setItem('b2b:sort', sort) }, [sort])

  // Only the custom order is persisted server-side; the others are views over
  // the same list, so switching back to custom restores the saved arrangement.
  const sorted = useMemo(() => {
    const list = playlists.slice()
    switch (sort) {
      case 'title':
        return list.sort((a, b) => a.title.localeCompare(b.title))
      case 'updated':
        return list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      case 'tracks':
        return list.sort((a, b) => b.track_count - a.track_count)
      default:
        return list.sort((a, b) => a.sort_index - b.sort_index)
    }
  }, [playlists, sort])

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const p = await api.createPlaylist(newTitle.trim() || 'Untitled playlist')
      setCreating(false)
      setNewTitle('')
      navigate(`/p/${p.id}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const reorder = async (next: Playlist[]) => {
    setPlaylists(next.map((p, i) => ({ ...p, sort_index: i })))
    try {
      await api.reorderPlaylists(next.map((p) => p.id))
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  const row = (p: Playlist, handle?: HandleProps) => (
    <div className="playlist-row" onClick={() => navigate(`/p/${p.id}`)}>
      {handle && (
        <div
          className="drag-handle"
          {...handle}
          onClick={(e) => e.stopPropagation()}
        >
          ⠿
        </div>
      )}

      {p.cover_url
        ? <img className="cover" src={p.cover_url} alt="" loading="lazy" />
        : <div className="cover">♪</div>}

      <div className="track-meta">
        <div className="track-title truncate">{p.title}</div>
        <div className="track-sub truncate">
          {formatTotal(p.track_count, p.duration_seconds)}
          {p.role !== 'owner' && ` · shared by ${p.owner_name}`}
        </div>
      </div>

      <span className={`badge ${p.visibility}`}>{p.visibility}</span>
    </div>
  )

  return (
    <div className="col">
      <div className="row wrap">
        <h1>Your playlists</h1>
        <div className="spacer" />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          style={{ width: 'auto' }}
          aria-label="Sort playlists"
        >
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <button className="primary" onClick={() => setCreating(true)}>+ New</button>
      </div>

      {error && <div className="notice error">{error}</div>}

      {loading ? (
        <div className="row"><div className="spin" /> <span className="dim">Loading…</span></div>
      ) : playlists.length === 0 ? (
        <div className="empty">
          No playlists yet.<br />
          <button className="primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
            Create your first playlist
          </button>
        </div>
      ) : sort === 'manual' ? (
        <SortableList
          items={sorted}
          keyOf={(p) => p.id}
          onReorder={reorder}
          renderItem={(p, { handle }) => row(p, handle)}
        />
      ) : (
        <div className="playlist-list">
          {sorted.map((p) => <div key={p.id}>{row(p)}</div>)}
        </div>
      )}

      {sort === 'manual' && playlists.length > 1 && (
        <span className="faint small">Drag the ⠿ handle to reorder. Custom order is saved automatically.</span>
      )}

      {creating && (
        <Modal
          title="New playlist"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="primary" onClick={create} disabled={busy}>
                {busy ? <div className="spin" /> : null} Create
              </button>
              <button className="ghost" onClick={() => setCreating(false)}>Cancel</button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="new-title">Name</label>
            <input
              id="new-title"
              value={newTitle}
              autoFocus
              placeholder="Late night mixes"
              maxLength={200}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
