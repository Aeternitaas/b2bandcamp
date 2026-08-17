import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { AddTracks } from './AddTracks'
import { Avatar } from './Avatar'
import { ContributorMenu } from './ContributorMenu'
import { Icon } from './Icon'
import {
  TrackColumnHeader, TrackColumnPanel, trackGridTemplate, useTrackColumns,
} from './trackColumns'
import type { SortKey, SortState } from './trackColumns'
import { TrackRow } from './TrackRow'
import { useCompactLayout } from '../hooks/useMediaQuery'
import { PlaylistSettings } from './PlaylistSettings'
import { SortableList } from './SortableList'
import { WishlistSidebar } from './WishlistSidebar'
import { usePlayer } from '../state/player'
import { analyzeTrack } from '../audio/analyzeTrack'
import { formatTotal, playlistCover } from '../utils'
import type { Fan, Playlist, Track, TrackRef } from '../types'

/** The key to show: a hand-entered override wins over what analysis found. */
export function effectiveKey(track: Track): string {
  return track.key_override || track.key_camelot
}

/** The tempo to show: a hand-entered override wins over what analysis found. */
export function effectiveBpm(track: Track): number | null {
  return track.bpm ?? track.detected_bpm
}

function compareNullable(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0
  if (a === null) return 1 // unanalysed tracks sort last either way
  if (b === null) return -1
  return a - b
}

/**
 * Orders Camelot codes musically rather than alphabetically: 1A, 1B, 2A ... 12B.
 * A plain string sort would put "10A" before "2A".
 */
function compareCamelot(a: string, b: string): number {
  const parse = (code: string) => {
    const m = /^(\d{1,2})([AB])$/.exec(code.trim())
    return m ? { n: Number(m[1]), letter: m[2] } : null
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa && !pb) return 0
  if (!pa) return 1
  if (!pb) return -1
  return pa.n - pb.n || pa.letter.localeCompare(pb.letter)
}

/** Groups tracks by who added them; anonymous public-link edits share a bucket. */
function contributorKey(track: Track): string {
  return track.added_by === null ? 'anon' : String(track.added_by)
}

interface Props {
  playlist: Playlist
  tracks: Track[]
  canEdit: boolean
  onPlaylistChange: (p: Playlist) => void
  /**
   * Accepts an updater as well as a value. Every read-modify-write below must
   * use the updater form: two async operations finishing out of order would
   * otherwise each map over the array captured at their own render, and the
   * later one would silently discard the earlier one's result.
   */
  onTracksChange: React.Dispatch<React.SetStateAction<Track[]>>
  /** Shown instead of the settings button when viewing through a share link. */
  shareMode?: boolean
}

