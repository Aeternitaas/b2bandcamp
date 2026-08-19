import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Modal } from './Modal'
import { Waveform } from './Waveform'
import { usePlayer } from '../state/player'
import { useAuth } from '../state/auth'
import { artUrl, formatDuration } from '../utils'
import { centsOffset, semitonesForRate, transposeKey } from '../audio/analysis'
import type { Playlist, Tralbum } from '../types'
import { Icon } from './Icon'

type Tab = 'analysis' | 'album' | 'save'

const TABS: { key: Tab; label: string }[] = [
  { key: 'analysis', label: 'Analysis' },
  { key: 'album', label: 'Album' },
  { key: 'save', label: 'Save to…' },
]

/** Percentage steps, mirroring the detents on a DJ pitch fader. */
const RATE_STEPS = [-20, -10, -5, 0, 5, 10, 20]

/** Expanded now-playing view: waveform, tempo/key, the source album, and a way
 *  to file the track into another playlist without leaving playback. */
export function NowPlaying({ onClose }: { onClose: () => void }) {
  const player = usePlayer()
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('analysis')

  const track = player.current
  const { analysis, analyze } = player

  // Analysis is opt-in: it downloads the whole track through the proxy, so it
  // should not happen just because playback started.
  useEffect(() => {
    if (tab === 'analysis' && track && analysis.status === 'idle') analyze()
  }, [tab, track, analysis.status, analyze])

  // Nothing is written here: analyzeTrack publishes to the shared analysis
  // cache, and the playlist's bpm column holds only hand-entered overrides.
  // Writing the detection here is what used to erase them.

  if (!track) return null

  const progress = player.duration > 0 ? player.position / player.duration : 0

  return (
    <Modal title="Now playing" onClose={onClose}>
      <div className="col">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {track.art_id
            ? <img className="cover lg" src={artUrl(track.art_id, 9)} alt="" />
            : <div className="cover lg"><Icon name="music" size={34} /></div>}

          <div className="col" style={{ gap: 4, minWidth: 0, flex: 1 }}>
            <h2 className="truncate">{track.title}</h2>
            <div className="dim small truncate">{track.artist}</div>
            {track.album_title && <div className="faint small truncate">{track.album_title}</div>}

            {track.track_url && (
              <a
                href={track.track_url}
                target="_blank"
                rel="noreferrer noopener"
                className="small"
                style={{ marginTop: 4 }}
              >
                Open on Bandcamp <Icon name="external-link" size={12} />
              </a>
            )}
          </div>
        </div>

        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'analysis' && (
          <AnalysisTab progress={progress} />
        )}

        {tab === 'album' && (
          <AlbumTab
            albumId={track.bc_album_id}
            bandId={track.bc_band_id}
            currentTrackId={track.bc_track_id}
          />
        )}

        {tab === 'save' && (
          <SaveTab
            signedIn={!!user}
            trackId={track.bc_track_id}
            bandId={track.bc_band_id}
            sourcePlaylistId={track.playlist_id}
          />
        )}
      </div>
    </Modal>
  )
}

