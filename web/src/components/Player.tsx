import { useCallback, useEffect, useRef, useState } from 'react'
import { NowPlaying } from './NowPlaying'
import { Waveform } from './Waveform'
import { useCompactLayout } from '../hooks/useMediaQuery'
import { centsOffset, semitonesForRate, transposeKey } from '../audio/analysis'
import { usePlayer } from '../state/player'
import { artUrl, formatDuration as fmt } from '../utils'
import { Icon } from './Icon'

export function Player() {
  const player = usePlayer()
  const {
    current, playing, position, duration, error,
    volume, muted, toggle, next, prev, seek, stop, setVolume, toggleMute,
  } = player

  const observerRef = useRef<ResizeObserver | null>(null)

  /**
   * Publishes the player's real height so the page can reserve room for it.
   *
   * A callback ref rather than an effect: the player renders nothing when no
   * track is loaded, so an effect with empty deps runs while the element does
   * not exist yet and never fires again once it appears. This runs on every
   * mount and unmount of the bar, which is exactly when the measurement
   * changes, including when the analysis panel expands it.
   */
  const measureBar = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null

    if (!node) {
      document.documentElement.style.removeProperty('--player-actual-h')
      return
    }

    const apply = () => {
      document.documentElement.style.setProperty('--player-actual-h', `${node.offsetHeight}px`)
    }
    apply()

    const observer = new ResizeObserver(apply)
    observer.observe(node)
    observerRef.current = observer
  }, [])

  // Tidy up if the whole player unmounts without the ref being cleared.
  useEffect(() => () => {
    observerRef.current?.disconnect()
    document.documentElement.style.removeProperty('--player-actual-h')
  }, [])

  const [expanded, setExpanded] = useState(false)
  const [showVolume, setShowVolume] = useState(false)
  const [showAnalysis, setShowAnalysis] = useState(false)
  const compact = useCompactLayout()

  const { analysis, analyze } = player

  // The readouts are part of the bar now, so analysis runs for whatever is
  // playing. It is cheap after the first time: the result is cached server-side
  // and keyed by track, so a repeat play costs one small request.
  useEffect(() => {
    if (!current || analysis.status !== 'idle') return
    if (compact && !showAnalysis) return // a phone still gates the download
    analyze()
  }, [current, analysis.status, analyze, compact, showAnalysis])

  // Nothing is written here any more: analyzeTrack publishes to the shared
  // analysis cache, and the playlist's bpm column holds only hand-entered
  // overrides. Writing the detection here is what used to erase them.



  if (!current) return null


  // The bar's key readout is a preview only: it always shows what the key
  // would become at the current tempo, regardless of whether pitch
  // correction (set from the full Now Playing view) is actually on. Nothing
  // here commits, the audio element's real pitch handling is untouched.
  const shift = semitonesForRate(player.rate)
  const shownKey = analysis.key && shift !== 0
    ? transposeKey(analysis.key, shift)
    : analysis.key
  const detune = centsOffset(shift)
  // The slider works in percent so that 0, unmodified playback, sits exactly
  // at the centre, the way a pitch fader does.
  const percent = (player.rate - 1) * 100
  const effectiveVolume = muted ? 0 : volume

  return (
    <>
      {/* One fixed-height row. The waveform doubles as the scrubber, so the
          analysis controls cost no extra height and the page never has to
          reserve more room when they appear. */}
      <div className="player" ref={measureBar}>
        <div className="player-inner">
          <button
            className="ghost p-art"
            onClick={() => setExpanded(true)}
            aria-label="Open now playing"
          >
            {current.art_id
              ? <img className="player-art" src={artUrl(current.art_id, 3)} alt="" loading="lazy" />
              : <span className="player-art" />}
          </button>

          {/* On a phone there is no room for both, so the analysis readouts
              take the metadata's place rather than growing the bar. */}
          {!(compact && showAnalysis) && (
            <button
              className="track-meta ghost p-meta"
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
          )}

          <div className="p-transport">
            <button className="ghost icon" onClick={prev} aria-label="Previous track">
              <Icon name="skip-back" />
            </button>
            <button className="icon" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play'} size={18} />
            </button>
            <button className="ghost icon" onClick={next} aria-label="Next track">
              <Icon name="skip-forward" />
            </button>
          </div>

          <div className="p-wave">
            <Waveform
              peaks={analysis.peaks}
              progress={duration > 0 ? position / duration : 0}
              onSeek={(ratio) => seek(ratio * duration)}
              height={compact ? 30 : 36}
            />
            {analysis.status === 'loading' && (
              <span className="wave-status"><div className="spin" /></span>
            )}
          </div>

          <div className={`p-stats${compact && showAnalysis ? ' show' : ''}`}>
            <span className="p-stat">
              <span className="p-stat-label">BPM</span>
              <span className="p-stat-value">
                {analysis.tempo && analysis.tempo.bpm > 0
                  ? Math.round(analysis.tempo.bpm * player.rate)
                  : current.detected_bpm
                    ? Math.round(current.detected_bpm * player.rate)
                    : ', '}
              </span>
            </span>
            <span className="p-stat">
              <span className="p-stat-label">Key</span>
              <span className="p-stat-value">{shownKey ? shownKey.camelot : ', '}</span>
              {shownKey && <span className="p-stat-sub">{shortKeyName(shownKey.name)}</span>}
            </span>
          </div>

          <div className={`p-tempo${compact && showAnalysis ? ' show' : ''}`}>
            <span className="p-stat-label">
              {percent >= 0 ? '+' : ''}{percent.toFixed(1)}%
              {detune !== 0 && (
                <span className="faint"> {detune > 0 ? '+' : ''}{detune}&#162;</span>
              )}
            </span>
            <input
              className="tempo-slider"
              type="range"
              min={-20}
              max={20}
              step={0.1}
              value={percent}
              onChange={(e) => player.setRate(1 + Number(e.target.value) / 100)}
              onDoubleClick={() => player.setRate(1)}
              aria-label="Playback tempo, percent"
              aria-valuetext={`${percent >= 0 ? '+' : ''}${percent.toFixed(1)} percent`}
            />
            <button
              className="ghost icon p-pitch"
              onClick={() => player.setRate(1)}
              disabled={percent === 0}
              aria-label="Reset tempo to 0%"
              title="Reset tempo to 0%"
            >
              <Icon name="rotate-ccw" size={14} />
            </button>
          </div>

          <div className="volume p-volume">
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

          {/* Only a phone needs this: elsewhere the analysis controls are
              already on screen. */}
          {compact && (
            <button
              className={showAnalysis ? 'icon p-toggle' : 'ghost icon p-toggle'}
              onClick={() => setShowAnalysis((v) => !v)}
              aria-pressed={showAnalysis}
              aria-label="Tempo and key"
            >
              <Icon name="activity" />
            </button>
          )}

          <div className="small faint player-time p-time">
            {fmt(position)} / {fmt(duration)}
          </div>

          <button className="ghost icon p-close" onClick={stop} aria-label="Close player">
            <Icon name="x" />
          </button>
        </div>
      </div>

      {expanded && <NowPlaying onClose={() => setExpanded(false)} />}
    </>
  )
}

/** "A# minor" -> "Bbm", the notation that fits in a player-bar readout. */
function shortKeyName(name: string): string {
  const [tonic, scale] = name.split(' ')
  if (!tonic) return name
  const asFlat: Record<string, string> = {
    'A#': 'Bb', 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab',
  }
  const root = scale === 'minor' ? (asFlat[tonic] ?? tonic) : tonic
  return scale === 'minor' ? `${root}m` : root
}