export function PlaylistView({
  playlist, tracks, canEdit, onPlaylistChange, onTracksChange, shareMode,
}: Props) {
  const navigate = useNavigate()
  const player = usePlayer()

  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showWishlist, setShowWishlist] = useState(false)
  // Kept here rather than on the playlist: the wishlist source is a browsing
  // aid for this session, not part of the playlist's saved state.
  const [wishlistFan, setWishlistFan] = useState<Fan | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [showFilter, setShowFilter] = useState(false)
  const [showColumns, setShowColumns] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [analyzing, setAnalyzing] = useState<{ done: number; total: number } | null>(null)
  const [sort, setSort] = useState<SortState | null>(null)
  const [analyzingRows, setAnalyzingRows] = useState<Set<number>>(new Set())
  const cols = useTrackColumns()
  const compact = useCompactLayout()
  // Contributors whose tracks are hidden. Storing the exclusions rather than
  // the inclusions means people who add tracks later show up by default.
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const isOwner = playlist.role === 'owner'
  const cover = useMemo(() => playlistCover(playlist, tracks, 9), [playlist, tracks])

  // One entry per person who has added a track, plus an "anonymous" bucket for
  // tracks added through a public link without an account.
  const contributors = useMemo(() => {
    const map = new Map<string, {
      key: string; userId: number | null; name: string; avatar: string; count: number
    }>()

    for (const t of tracks) {
      const key = contributorKey(t)
      const existing = map.get(key)
      if (existing) {
        existing.count++
        continue
      }
      map.set(key, {
        key,
        userId: t.added_by,
        name: t.added_by_name,
        avatar: t.added_by_avatar,
        count: 1,
      })
    }

    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [tracks])

  const filtering = hidden.size > 0
  const visibleTracks = useMemo(() => {
    const shown = filtering ? tracks.filter((t) => !hidden.has(contributorKey(t))) : tracks
    if (!sort) return shown

    const sorted = shown.slice()
    sorted.sort((a, b) => {
      const cmp = sort.key === 'position'
        ? a.position - b.position
        : sort.key === 'bpm'
          ? compareNullable(effectiveBpm(a), effectiveBpm(b))
          : compareCamelot(effectiveKey(a), effectiveKey(b))
      return sort.direction === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [tracks, hidden, filtering, sort])

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, direction: 'asc' }
      // asc -> desc -> back to the playlist's own order.
      return prev.direction === 'asc' ? { key, direction: 'desc' } : null
    })
  }, [])

  // Numbering follows the playlist, not the filtered view, so hiding a
  // contributor leaves gaps (1, 3, 4) rather than renumbering what remains.
  const trackNumbers = useMemo(() => {
    const numbers = new Map<number, number>()
    tracks.forEach((t, i) => numbers.set(t.id, i + 1))
    return numbers
  }, [tracks])

  // "Show only their tracks" — hide everyone else rather than tracking a
  // separate mode, so the checkbox panel stays the single source of truth.
  const isolateContributor = useCallback((key: string) => {
    setHidden(new Set(contributors.map((c) => c.key).filter((k) => k !== key)))
    setShowFilter(true)
  }, [contributors])

  const toggleContributor = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const addRefs = useCallback(async (refs: TrackRef[]) => {
    const res = await api.addTracks(playlist.id, { items: refs })
    onTracksChange(res.tracks)
    onPlaylistChange({ ...playlist, track_count: res.tracks.length })
  }, [playlist, onPlaylistChange, onTracksChange])

  const addUrl = useCallback(async (url: string) => {
    const res = await api.addTracks(playlist.id, { url })
    onTracksChange(res.tracks)
    onPlaylistChange({ ...playlist, track_count: res.tracks.length })
  }, [playlist, onPlaylistChange, onTracksChange])

  const reorder = useCallback(async (next: Track[]) => {
    // Show the new order immediately; reconcile with the server afterwards.
    onTracksChange(next)
    try {
      const res = await api.reorderTracks(playlist.id, next.map((t) => t.id))
      onTracksChange(res.tracks)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [playlist.id, onTracksChange])

  const removeTrack = useCallback(async (track: Track) => {
    setBusy(true)
    try {
      await api.deleteTrack(playlist.id, track.id)
      onTracksChange((prev) => {
        const next = prev.filter((t) => t.id !== track.id)
        onPlaylistChange({ ...playlist, track_count: next.length })
        return next
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [playlist, tracks, onPlaylistChange, onTracksChange])

  const toggleSelected = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const deleteSelected = useCallback(async () => {
    if (selected.size === 0) return
    setBulkBusy(true)
    setError('')
    try {
      const res = await api.deleteTracks(playlist.id, [...selected])
      onTracksChange(res.tracks)
      onPlaylistChange({ ...playlist, track_count: res.tracks.length })
      setSelected(new Set())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBulkBusy(false)
    }
  }, [selected, playlist, onPlaylistChange, onTracksChange])

  /** Lifts the selection out and reinserts it at one end of the playlist. */
  const moveSelected = useCallback(async (edge: 'top' | 'bottom') => {
    if (selected.size === 0) return
    const block = tracks.filter((t) => selected.has(t.id))
    const others = tracks.filter((t) => !selected.has(t.id))
    const next = edge === 'top' ? [...block, ...others] : [...others, ...block]

    onTracksChange(next)
    setBulkBusy(true)
    try {
      const res = await api.reorderTracks(playlist.id, next.map((t) => t.id))
      onTracksChange(res.tracks)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBulkBusy(false)
    }
  }, [selected, tracks, playlist.id, onTracksChange])

  const playerAnalysis = player.analysis
  useEffect(() => {
    if (playerAnalysis.status !== 'ready' || !playerAnalysis.trackId) return
    const detected = playerAnalysis.tempo?.bpm ?? 0
    const camelot = playerAnalysis.key?.camelot ?? ''
    if (detected <= 0 && !camelot) return

    // Mirrors the shared-cache result into the row so both the BPM and Key
    // columns update without a reload. It writes detected_bpm, never bpm —
    // bpm is the hand-entered override and analysis must not touch it.
    const target = tracks.find((t) => t.id === playerAnalysis.trackId)
    if (!target) return
    if (target.detected_bpm === (detected || null) && target.key_camelot === camelot) return

    onTracksChange((prev) => prev.map((t) => (t.id === target.id ? {
      ...t,
      detected_bpm: detected > 0 ? detected : t.detected_bpm,
      key_camelot: camelot || t.key_camelot,
      key_name: playerAnalysis.key?.name ?? t.key_name,
    } : t)))
  }, [playerAnalysis, tracks, onTracksChange])

  /** Analyses each selected track in turn, recording tempo and key. */
  const analyzeSelected = useCallback(async () => {
    const queue = tracks.filter((t) => selected.has(t.id) && t.bc_band_id)
    if (queue.length === 0) return

    setAnalyzing({ done: 0, total: queue.length })
    setError('')
    const results = new Map<number, { bpm: number | null; camelot: string; name: string }>()
    let failures = 0

    // Sequential on purpose: each track decodes a few MB of audio, and running
    // them in parallel would stall the UI and hammer the proxy.
    for (let i = 0; i < queue.length; i++) {
      const track = queue[i]
      try {
        // analyzeTrack publishes to the shared cache; the detection comes back
        // as detected_bpm and never overwrites a manual override.
        const result = await analyzeTrack(track.bc_track_id, track.bc_band_id!)
        results.set(track.id, {
          bpm: result.tempo.bpm > 0 ? result.tempo.bpm : null,
          camelot: result.key?.camelot ?? '',
          name: result.key?.name ?? '',
        })
      } catch {
        failures++
      }
      setAnalyzing({ done: i + 1, total: queue.length })
    }

    if (results.size > 0) {
      onTracksChange((prev) => prev.map((t) => {
        const found = results.get(t.id)
        return found
          ? { ...t, detected_bpm: found.bpm, key_camelot: found.camelot, key_name: found.name }
          : t
      }))
    }
    if (failures > 0) {
      setError(`Could not analyse ${failures} of ${queue.length} track${queue.length === 1 ? '' : 's'}.`)
    }
    setAnalyzing(null)
  }, [tracks, selected, playlist.id, onTracksChange])

  /**
   * Recomputes one track's analysis, ignoring any cached result. Tempo and key
   * are written together — they come from the same pass, so updating one alone
   * would leave the row showing a stale pairing. Neither touches the manual
   * override in `bpm`.
   */
  const reanalyzeTrack = useCallback(async (track: Track) => {
    if (!track.bc_band_id) return
    setAnalyzingRows((prev) => new Set(prev).add(track.id))
    setError('')
    try {
      const result = await analyzeTrack(track.bc_track_id, track.bc_band_id, { force: true })
      onTracksChange((prev) => prev.map((t) => (t.id === track.id ? {
        ...t,
        detected_bpm: result.tempo.bpm > 0 ? result.tempo.bpm : null,
        key_camelot: result.key?.camelot ?? '',
        key_name: result.key?.name ?? '',
      } : t)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAnalyzingRows((prev) => {
        const next = new Set(prev)
        next.delete(track.id)
        return next
      })
    }
  }, [onTracksChange])

  const saveKey = useCallback(async (track: Track, camelot: string) => {
    try {
      await api.updateTrack(playlist.id, track.id, { key_override: camelot })
      onTracksChange((prev) => prev.map((t) => (
        t.id === track.id ? { ...t, key_override: camelot } : t)))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [playlist.id, onTracksChange])

  const saveBpm = useCallback(async (track: Track, bpm: number | null) => {
    try {
      await api.updateTrack(playlist.id, track.id, { bpm })
      onTracksChange((prev) => prev.map((t) => (t.id === track.id ? { ...t, bpm } : t)))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [playlist.id, onTracksChange])

  // Dragging writes positions from what is on screen, so it is only safe when
  // the view matches the stored order: unfiltered, and either unsorted or
  // sorted by track number ascending (which is that same order).
  const naturalOrder = !sort || (sort.key === 'position' && sort.direction === 'asc')
  const reordering = filtering || !naturalOrder
  const showHandle = canEdit && !reordering
  // analyse, bandcamp link, delete — must match the trailing items TrackRow
  // renders, or the surplus wraps onto a second grid row.
  const actionCount = 2 + (canEdit ? 1 : 0)
  const gridTemplate = useMemo(
    () => trackGridTemplate(cols.visible, {
      select: canEdit && !compact, handle: showHandle, actions: actionCount,
    }),
    [cols.visible, canEdit, compact, showHandle, actionCount],
  )

  const allSelected = visibleTracks.length > 0 && visibleTracks.every((t) => selected.has(t.id))

  return (
    <div className="col">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {cover
          ? <img className="cover lg" src={cover} alt="" />
          : <div className="cover lg"><Icon name="music" size={34} /></div>}

        <div className="col" style={{ gap: 6, minWidth: 0, flex: 1 }}>
          <h1 className="truncate">{playlist.title}</h1>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className={`badge ${playlist.visibility}`}>{playlist.visibility}</span>
            <span className="faint small">{formatTotal(tracks.length, playlist.duration_seconds)}</span>
            {!isOwner && (
              <span className="faint small">
                by <Link to={`/u/${encodeURIComponent(playlist.owner_name)}`}>{playlist.owner_name}</Link>
              </span>
            )}
          </div>
          {playlist.description && <p className="dim small" style={{ margin: 0 }}>{playlist.description}</p>}

          {contributors.length > 0 && (
            <div className="contributor-strip">
              <span className="faint small">Contributors:</span>
              {contributors.map((c) => (
                <ContributorMenu
                  key={c.key}
                  name={c.name}
                  avatarUrl={c.avatar}
                  userId={c.userId}
                  isolated={filtering && !hidden.has(c.key) && hidden.size === contributors.length - 1}
                  onIsolate={() => isolateContributor(c.key)}
                  onClearFilter={() => setHidden(new Set())}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="row wrap playlist-actions">
        <button
          className="primary"
          onClick={() => player.play(visibleTracks, 0)}
          disabled={visibleTracks.length === 0}
        >
          <Icon name="play" size={14} /> Play all
        </button>

        {canEdit && (
          <button onClick={() => setShowAdd(true)}>
            <Icon name="plus" size={14} /> Add music
          </button>
        )}

        <button onClick={() => setShowWishlist(true)}>
          <Icon name="heart" size={14} /> Wishlist{wishlistFan ? `: ${wishlistFan.username}` : ''}
        </button>

        {contributors.length > 1 && (
          <div className="dropdown">
            <button
              onClick={() => setShowFilter((v) => !v)}
              aria-expanded={showFilter}
              aria-haspopup="menu"
              className={filtering ? '' : 'ghost'}
            >
              <Icon name="user" size={14} /> Contributors
              {filtering && ` (${contributors.length - hidden.size}/${contributors.length})`}
              <Icon name="chevron-down" size={13} />
            </button>

            {showFilter && (
              <>
                <div className="dropdown-scrim" onClick={() => setShowFilter(false)} role="presentation" />
                <div className="dropdown-menu" role="menu">
                  <div className="row" style={{ gap: 6 }}>
                    <span className="faint small" style={{ flex: 1 }}>Show tracks from</span>
                    <button className="ghost icon" onClick={() => setHidden(new Set())} disabled={!filtering}>
                      All
                    </button>
                    <button
                      className="ghost icon"
                      onClick={() => setHidden(new Set(contributors.map((c) => c.key)))}
                      disabled={hidden.size === contributors.length}
                    >
                      None
                    </button>
                  </div>

                  {contributors.map((c) => (
                    <label className="contributor" key={c.key}>
                      <input
                        type="checkbox"
                        checked={!hidden.has(c.key)}
                        onChange={() => toggleContributor(c.key)}
                      />
                      <Avatar name={c.name} avatarUrl={c.avatar} userId={c.userId} size={22} />
                      <span className="truncate" style={{ flex: 1 }}>{c.name || 'Anonymous'}</span>
                      <span className="faint small">{c.count}</span>
                    </label>
                  ))}

                  {filtering && (
                    <span className="faint small">
                      Showing {visibleTracks.length} of {tracks.length}. Track numbers keep their
                      real position.
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div className="spacer" />

        {!shareMode && canEdit && (
          <>
            <button
              className="ghost"
              onClick={() => setShowColumns((v) => !v)}
              aria-expanded={showColumns}
              aria-label="Configure columns"
            >
              <Icon name="sliders" size={14} /> Columns
            </button>
            <button className="ghost" onClick={() => setShowSettings(true)} aria-label="Playlist settings">
              <Icon name="settings" size={14} /> Settings
            </button>
          </>
        )}
      </div>

      {!canEdit && (
        <div className="notice info">
          You're viewing this playlist read-only.
          {playlist.visibility === 'shared' && ' Sign in with the share link open to become a collaborator.'}
        </div>
      )}

      {showColumns && (
        <TrackColumnPanel
          columns={cols.columns}
          onToggle={cols.toggle}
          onReorder={cols.reorder}
          onReset={cols.reset}
          sort={sort}
          onSort={toggleSort}
        />
      )}

      {canEdit && selected.size > 0 && (
        <div className="bulk-bar">
          <span className="small">{selected.size} selected</span>
          <div className="spacer" />
          <button
            className="ghost icon"
            disabled={bulkBusy || analyzing !== null}
            onClick={analyzeSelected}
            title="Detect tempo for the selected tracks"
          >
            {analyzing
              ? <><div className="spin" /> Analysing {analyzing.done}/{analyzing.total}</>
              : <><Icon name="activity" size={13} /> Analyse</>}
          </button>
          <button className="ghost icon" disabled={bulkBusy || analyzing !== null} onClick={() => moveSelected('top')}>
            Move to top
          </button>
          <button className="ghost icon" disabled={bulkBusy || analyzing !== null} onClick={() => moveSelected('bottom')}>
            Move to bottom
          </button>
          <button className="ghost icon danger" disabled={bulkBusy || analyzing !== null} onClick={deleteSelected}>
            {bulkBusy ? <div className="spin" /> : <Icon name="trash" size={13} />} Delete
          </button>
          <button className="ghost icon" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {compact && canEdit && selected.size === 0 && tracks.length > 0 && (
        <span className="faint small">Tap to play · hold a track to select.</span>
      )}

      {canEdit && selected.size > 1 && !reordering && (
        <span className="faint small">
          Drag any selected row to move all {selected.size} together.
        </span>
      )}

      {error && <div className="notice error">{error}</div>}

      {filtering && visibleTracks.length === 0 ? (
        <div className="empty">No tracks from the selected contributors.</div>
      ) : tracks.length === 0 ? (
        <div className="empty">
          Nothing here yet.
          {canEdit && ' Add music with a Bandcamp link, a search, or from a wishlist.'}
        </div>
      ) : (
        <>
        {!compact && (
        <TrackColumnHeader
          columns={cols.columns}
          visible={cols.visible}
          template={gridTemplate}
          showHandle={showHandle}
          actions={actionCount}
          onResize={cols.resize}
          onReorder={cols.reorder}
          sort={sort}
          onSort={toggleSort}
          select={canEdit ? {
            checked: allSelected,
            onChange: () => setSelected(allSelected
              ? new Set()
              : new Set(visibleTracks.map((t) => t.id))),
          } : undefined}
        />
        )}
        <SortableList
          items={visibleTracks}
          keyOf={(t) => t.id}
          onReorder={reorder}
          selectedKeys={selected as Set<string | number>}
          // Reordering a filtered subset would renumber only the visible rows
          // and scramble the hidden ones, so it is turned off while filtering.
          disabled={!canEdit || reordering}
          renderItem={(track, { index, dragging, handle }) => (
            <TrackRow
              track={track}
              number={trackNumbers.get(track.id) ?? index + 1}
              columns={cols.columns}
              gridTemplate={gridTemplate}
              compact={compact}
              canEdit={canEdit}
              selected={selected.has(track.id)}
              selecting={selected.size > 0}
              isCurrent={player.current?.id === track.id}
              isPlaying={player.playing}
              dragging={dragging}
              showHandle={showHandle}
              showCheckbox={canEdit && !compact}
              handle={handle}
              effectiveBpm={effectiveBpm(track)}
              effectiveKey={effectiveKey(track)}
              busy={busy}
              onPlay={() => player.play(visibleTracks, index)}
              onToggleSelect={() => toggleSelected(track.id)}
              onRemove={() => removeTrack(track)}
              onSaveBpm={(v) => saveBpm(track, v)}
              onSaveKey={(code) => saveKey(track, code)}
              onReanalyze={track.bc_band_id ? () => reanalyzeTrack(track) : undefined}
              analyzing={analyzingRows.has(track.id)}
              contributorMenu={{
                isolated: filtering && !hidden.has(contributorKey(track))
                  && hidden.size === contributors.length - 1,
                onIsolate: () => isolateContributor(contributorKey(track)),
                onClearFilter: () => setHidden(new Set()),
              }}
            />
          )}
        />
        </>
      )}

      {canEdit && (
        <button className="append-row" onClick={() => setShowAdd(true)}>
          <Icon name="plus" size={14} />
          Add a track to the end of this playlist
        </button>
      )}

      {showAdd && (
        <AddTracks
          onClose={() => setShowAdd(false)}
          onAdd={addRefs}
          onAddUrl={addUrl}
        />
      )}

      {showSettings && (
        <PlaylistSettings
          playlist={playlist}
          isOwner={isOwner}
          onClose={() => setShowSettings(false)}
          onSaved={onPlaylistChange}
          onDeleted={() => navigate('/')}
        />
      )}

      {showWishlist && (
        <WishlistSidebar
          canEdit={canEdit}
          fan={wishlistFan}
          onFanChange={setWishlistFan}
          onClose={() => setShowWishlist(false)}
          onAdd={addRefs}
        />
      )}
    </div>
  )
}
