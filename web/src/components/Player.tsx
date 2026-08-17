import { useCallback, useRef } from 'react'
import { usePlayer } from '../state/player'
import { artUrl, formatDuration } from '../utils'

export function Player() {
  const { current, playing, position, duration, error, toggle, next, prev, seek, stop } = usePlayer()
  const seekRef = useRef<HTMLDivElement>(null)

  const seekTo = useCallback((clientX: number) => {
    const bar = seekRef.current
    if (!bar || !duration) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    seek(ratio * duration)
  }, [duration, seek])

  if (!current) return null

  const progress = duration > 0 ? (position / duration) * 100 : 0

  return (
    <div className="player">
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
        {current.art_id ? (
          <img className="player-art" src={artUrl(current.art_id, 3)} alt="" loading="lazy" />
        ) : (
          <div className="player-art" />
        )}

        <div className="track-meta">
          <div className="track-title truncate">{current.title}</div>
          <div className="track-sub truncate">
            {error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : current.artist}
          </div>
        </div>

        <div className="row" style={{ gap: 4 }}>
          <button className="ghost icon" onClick={prev} aria-label="Previous track">⏮</button>
          <button className="icon" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '⏸' : '▶'}
          </button>
          <button className="ghost icon" onClick={next} aria-label="Next track">⏭</button>
        </div>

        <div className="small faint player-time">
          {formatDuration(position)} / {formatDuration(duration)}
        </div>

        <button className="ghost icon" onClick={stop} aria-label="Close player">✕</button>
      </div>
    </div>
  )
}
