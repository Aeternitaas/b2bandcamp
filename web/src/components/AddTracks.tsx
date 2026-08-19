import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { Modal } from './Modal'
import { TralbumPanel } from './TralbumPanel'
import { usePreview } from '../audio/usePreview'
import { debounce, looksLikeBandcampUrl } from '../utils'
import type { SearchResult, TrackRef, Tralbum } from '../types'
import { Icon } from './Icon'

interface Props {
  onClose: () => void
  onAdd: (refs: TrackRef[]) => Promise<void>
  /** Bandcamp track ids already in the playlist, so a repeat add can be caught
   *  before it happens rather than after. */
  existingTrackIds: Set<number>
}

// detail carries what resolving a pasted link already fetched, so opening it
// doesn't pay for a second, identical request to re-derive the same data. A
// search result has no detail yet, only these ids, TralbumPanel fetches it
// as before in that case.
type Selection = { type: 'a' | 't'; id: number; bandId: number; detail?: Tralbum }

const TABS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'a', label: 'Albums' },
  { key: 't', label: 'Tracks' },
  { key: 'b', label: 'Artists' },
]

/**
 * Two ways in: paste a Bandcamp link, or search Bandcamp. Both land on the
 * same expanded release view, with a preview, before anything is added,
 * whether it turns out to be a whole album or a single track. Each search
 * result also has its own quick-add "+", for adding several different
 * matches straight from the list without opening any of them.
 */
