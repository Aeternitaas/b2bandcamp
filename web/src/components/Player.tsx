import { useCallback, useEffect, useRef, useState } from 'react'
import { NowPlaying } from './NowPlaying'
import { Waveform } from './Waveform'
import { api } from '../api'
import { formatDuration as fmt } from '../utils'
import { centsOffset, semitonesForRate, transposeKey } from '../audio/analysis'
import { usePlayer } from '../state/player'
import { artUrl, formatDuration } from '../utils'
import { Icon } from './Icon'

export function Player() {
  const player = usePlayer()
  const {
    current, playing, position, duration, error,
    volume, muted, toggle, next, prev, seek, stop, setVolume, toggleMute,
  } = player

  const seekRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // The player is fixed to the bottom, so the page needs bottom padding equal
  // to however tall it currently is. Opening the analysis panel changes that,
  // and a static padding would leave the last tracks unreachable.
  useEffect(() => {
    const el = barRef.current
    if (!el) return

    const apply = () => {
      document.documentElement.style.setProperty('--player-actual-h', `${el.offsetHeight}px`)
    }
    apply()

    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--player-actual-h')
    }
  }, [])
  const [expanded, setExpanded] = useState(false)
  const [showVolume, setShowVolume] = useState(false)
  const [showAnalysis, setShowAnalysis] = useState(false)

  const { analysis, analyze } = player

  // Analysis downloads the whole track through the proxy, so it starts only
  // when the panel is actually opened.
  useEffect(() => {
    if (showAnalysis && current && analysis.status === 'idle') analyze()
  }, [showAnalysis, current, analysis.status, analyze])

  // Nothing is written here any more: analyzeTrack publishes to the shared
  // analysis cache, and the playlist's bpm column holds only hand-entered
  // overrides. Writing the detection here is what used to erase them.

  const clearOverride = useCallback(async () => {
    const track = player.current
    if (!track || track.playlist_id <= 0) return
    try {
      await api.updateTrack(track.playlist_id, track.id, { bpm: null })
      track.bpm = null // reflect it here; the list refetches on navigation
    } catch {
      // Read-only viewers simply cannot clear it.
    }
  }, [player])

  const seekTo = useCallback((clientX: number) => {
    const bar = seekRef.current
    if (!bar || !duration) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    seek(ratio * duration)
  }, [duration, seek])

  if (!current) return null

  const progress = duration > 0 ? (position / duration) * 100 : 0

  // Pitch only moves when correction is off; with it on the browser
  // time-stretches and the key is untouched.
  const shift = player.preservePitch ? 0 : semitonesForRate(player.rate)
  const shownKey = analysis.key && shift !== 0
    ? transposeKey(analysis.key, shift)
    : analysis.key
  const detune = centsOffset(shift)
  // The slider works in percent so that 0 — unmodified playback — sits exactly
  // at the centre, the way a pitch fader does.
  const percent = (player.rate - 1) * 100
  const overridden = current.bpm !== null
  const detectedBpm = analysis.tempo && analysis.tempo.bpm > 0
    ? analysis.tempo.bpm
    : current.detected_bpm
  const effectiveVolume = muted ? 0 : volume

  return (
    <>
      <div className="player" ref={barRef}>
        {showAnalysis && (
          <div className="player-analysis">
            <Waveform
              peaks={analysis.peaks}
              progress={progress / 100}
              onSeek={(ratio) => seek(ratio * duration)}
              height={56}
            />

            <div className="row small faint" style={{ justifyContent: 'space-between' }}>
              <span>{fmt(position)}</span>
              {analysis.status === 'loading' && (
                <span className="row" style={{ gap: 6 }}><div className="spin" /> analysing…</span>
              )}
              {analysis.status === 'error' && (
                <span style={{ color: 'var(--danger)' }}>{analysis.error}</span>
              )}
              <span>{fmt(duration)}</span>
            </div>

            <div className="analysis-row">
              <div className="stat">
                <div className="stat-label">Tempo</div>
                <div className="stat-value">
                  {analysis.tempo && analysis.tempo.bpm > 0
                    ? Math.round(analysis.tempo.bpm * player.rate)
                    : '—'}
                  <span className="stat-unit"> BPM</span>
                </div>
                {analysis.tempo && analysis.tempo.bpm > 0 && player.rate !== 1 && (
                  <div className="faint small">{Math.round(analysis.tempo.bpm)} at 1.00x</div>
                )}

                {/* Overrides are deliberate, so say when one is in force and
                    offer the way back to the detected value. */}
                {current.playlist_id > 0 && overridden && (
                  <div className="faint small">
                    manual {Math.round(current.bpm!)}
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
                {current.playlist_id > 0 && !overridden && detectedBpm && (
                  <div className="faint small">detected</div>
                )}
              </div>

              <div className="stat">
                <div className="stat-label">Key</div>
                <div className="stat-value">
                  {shownKey ? shownKey.name : '—'}
                </div>
                {shownKey && (
                  <div className="faint small">
                    Camelot {shownKey.camelot}
                    {shift !== 0 && (
                      <> · {Math.round(shift) >= 0 ? '+' : ''}{Math.round(shift)} st
                        {detune !== 0 && ` ${detune > 0 ? '+' : ''}${detune}\u00a2`}
                      </>
                    )}
                  </div>
                )}
                {shownKey && analysis.key && shift !== 0 && (
                  <div className="faint small">was {analysis.key.name}</div>
                )}
              </div>

              <div className="stat grow">
                <div className="stat-label">
                  Playback tempo — {percent >= 0 ? '+' : ''}{percent.toFixed(1)}%
                </div>
                <input
                  className="tempo-slider"
                  type="range"
                  min={-20}
                  max={20}
                  step={0.1}
                  value={percent}
                  onChange={(e) => player.setRate(1 + Number(e.target.value) / 100)}
                  aria-label="Playback tempo, percent"
                  aria-valuetext={`${percent >= 0 ? '+' : ''}${percent.toFixed(1)} percent`}
                />
                <div className="row" style={{ gap: 6 }}>
                  <button className="ghost icon" onClick={() => player.setRate(1)} disabled={player.rate === 1}>
                    Reset
                  </button>
                  <label className="row small" style={{ gap: 5, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={player.preservePitch}
                      onChange={(e) => player.setPreservePitch(e.target.checked)}
                      style={{ width: 'auto' }}
                    />
                    Correct pitch
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

        <div
          ref={seekRef}
          className="seek"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            seekTo(e.clientX)
          }}
          onPointerMove={(e) => { if (e.buttons > 0) seekTo(e.clientX) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') seek(Math.max(0, position - 5))
            if (e.key === 'ArrowRight') seek(Math.min(duration, position + 5))
          }}
        >
          <div className="seek-fill" style={{ width: `${progress}%` }} />
        </div>

        <div className="player-inner">
          <button
            className="ghost"
            style={{ padding: 0, minHeight: 0, border: 0 }}
            onClick={() => setExpanded(true)}
            aria-label="Open now playing"
          >
            {current.art_id ? (
              <img className="player-art" src={artUrl(current.art_id, 3)} alt="" loading="lazy" />
            ) : (
              <div className="player-art" />
            )}
          </button>

          <button
            className="track-meta ghost"
            style={{ justifyContent: 'flex-start', textAlign: 'left', padding: 0, minHeight: 0 }}
            onClick={() => setExpanded(true)}
            aria-label="Open now playing"
          >
            <span style={{ minWidth: 0 }}>
              <span className="track-title truncate" style={{ display: 'block' }}>{current.title}</span>
              <span className="track-sub truncate" style={{ display: 'block' }}>
                {error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : current.artist}
              </span>
            </span>
          </button>

          <div className="row" style={{ gap: 4 }}>
            <button className="ghost icon" onClick={prev} aria-label="Previous track"><Icon name="skip-back" /></button>
            <button className="icon" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play'} size={18} />
            </button>
            <button className="ghost icon" onClick={next} aria-label="Next track"><Icon name="skip-forward" /></button>
          </div>

          {/* Volume lives behind a toggle on narrow screens so the bar stays
              usable on a phone, and inline once there is room for it. */}
          <div className="volume">
            <button
              className="ghost icon"
              onClick={() => setShowVolume((v) => !v)}
              aria-label="Volume"
              aria-expanded={showVolume}
            >
              <Icon name={effectiveVolume === 0 ? 'volume-mute' : effectiveVolume < 0.5 ? 'volume-low' : 'volume'} />
            </button>
            <div className={`volume-slider${showVolume ? ' open' : ''}`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={effectiveVolume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label="Volume level"
              />
              <button className="ghost icon" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted ? 'unmute' : 'mute'}
              </button>
            </div>
          </div>

          <button
            className={showAnalysis ? 'icon' : 'ghost icon'}
            onClick={() => setShowAnalysis((v) => !v)}
            aria-expanded={showAnalysis}
            aria-label="Waveform, tempo and key"
            title="Waveform, tempo and key"
          >
            <Icon name="activity" />
          </button>

          <div className="small faint player-time">
            {formatDuration(position)} / {formatDuration(duration)}
          </div>

          <button className="ghost icon" onClick={stop} aria-label="Close player"><Icon name="x" /></button>
        </div>
      </div>

      {expanded && <NowPlaying onClose={() => setExpanded(false)} />}
    </>
  )
}