function AnalysisTab({ progress }: { progress: number }) {
  const player = usePlayer()
  const { analysis } = player
  const track = player.current

  const overridden = !!track && track.bpm !== null
  const detectedBpm = analysis.tempo && analysis.tempo.bpm > 0
    ? analysis.tempo.bpm
    : track?.detected_bpm ?? null

  const clearOverride = async () => {
    if (!track || track.playlist_id <= 0) return
    try {
      await api.updateTrack(track.playlist_id, track.id, { bpm: null })
      track.bpm = null // the list refetches on navigation
    } catch {
      // A read-only viewer simply cannot clear it.
    }
  }

  const shift = player.preservePitch ? 0 : semitonesForRate(player.rate)
  const shownKey = analysis.key && shift !== 0 ? transposeKey(analysis.key, shift) : analysis.key
  const detune = centsOffset(shift)
  const percent = (player.rate - 1) * 100

  return (
    <div className="col">
      <Waveform
        peaks={analysis.peaks}
        progress={progress}
        onSeek={(ratio) => player.seek(ratio * player.duration)}
      />

      <div className="row small faint" style={{ justifyContent: 'space-between' }}>
        <span>{formatDuration(player.position)}</span>
        <span>{formatDuration(player.duration)}</span>
      </div>

      {analysis.status === 'loading' && (
        <div className="row">
          <div className="spin" />
          <span className="dim small">Downloading and analysing audio…</span>
        </div>
      )}

      {analysis.status === 'error' && (
        <div className="notice error">Could not analyse this track: {analysis.error}</div>
      )}

      {analysis.status === 'ready' && (
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">Tempo</div>
            <div className="stat-value">
              {analysis.tempo && analysis.tempo.bpm > 0 ? `${analysis.tempo.bpm}` : ', '}
              <span className="stat-unit"> BPM</span>
            </div>
            {analysis.tempo && (
              <div className="faint small">{confidenceLabel(analysis.tempo.confidence)}</div>
            )}

            {/* Overrides are deliberate, so say when one is in force and give
                the way back to the detected value. */}
            {track && track.playlist_id > 0 && overridden && (
              <div className="faint small">
                manual {Math.round(track.bpm!)}
                {detectedBpm ? ` · detected ${Math.round(detectedBpm)}` : ''}
                <button
                  className="ghost icon"
                  style={{ minHeight: 0, padding: '1px 5px', marginLeft: 4 }}
                  onClick={() => void clearOverride()}
                  title="Discard the manual value and use the detected tempo"
                >
                  use detected
                </button>
              </div>
            )}
          </div>

          <div className="stat">
            <div className="stat-label">Key</div>
            <div className="stat-value">{shownKey ? shownKey.name : ', '}</div>
            {shownKey && (
              <div className="faint small">
                Camelot {shownKey.camelot} · {confidenceLabel(shownKey.confidence)}
              </div>
            )}
            {shownKey && analysis.key && shift !== 0 && (
              <div className="faint small">
                {Math.round(shift) >= 0 ? '+' : ''}{Math.round(shift)} st
                {detune !== 0 && ` ${detune > 0 ? '+' : ''}${detune}\u00a2`} from {analysis.key.name}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="rate">
          Playback tempo, {percent >= 0 ? '+' : ''}{percent.toFixed(1)}%
          {analysis.tempo && analysis.tempo.bpm > 0 && (
            <span className="faint"> ({Math.round(analysis.tempo.bpm * player.rate)} BPM)</span>
          )}
        </label>
        <input
          id="rate"
          className="tempo-slider"
          type="range"
          min={-20}
          max={20}
          step={0.1}
          value={percent}
          onChange={(e) => player.setRate(1 + Number(e.target.value) / 100)}
          aria-valuetext={`${percent >= 0 ? '+' : ''}${percent.toFixed(1)} percent`}
        />
        <div className="row wrap" style={{ gap: 4 }}>
          {RATE_STEPS.map((step) => (
            <button
              key={step}
              className={Math.abs(percent - step) < 0.05 ? 'icon' : 'ghost icon'}
              onClick={() => player.setRate(1 + step / 100)}
            >
              {step > 0 ? '+' : ''}{step}%
            </button>
          ))}
        </div>
        <label className="row small" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={player.preservePitch}
            onChange={(e) => player.setPreservePitch(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Keep original pitch when changing tempo
        </label>
      </div>
    </div>
  )
}

function AlbumTab({
  albumId, bandId, currentTrackId,
}: { albumId: number | null; bandId: number | null; currentTrackId: number }) {
  const player = usePlayer()
  const [album, setAlbum] = useState<Tralbum | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!albumId || !bandId) return
    let cancelled = false
    setLoading(true)

    api.details('a', albumId, bandId)
      .then((d) => { if (!cancelled) { setAlbum(d); setError('') } })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [albumId, bandId])

  if (!albumId || !bandId) {
    return <div className="empty">This track isn't part of an album on Bandcamp.</div>
  }
  if (loading) return <div className="row"><div className="spin" /> <span className="dim">Loading album…</span></div>
  if (error) return <div className="notice error">{error}</div>
  if (!album) return null

  return (
    <div className="col">
      <div className="row">
        {album.art_url && <img className="cover" src={album.art_url} alt="" />}
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <h2 className="truncate">{album.title}</h2>
          <span className="dim small truncate">{album.artist}</span>
          {album.release_date && <span className="faint small">{album.release_date.slice(0, 4)}</span>}
        </div>
      </div>

      <div className="popover-tracks" style={{ maxHeight: 'none' }}>
        {album.tracks.map((t) => (
          <div className={`popover-track${t.track_id === currentTrackId ? ' playing' : ''}`} key={t.track_id}>
            <span className="track-index">{t.track_num}</span>
            <span className="truncate small" style={{ flex: 1 }}>{t.title}</span>
            <span className="faint small">{formatDuration(t.duration)}</span>
            <a
              className="ghost icon"
              href={t.track_url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${t.title} on Bandcamp`}
              style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 6px' }}
            >
              <Icon name="external-link" size={13} />
            </a>
          </div>
        ))}
      </div>

      <a href={album.url} target="_blank" rel="noreferrer noopener" className="small">
        Open album on Bandcamp <Icon name="external-link" size={12} />
      </a>

      <span className="faint small">
        Playing from the current queue, {player.queue.length} track{player.queue.length === 1 ? '' : 's'}.
      </span>
    </div>
  )
}

function SaveTab({
  signedIn, trackId, bandId, sourcePlaylistId,
}: { signedIn: boolean; trackId: number; bandId: number | null; sourcePlaylistId: number }) {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)
  const [saved, setSaved] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')

  useEffect(() => {
    if (!signedIn) { setLoading(false); return }
    api.listPlaylists()
      .then((res) => setPlaylists(res.playlists))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [signedIn])

  const save = useCallback(async (playlistId: number) => {
    if (!bandId) return
    setBusy(playlistId)
    setError('')
    try {
      await api.addTracks(playlistId, { items: [{ type: 't', id: trackId, band_id: bandId }] })
      setSaved((prev) => new Set(prev).add(playlistId))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }, [trackId, bandId])

  if (!signedIn) {
    return <div className="empty">Sign in to save this track to your own playlists.</div>
  }
  if (loading) return <div className="row"><div className="spin" /> <span className="dim">Loading…</span></div>

  const targets = playlists.filter((p) => p.role === 'owner' || p.role === 'collaborator')

  return (
    <div className="col">
      {error && <div className="notice error">{error}</div>}
      {targets.length === 0 && <div className="empty">You have no other playlists yet.</div>}

      {targets.map((p) => {
        const isSource = p.id === sourcePlaylistId
        const isSaved = saved.has(p.id)
        return (
          <div className="row" key={p.id}>
            <div className="track-meta">
              <div className="track-title truncate">{p.title}</div>
              <div className="track-sub">
                {p.track_count} track{p.track_count === 1 ? '' : 's'}
                {isSource && ' · currently playing from here'}
              </div>
            </div>
            <button
              className={isSaved ? 'ghost icon' : 'icon'}
              disabled={busy !== null || isSaved}
              onClick={() => save(p.id)}
              aria-label={`Add to ${p.title}`}
            >
              {busy === p.id ? <div className="spin" /> : <Icon name={isSaved ? 'check' : 'plus'} />}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function confidenceLabel(value: number): string {
  if (value >= 0.7) return 'high confidence'
  if (value >= 0.4) return 'moderate confidence'
  return 'low confidence'
}
