import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { Modal } from './Modal'
import { TralbumPanel } from './TralbumPanel'
import { YTPlaylistTracks, YTRow } from './YouTubeBrowser'
import { bcSource, usePreview } from '../audio/usePreview'
import { debounce } from '../utils'
import { capsOf, parseLink, useSourceCaps } from '../sources'
import type { AddPayload, SearchResult, SourceId, Tralbum, YTResult } from '../types'
import { Icon } from './Icon'

interface Props {
  onClose: () => void
  onAdd: (payload: AddPayload) => Promise<void>
  /** "source:source_id" for every row already in the playlist, so a repeat add
   *  can be caught before it happens rather than after. */
  existingTracks: Set<string>
  /** Pre-fills the link field, e.g. a link pasted straight into the playlist
   *  view before this popup was open, so it resolves immediately instead of
   *  waiting for the same link to be pasted a second time. */
  initialUrl?: string
}

// detail carries what resolving a pasted link already fetched, so opening it
// doesn't pay for a second, identical request to re-derive the same data. A
// search result has no detail yet, only these ids, TralbumPanel fetches it
// as before in that case.
// What the release panel shows. A pasted link of either source ends up here,
// so both open the same panel.
type Selection =
  | { source?: 'bandcamp'; type: 'a' | 't'; id: number; bandId: number; detail?: Tralbum }
  | { source: 'youtube'; item: YTResult }

const BC_TABS: { key: string; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'a', label: 'Albums' },
  { key: 't', label: 'Tracks' },
  { key: 'b', label: 'Artists' },
]

// No "All" here, unlike Bandcamp's: YouTube's own search mixes channels into an
// unfiltered result set, and a channel is not something this popup can add.
const YT_TABS: { key: string; label: string }[] = [
  { key: 'v', label: 'Videos' },
  { key: 'p', label: 'Playlists' },
]

/**
 * Two ways in: paste a link, or search. Both land on the same expanded view,
 * with a preview, before anything is added, whether it turns out to be an
 * album, a single track, a video or a whole playlist.
 *
 * Searching is per source and Bandcamp is the default, but pasting is not: a
 * link is recognised by what it is, so a YouTube link pasted while the search
 * is set to Bandcamp still does the obvious thing rather than complaining.
 * Each search result also has its own quick-add "+", for adding one straight
 * from the list without opening it.
 */
