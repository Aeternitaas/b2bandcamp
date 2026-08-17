import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { Modal } from './Modal'
import { TralbumPanel } from './TralbumPanel'
import { debounce, looksLikeBandcampUrl } from '../utils'
import type { SearchResult, TrackRef } from '../types'
import { Icon } from './Icon'

interface Props {
  onClose: () => void
  onAdd: (refs: TrackRef[]) => Promise<void>
  onAddUrl: (url: string) => Promise<void>
}

type Selection = { type: 'a' | 't'; id: number; bandId: number }

const TABS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'a', label: 'Albums' },
  { key: 't', label: 'Tracks' },
  { key: 'b', label: 'Artists' },
]

/**
 * Two ways in: paste a Bandcamp album or track link, or search Bandcamp. Both
 * land on the same expanded release view, so adding a whole album and cherry-
 * picking a single song are the same two clicks either way.
 */
export function AddTracks({ onClose, onAdd, onAddUrl }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [addingUrl, setAddingUrl] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const isUrl = looksLikeBandcampUrl(query)

  // Ref indirection keeps the debounced function stable across renders while
  // still seeing the current filter.
  const filterRef = useRef(filter)
  filterRef.current = filter

  const runSearch = useMemo(() => debounce((q: string) => {
    if (!q.trim() || looksLikeBandcampUrl(q)) {
      setResults([])
      setLoading(false)
      return
    }
    api.search(q, filterRef.current)
      .then((res) => { setResults(res.results); setError('') })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, 280), [])

  useEffect(() => {
    if (!query.trim() || isUrl) {
      setResults([])
      return
    }
    setLoading(true)
    runSearch(query)
  }, [query, filter, isUrl, runSearch])

  const submitUrl = useCallback(async () => {
    setAddingUrl(true)
    setError('')
    try {
      await onAddUrl(query.trim())
      setQuery('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAddingUrl(false)
    }
  }, [onAddUrl, query])

  const pick = (r: SearchResult) => {
    if (r.type === 'b') {
      // An artist has no tracks of its own — search their catalogue instead.
      setQuery(r.name)
      setFilter('a')
      return
    }
    if (r.type !== 'a' && r.type !== 't') return
    setSelected({ type: r.type, id: r.id, bandId: r.band_id ?? 0 })
  }

  return (
    <Modal title="Add music" onClose={onClose}>
      {selected ? (
        <TralbumPanel
          type={selected.type}
          id={selected.id}
          bandId={selected.bandId}
          onAdd={onAdd}
          onBack={() => setSelected(null)}
        />
      ) : (
        <div className="col">
          <div className="field">
            <label htmlFor="bc-search">Bandcamp link or search</label>
            <input
              id="bc-search"
              ref={inputRef}
              value={query}
              placeholder="https://artist.bandcamp.com/album/… or a search term"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && isUrl) void submitUrl() }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          {isUrl && (
            <button className="primary" onClick={submitUrl} disabled={addingUrl}>
              {addingUrl ? <div className="spin" /> : <Icon name="plus" />} Add from link
            </button>
          )}

          {!isUrl && (
            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={filter === t.key}
                  onClick={() => setFilter(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {error && <div className="notice error">{error}</div>}

          {loading && <div className="row"><div className="spin" /> <span className="dim small">Searching…</span></div>}

          {!loading && !isUrl && query.trim() && results.length === 0 && !error && (
            <div className="empty">No results for “{query}”.</div>
          )}

          <div>
            {results.map((r) => (
              <button
                key={`${r.type}-${r.id}`}
                className="result-row ghost"
                style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', minHeight: 56 }}
                onClick={() => pick(r)}
              >
                {r.art_url
                  ? <img className="cover" style={{ width: 40, height: 40 }} src={r.art_url} alt="" loading="lazy" />
                  : <div className="cover" style={{ width: 40, height: 40 }}><Icon name="music" size={18} /></div>}

                <span className="track-meta">
                  <span className="track-title truncate" style={{ display: 'block' }}>{r.name}</span>
                  <span className="track-sub truncate" style={{ display: 'block' }}>
                    {r.type === 'b' ? (r.location || 'Artist') : r.band_name}
                  </span>
                </span>

                <span className="badge">
                  {r.type === 'a' ? 'album' : r.type === 't' ? 'track' : 'artist'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}