export function AddTracks({ onClose, onAdd, existingTrackIds }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [addingUrl, setAddingUrl] = useState(false)
  // Per-row quick-add, keyed by "type-id", lets several different results be
  // added straight from the list, one "+" press each, without opening any of
  // them and without the popup closing in between.
  const [addingRow, setAddingRow] = useState<string | null>(null)
  const [addedRows, setAddedRows] = useState<Set<string>>(new Set())
  // A track result already in the playlist is held here instead of added
  // straight away, so it can be confirmed rather than duplicated by accident.
  const [pendingDuplicate, setPendingDuplicate] = useState<SearchResult | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const preview = usePreview()
  // Leaving the popup ends any preview it started; a half-heard track playing
  // on from a search you have closed is just confusing.
  const close = () => {
    preview.stopPreview()
    onClose()
  }

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

  // A pasted link resolves to the same expanded release view a search result
  // opens into, art, title, artist, and a preview, whether it turns out to
  // be a whole album or a single track, rather than committing to adding it
  // sight (and sound) unheard. The preview itself loads as soon as a
  // recognisable link is pasted, same as search results loading as you type;
  // only the audio stays behind an explicit press, inside that view.
  //
  // A much shorter debounce than search's: a pasted URL arrives complete in
  // one change event, there is no "still typing" to wait out, this only
  // needs to survive someone editing a hand-typed one keystroke at a time.
  // The detail this fetches is kept on the selection so TralbumPanel does not
  // turn around and fetch the exact same thing again.
  const runResolveUrl = useMemo(() => debounce((url: string) => {
    api.resolveUrl(url)
      .then((detail) => {
        setSelected({ type: detail.type, id: detail.id, bandId: detail.band_id, detail })
        setQuery('')
        setError('')
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setAddingUrl(false))
  }, 80), [])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    if (isUrl) {
      setAddingUrl(true)
      setError('')
      runResolveUrl(query.trim())
      return
    }
    setLoading(true)
    runSearch(query)
  }, [query, filter, isUrl, runSearch, runResolveUrl])

  /** Albums have no audio of their own, so preview their first playable track. */
  const previewResult = async (r: SearchResult) => {
    try {
      if (r.type === 't') {
        preview.press({
          trackId: r.id,
          bandId: r.band_id ?? 0,
          title: r.name,
          artist: r.band_name ?? '',
          trackUrl: r.url,
        })
        return
      }

      // Pressing again should scrub rather than refetch the album.
      const detail = await api.details('a', r.id, r.band_id ?? 0)
      const first = detail.tracks.find((t) => t.streamable)
      if (!first) {
        setError('No streamable tracks on this release.')
        return
      }
      preview.press({
        trackId: first.track_id,
        bandId: first.band_id || (r.band_id ?? 0),
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

  /** Adds a result straight from the list, the whole release if it is an
   *  album, so several different matches can be added in a row without
   *  opening any of them. */
  const quickAdd = async (r: SearchResult, skipDuplicateCheck = false) => {
    const key = `${r.type}-${r.id}`
    if (!skipDuplicateCheck && r.type === 't' && existingTrackIds.has(r.id)) {
      setPendingDuplicate(r)
      return
    }
    setPendingDuplicate(null)
    setAddingRow(key)
    setError('')
    try {
      await onAdd([{ type: r.type as 'a' | 't', id: r.id, band_id: r.band_id ?? 0 }])
      setAddedRows((prev) => new Set(prev).add(key))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAddingRow(null)
    }
  }

  const pick = (r: SearchResult) => {
    setPendingDuplicate(null)
    if (r.type === 'b') {
      // An artist has no tracks of its own, search their catalogue instead.
      setQuery(r.name)
      setFilter('a')
      return
    }
    if (r.type !== 'a' && r.type !== 't') return
    setSelected({ type: r.type, id: r.id, bandId: r.band_id ?? 0 })
  }

  return (
    <Modal title="Add music" onClose={close}>
      {selected ? (
        <TralbumPanel
          type={selected.type}
          id={selected.id}
          bandId={selected.bandId}
          onAdd={onAdd}
          onBack={() => setSelected(null)}
          existingTrackIds={existingTrackIds}
          initialDetail={selected.detail}
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
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          {isUrl && addingUrl && (
            <div className="row"><div className="spin" /> <span className="dim small">Loading preview…</span></div>
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

          {pendingDuplicate && (
            <div className="notice info">
              <span>“{pendingDuplicate.name}” is already in this playlist.</span>
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button
                  className="icon"
                  disabled={addingRow !== null}
                  onClick={() => void quickAdd(pendingDuplicate, true)}
                >
                  Add anyway
                </button>
                <button
                  className="ghost icon"
                  disabled={addingRow !== null}
                  onClick={() => setPendingDuplicate(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {loading && <div className="row"><div className="spin" /> <span className="dim small">Searching…</span></div>}

          {!loading && !isUrl && query.trim() && results.length === 0 && !error && (
            <div className="empty">No results for “{query}”.</div>
          )}

          <div>
            {results.map((r) => {
              const previewable = r.type === 'a' || r.type === 't'
              return (
                <div className="result-row" key={`${r.type}-${r.id}`}>
                  {previewable ? (
                    <button
                      className="wish-art"
                      style={{ width: 40, height: 40 }}
                      onClick={() => void previewResult(r)}
                      aria-label={`Preview ${r.name}`}
                      title="Preview, press again to skip ahead"
                    >
                      {r.art_url
                        ? <img src={r.art_url} alt="" loading="lazy" />
                        : <Icon name="music" size={18} />}
                      <span className="popover-art-overlay">
                        <Icon name="play" size={12} />
                      </span>
                    </button>
                  ) : (
                    <div className="cover" style={{ width: 40, height: 40 }}>
                      {r.art_url
                        ? <img src={r.art_url} alt="" loading="lazy" />
                        : <Icon name="music" size={18} />}
                    </div>
                  )}

                  <button
                    className="track-meta ghost"
                    style={{ justifyContent: 'flex-start', textAlign: 'left', padding: 0, minHeight: 0, flex: 1 }}
                    onClick={() => pick(r)}
                  >
                    <span className="track-title truncate" style={{ display: 'block' }}>{r.name}</span>
                    <span className="track-sub truncate" style={{ display: 'block' }}>
                      {r.type === 'b' ? (r.location || 'Artist') : r.band_name}
                    </span>
                  </button>

                  <span className="badge">
                    {r.type === 'a' ? 'album' : r.type === 't' ? 'track' : 'artist'}
                  </span>

                  {previewable && (() => {
                    const key = `${r.type}-${r.id}`
                    const isAdded = addedRows.has(key)
                    return (
                      <button
                        className={isAdded ? 'ghost icon' : 'icon'}
                        disabled={addingRow !== null || isAdded}
                        onClick={() => void quickAdd(r)}
                        aria-label={`Add ${r.name}`}
                        title={r.type === 'a' ? 'Add whole album' : 'Add track'}
                      >
                        {addingRow === key
                          ? <div className="spin" />
                          : <Icon name={isAdded ? 'check' : 'plus'} size={13} />}
                      </button>
                    )
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </Modal>
  )
}