export function AddTracks({ onClose, onAdd, existingTracks, initialUrl }: Props) {
  const [query, setQuery] = useState(initialUrl ?? '')
  const [source, setSource] = useState<SourceId>('bandcamp')
  const [filter, setFilter] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [ytResults, setYtResults] = useState<YTResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  // A YouTube playlist opened from the results, showing its videos before any
  // of them are added, which is what TralbumPanel does for an album.
  const [openPlaylist, setOpenPlaylist] = useState<YTResult | null>(null)
  const [addingUrl, setAddingUrl] = useState(false)
  // Per-row quick-add, keyed by "type-id", so the pressed row's own button
  // can show a spinner while the popup closes out from under it on success.
  const [addingRow, setAddingRow] = useState<string | null>(null)
  // A result already in the playlist is held here instead of added straight
  // away, so it can be confirmed rather than duplicated by accident. Both
  // sources use it: the title is all the notice needs, and both can name one.
  const [pendingDuplicate, setPendingDuplicate] =
    useState<{ title: string; add: () => Promise<void> } | null>(null)

  const caps = useSourceCaps()
  const ytCaps = capsOf(caps, 'youtube')

  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const preview = usePreview()
  // Leaving the popup ends any preview it started; a half-heard track playing
  // on from a search you have closed is just confusing.
  const close = () => {
    preview.stopPreview()
    onClose()
  }

  // A link is recognised by what it is rather than by which tab is showing, so
  // the source toggle only ever decides where a *search* goes.
  //
  // Memoised so the effect below runs when the query changes, not on every
  // render. This popup re-renders about four times a second while music plays,
  // because it reads the player. A fresh object each render re-ran the effect
  // on every one of those renders.
  const link = useMemo(() => parseLink(query), [query])

  // Ref indirection keeps the debounced functions stable across renders while
  // still seeing the current filter and source.
  const searchRef = useRef({ filter, source })
  searchRef.current = { filter, source }

  const runSearch = useMemo(() => debounce((q: string) => {
    if (!q.trim() || parseLink(q)) {
      setResults([])
      setYtResults([])
      setLoading(false)
      return
    }
    const { filter: kind, source: from } = searchRef.current
    const search = from === 'youtube'
      ? api.ytSearch(q, kind || 'v').then((res) => setYtResults(res.results))
      : api.search(q, kind).then((res) => setResults(res.results))

    search
      .then(() => setError(''))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, 280), [])

  // A pasted Bandcamp link resolves to the same expanded release view a search
  // result opens into, art, title, artist, and a preview, whether it turns out
  // to be a whole album or a single track, rather than committing to adding it
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

  // A YouTube link is looked up, then opens the same release panel that a
  // Bandcamp link opens, so the two work the same way. Nothing reaches the
  // playlist until somebody presses Add.
  //
  // Adding straight from the effect below let one paste add a video twice
  // while music played. Each re-render queued the add again before the first
  // add finished, and nobody was asked first.
  const latestLink = useRef('')
  const runLookupYT = useMemo(() => debounce((url: string) => {
    api.ytLookup(url)
      .then(({ result }) => {
        // Ignore an answer for a link that is no longer in the field.
        if (latestLink.current !== url) return
        setSelected({ source: 'youtube', item: result })
        setQuery('')
        setError('')
      })
      .catch((e: Error) => { if (latestLink.current === url) setError(e.message) })
      .finally(() => { if (latestLink.current === url) setAddingUrl(false) })
  }, 80), [])

  useEffect(() => {
    latestLink.current = link?.source === 'youtube' ? link.url : ''
    setAddingUrl(false)
    if (!query.trim()) {
      setResults([])
      setYtResults([])
      return
    }
    if (link) {
      setAddingUrl(true)
      setError('')
      if (link.source === 'youtube') runLookupYT(link.url)
      else runResolveUrl(link.url)
      return
    }
    setLoading(true)
    runSearch(query)
  }, [query, filter, source, link, runSearch, runResolveUrl, runLookupYT])

  // Each source has its own tabs, and the filter from one means nothing to the
  // other, so switching resets it to that source's default.
  const switchSource = (next: SourceId) => {
    if (next === source) return
    setSource(next)
    setFilter(next === 'youtube' ? 'v' : '')
    setResults([])
    setYtResults([])
    setError('')
  }

  /** Albums have no audio of their own, so preview their first playable track. */
  const previewResult = async (r: SearchResult) => {
    try {
      if (r.type === 't') {
        preview.press({
          ...bcSource(r.id, r.band_id ?? 0),
          title: r.name,
          artist: r.band_name ?? '',
          track_url: r.url,
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
        ...bcSource(first.track_id, first.band_id || (r.band_id ?? 0)),
        title: first.title,
        artist: first.artist,
        album_title: detail.title,
        art_id: first.art_id,
        duration: first.duration,
        track_url: first.track_url,
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
    // Only a single track can duplicate a row. An album is a request for
    // several, and warning about one of them would be noise.
    if (!skipDuplicateCheck && r.type === 't' && existingTracks.has(`bandcamp:${r.id}`)) {
      setPendingDuplicate({ title: r.name, add: () => quickAdd(r, true) })
      return
    }
    setPendingDuplicate(null)
    setAddingRow(key)
    setError('')
    try {
      await onAdd({ items: [{ type: r.type as 'a' | 't', id: r.id, band_id: r.band_id ?? 0 }] })
      close()
    } catch (e) {
      setError((e as Error).message)
      setAddingRow(null)
    }
  }

  /** The YouTube equivalent: a video or a whole playlist, added by its link.
   *  A playlist skips the duplicate check for the same reason an album does. */
  const quickAddYT = async (r: YTResult, skipDuplicateCheck = false) => {
    if (!skipDuplicateCheck && r.kind === 'v' && existingTracks.has(`youtube:${r.id}`)) {
      setPendingDuplicate({ title: r.title, add: () => quickAddYT(r, true) })
      return
    }
    setPendingDuplicate(null)
    setAddingRow(`yt-${r.id}`)
    setError('')
    try {
      await onAdd({ url: r.url })
      close()
    } catch (e) {
      setError((e as Error).message)
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

  if (selected) {
    return (
      <Modal title="Add music" onClose={close}>
        {selected.source === 'youtube' ? (
          <TralbumPanel
            source="youtube"
            item={selected.item}
            onAdd={onAdd}
            onClose={close}
            onBack={() => setSelected(null)}
            existingTracks={existingTracks}
          />
        ) : (
          <TralbumPanel
            type={selected.type}
            id={selected.id}
            bandId={selected.bandId}
            onAdd={onAdd}
            onClose={close}
            onBack={() => setSelected(null)}
            existingTracks={existingTracks}
            initialDetail={selected.detail}
          />
        )}
      </Modal>
    )
  }

  if (openPlaylist) {
    return (
      <Modal title="Add music" onClose={close}>
        <div className="col">
          <button className="ghost" onClick={() => setOpenPlaylist(null)} style={{ alignSelf: 'flex-start' }}>
            <Icon name="arrow-left" /> Back
          </button>
          <YTRow
            item={openPlaylist}
            canEdit
            canPreview={ytCaps.stream}
            added={false}
            busy={addingRow === `yt-${openPlaylist.id}`}
            onAdd={() => void quickAddYT(openPlaylist)}
          />
          <YTPlaylistTracks
            playlistId={openPlaylist.id}
            canEdit
            canPreview={ytCaps.stream}
            onAdd={onAdd}
          />
        </div>
      </Modal>
    )
  }

  const tabs = source === 'youtube' ? YT_TABS : BC_TABS

  return (
    <Modal title="Add music" onClose={close}>
      <div className="col">
        {/* Only offered where it would work: without an API key the server
            cannot search YouTube, and a toggle that always errors is worse
            than no toggle. Links still work either way. */}
        {ytCaps.search && (
          <div className="tabs source-tabs" role="tablist" aria-label="Search which source">
            <button
              role="tab"
              aria-selected={source === 'bandcamp'}
              onClick={() => switchSource('bandcamp')}
            >
              <Icon name="bandcamp" size={13} /> Bandcamp
            </button>
            <button
              role="tab"
              aria-selected={source === 'youtube'}
              onClick={() => switchSource('youtube')}
            >
              <Icon name="youtube" size={13} /> YouTube
            </button>
          </div>
        )}

        <div className="field">
          <label htmlFor="bc-search">
            {source === 'youtube' ? 'YouTube link or search' : 'Bandcamp link or search'}
          </label>
          <input
            id="bc-search"
            ref={inputRef}
            value={query}
            placeholder={source === 'youtube'
              ? 'https://youtu.be/… or a search term'
              : 'https://artist.bandcamp.com/album/… or a search term'}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <span className="faint small">
            Any Bandcamp or YouTube link works here, whichever tab is showing.
          </span>
        </div>

        {link && addingUrl && (
          <div className="row">
            <div className="spin" />{' '}
            <span className="dim small">
              Loading preview…
            </span>
          </div>
        )}

        {!link && (
          <div className="tabs" role="tablist">
            {tabs.map((t) => (
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
            <span>“{pendingDuplicate.title}” is already in this playlist.</span>
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <button
                className="icon"
                disabled={addingRow !== null}
                onClick={() => void pendingDuplicate.add()}
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

        {!loading && !link && query.trim() && results.length === 0 && ytResults.length === 0 && !error && (
          <div className="empty">No results for “{query}”.</div>
        )}

        {source === 'youtube' ? (
          <div>
            {ytResults.map((r) => (
              <YTRow
                key={r.id}
                item={r}
                canEdit
                canPreview={ytCaps.stream}
                added={false}
                busy={addingRow === `yt-${r.id}`}
                onAdd={() => void quickAddYT(r)}
                onToggle={r.kind === 'p' ? () => setOpenPlaylist(r) : undefined}
              />
            ))}
          </div>
        ) : (
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

                  {previewable && (
                    <button
                      className="icon"
                      disabled={addingRow !== null}
                      onClick={() => void quickAdd(r)}
                      aria-label={`Add ${r.name}`}
                      title={r.type === 'a' ? 'Add whole album' : 'Add track'}
                    >
                      {addingRow === `${r.type}-${r.id}`
                        ? <div className="spin" />
                        : <Icon name="plus" size={13} />}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
