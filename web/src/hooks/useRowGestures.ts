import { useCallback, useRef, useState } from 'react'

interface Options {
  onTap?: () => void
  onLongPress?: () => void
  /** Enables swipe-left-to-reveal. */
  swipeable?: boolean
  longPressDelay?: number
  enabled?: boolean
}

/** Movement past this is a gesture, not a press. */
const SLOP = 10
/** How far left the row must travel before the actions latch open. */
const REVEAL_THRESHOLD = 40

/**
 * Tap, long-press and swipe-left on a list row.
 *
 * These have to be decided together: a hold, a scroll and a swipe all begin
 * with the same pointerdown, and the direction of the first few pixels is what
 * separates them. Handling them in one place is what stops a scroll from
 * playing a track or a swipe from opening selection.
 */
export function useRowGestures({
  onTap, onLongPress, swipeable = false, longPressDelay = 450, enabled = true,
}: Options) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const axis = useRef<'none' | 'horizontal' | 'vertical'>('none')
  const fired = useRef(false)
  const moved = useRef(false)

  const [offset, setOffset] = useState(0)
  const [revealed, setRevealed] = useState(false)

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const close = useCallback(() => {
    setRevealed(false)
    setOffset(0)
  }, [])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!enabled) return
    if (e.pointerType === 'mouse' && e.button !== 0) return

    fired.current = false
    moved.current = false
    axis.current = 'none'
    start.current = { x: e.clientX, y: e.clientY }

    clearTimer()
    if (onLongPress) {
      timer.current = setTimeout(() => {
        fired.current = true
        navigator.vibrate?.(12)
        onLongPress()
      }, longPressDelay)
    }
  }, [enabled, onLongPress, longPressDelay, clearTimer])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y

    // Lock to whichever axis wins first, so a swipe cannot turn into a scroll
    // halfway through and vice versa.
    if (axis.current === 'none') {
      if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) {
        axis.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
        moved.current = true
        clearTimer()
      } else {
        return
      }
    }

    if (axis.current === 'horizontal' && swipeable) {
      // Only leftward travel reveals; rightward just closes an open row.
      const next = Math.max(-96, Math.min(0, (revealed ? -88 : 0) + dx))
      setOffset(next)
    }
  }, [swipeable, revealed, clearTimer])

  const finish = useCallback(() => {
    clearTimer()
    const wasLongPress = fired.current
    const wasMove = moved.current
    const horizontal = axis.current === 'horizontal'

    start.current = null
    axis.current = 'none'
    fired.current = false
    moved.current = false

    if (horizontal && swipeable) {
      const open = offset <= -REVEAL_THRESHOLD
      setRevealed(open)
      setOffset(open ? -88 : 0)
      return
    }

    // A scroll is not a tap, and a completed hold has already acted.
    if (wasLongPress || wasMove) return

    // Tapping an open row closes it rather than triggering the row action.
    if (revealed) {
      close()
      return
    }
    onTap?.()
  }, [clearTimer, swipeable, offset, revealed, close, onTap])

  const onPointerCancel = useCallback(() => {
    clearTimer()
    start.current = null
    axis.current = 'none'
    fired.current = false
    moved.current = false
    setOffset(revealed ? -88 : 0)
  }, [clearTimer, revealed])

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel,
    },
    offset,
    revealed,
    close,
  }
}
