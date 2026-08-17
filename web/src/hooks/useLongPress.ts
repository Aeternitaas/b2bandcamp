import { useCallback, useRef } from 'react'

interface Options {
  onLongPress: () => void
  onClick?: () => void
  /** Milliseconds held before it counts as a long press. */
  delay?: number
  enabled?: boolean
}

/** Movement beyond this many pixels means the finger is scrolling, not holding. */
const MOVE_TOLERANCE = 10

/**
 * Long-press plus tap on one element.
 *
 * Touch devices have no room for a permanent checkbox column, so selection is
 * entered by holding a row — the convention every mobile list uses. The
 * movement tolerance is what keeps a scroll gesture from being read as a hold,
 * which is the failure mode that makes hand-rolled long-press feel broken.
 */
export function useLongPress({ onLongPress, onClick, delay = 450, enabled = true }: Options) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const moved = useRef(false)

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled) return
    // Ignore secondary buttons; a right-click is not a hold.
    if (e.pointerType === 'mouse' && e.button !== 0) return

    fired.current = false
    moved.current = false
    start.current = { x: e.clientX, y: e.clientY }
    clear()
    timer.current = setTimeout(() => {
      fired.current = true
      // A short buzz confirms the mode switch, which is otherwise easy to miss.
      navigator.vibrate?.(12)
      onLongPress()
    }, delay)
  }, [enabled, delay, onLongPress, clear])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!start.current) return
    const dx = Math.abs(e.clientX - start.current.x)
    const dy = Math.abs(e.clientY - start.current.y)
    if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
      // The finger is scrolling. Cancel the hold *and* remember that this
      // gesture moved, or the release would be read as a tap and start
      // playback on every scroll.
      moved.current = true
      start.current = null
      clear()
    }
  }, [clear])

  const onPointerUp = useCallback(() => {
    clear()
    start.current = null

    // A completed long press already acted; the release must not also fire the
    // tap handler. A gesture that moved was a scroll, not a tap.
    const wasLongPress = fired.current
    const wasScroll = moved.current
    fired.current = false
    moved.current = false

    if (wasLongPress || wasScroll) return
    onClick?.()
  }, [clear, onClick])

  const onPointerCancel = useCallback(() => {
    clear()
    start.current = null
    fired.current = false
    moved.current = false
  }, [clear])

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
