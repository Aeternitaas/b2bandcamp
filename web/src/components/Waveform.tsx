import { useEffect, useRef } from 'react'

interface Props {
  peaks: Float32Array | null
  progress: number // 0–1
  onSeek: (ratio: number) => void
  height?: number
}

/**
 * Canvas waveform with a played/unplayed split and click-to-seek.
 *
 * Canvas rather than SVG because a few hundred bars redrawn on every timeupdate
 * would mean a few hundred DOM mutations per second.
 */
export function Waveform({ peaks, progress, onSeek, height = 72 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const styles = getComputedStyle(canvas)
    const played = styles.getPropertyValue('--accent').trim() || '#33c6e8'
    const pending = styles.getPropertyValue('--border').trim() || '#262f3a'

    // Match the backing store to the device pixel ratio, or the bars blur.
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr
      canvas.height = height * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    if (!peaks || peaks.length === 0) {
      ctx.fillStyle = pending
      ctx.fillRect(0, height / 2 - 1, width, 2)
      return
    }

    const barWidth = Math.max(1, width / peaks.length - 1)
    const step = width / peaks.length
    const mid = height / 2
    const cutoff = progress * width

    for (let i = 0; i < peaks.length; i++) {
      const x = i * step
      const amplitude = Math.max(2, peaks[i] * (height - 4))
      ctx.fillStyle = x < cutoff ? played : pending
      ctx.fillRect(x, mid - amplitude / 2, barWidth, amplitude)
    }
  }, [peaks, progress, height])

  const seekFromEvent = (clientX: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)))
  }

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      style={{ height }}
      role="slider"
      aria-label="Seek within track"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        seekFromEvent(e.clientX)
      }}
      onPointerMove={(e) => { if (e.buttons > 0) seekFromEvent(e.clientX) }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onSeek(Math.max(0, progress - 0.02))
        if (e.key === 'ArrowRight') onSeek(Math.min(1, progress + 0.02))
      }}
    />
  )
}
