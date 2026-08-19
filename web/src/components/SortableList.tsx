import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { moveItem } from '../utils'

export interface HandleProps {
  onPointerDown: (e: React.PointerEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  tabIndex: number
  role: string
  'aria-label': string
}

/** A handle that does nothing: the floating ghost shows a grip for visual
 *  continuity with the real row, but it is not itself draggable. */
const INERT_HANDLE: HandleProps = {
  onPointerDown: () => {},
  onKeyDown: () => {},
  tabIndex: -1,
  role: 'presentation',
  'aria-label': '',
}

type Key = string | number

interface Props<T> {
  items: T[]
  keyOf: (item: T) => Key
  onReorder: (items: T[]) => void
  renderItem: (item: T, ctx: {
    index: number
    /** Same as `index` while nothing is being dragged; during a drag this is
     *  where the row would land if dropped right now, so a number column can
     *  preview the reorder instead of only updating once it is committed. */
    displayIndex: number
    dragging: boolean
    handle: HandleProps
  }) => ReactNode
  disabled?: boolean
  /**
   * Keys of selected items. Dragging any one of them moves the whole selection
   * as a contiguous block, which is what "move these three together" means.
   */
  selectedKeys?: Set<Key>
  /**
   * Handles something dropped in from outside the list, a link dragged in
   * from the browser's address bar or another tab, at the position it was
   * dropped, reusing the same "which row's midpoint did this cross" logic
   * that dragging an existing row to reorder it already relies on.
   */
  onDropExternal?: (index: number, e: React.DragEvent) => void
}

interface Rect { top: number; left: number; width: number; height: number }

/**
 * A drag-to-reorder list built on Pointer Events.
 *
 * HTML5 drag-and-drop does not fire on touch screens, so it is not an option
 * for a mobile-first app. Pointer Events cover mouse, touch and stylus with one
 * code path. Dragging is restricted to an explicit handle so that a finger
 * dragging anywhere else still scrolls the page, and arrow keys on the focused
 * handle provide a non-pointer path to the same operation.
 *
 * Reordering an existing row lifts it out of the list into a floating ghost
 * that tracks the pointer 1:1 (a raw transform written straight to the DOM on
 * every move, not through React state, so it never lags a frame behind), while
 * every other row keeps its normal box in the flow and only ever gets a CSS
 * transform, never a resize, to slide out of the way by exactly one dragged
 * block's height. Nothing about the list's actual layout changes until the
 * drag commits, so there is nothing for the browser to be mid-transition on
 * when the next pointermove asks "where is everything right now" the way a
 * margin-based reflow would be.
 *
 * The move/up/cancel listeners live on `window`, not on the handle element
 * with pointer capture: capture can be released by the browser out from under
 * an element whose layout or visibility changes mid-drag (exactly what
 * dragging used to do to the handle's own row), which silently stops further
 * events from reaching it, a stuck drag that never sees its own pointerup. A
 * window listener has no element to lose track of. `blur` is cleaned up on
 * too, so alt-tabbing mid-drag cannot leave one stuck either.
 *
 * A link dropped in from outside is different: there is no existing row to
 * lift out and hide, an actual gap has to open, so that path still opens one
 * with a margin, the same technique it has always used.
 */
export function SortableList<T>({
  items, keyOf, onReorder, renderItem, disabled, selectedKeys, onDropExternal,
}: Props<T>) {
  const [order, setOrder] = useState(items)

  // Internal reorder: index of the row grabbed (into `order` at drag start),
  // and which original row's slot the pointer is currently over.
  const [dragIndex, setDragIndex] = useState(-1)
  const [hoverIndex, setHoverIndex] = useState(-1)

  // External drop: unrelated state, a link dragged in from outside has no
  // existing row to swap with, so this still opens an actual margin gap.
  const [dragOver, setDragOver] = useState(false)
  const [gapIndex, setGapIndex] = useState(-1)
  const [gapHeight, setGapHeight] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const orderRef = useRef(order)
  const dragRef = useRef(-1)
  const selectedRef = useRef(selectedKeys)
  const dragOverRef = useRef(false)
  const rowRectsRef = useRef<Rect[]>([])
  const captureScrollYRef = useRef(0)
  const ghostBoxRef = useRef<Rect>({ top: 0, left: 0, width: 0, height: 0 })
  const pointerYRef = useRef(0)
  orderRef.current = order
  dragRef.current = dragIndex
  selectedRef.current = selectedKeys

  // Adopt changes from the parent, except mid-drag where local state is the
  // source of truth for what the user is currently seeing.
  useEffect(() => {
    if (dragRef.current === -1) setOrder(items)
  }, [items])

  // Which keys are moving together: the whole selection when the dragged row
  // is part of a multi-selection, otherwise just the one row.
  const draggedKeys = useMemo(() => {
    if (dragIndex === -1) return null
    const dragged = order[dragIndex]
    if (dragged === undefined) return null
    const selection = selectedKeys
    if (selection && selection.size > 1 && selection.has(keyOf(dragged))) return selection
    return new Set([keyOf(dragged)])
  }, [dragIndex, order, selectedKeys, keyOf])

  const draggedIndices = useMemo(() => {
    if (!draggedKeys) return null
    const set = new Set<number>()
    order.forEach((item, i) => { if (draggedKeys.has(keyOf(item))) set.add(i) })
    return set
  }, [order, draggedKeys, keyOf])

  /** Every row's rect, in viewport coordinates, captured once when a drag
   *  (internal or external) starts, alongside the scroll position at that
   *  same moment (`captureScrollYRef`). Nothing about the list's real layout
   *  changes again until the drag commits, only CSS transforms (which the
   *  browser never factors into layout) and this ref is never re-measured,
   *  so a `clientY` from a later pointer event has to be adjusted by however
   *  far the page has scrolled since capture before comparing it against
   *  these rects - left unadjusted, a page scrolled mid-drag (a long
   *  playlist, dragging near an edge) would compare a post-scroll pointer
   *  position against pre-scroll rects, drifting further off the further
   *  the page has scrolled. Viewport coordinates, not document ones, because
   *  the floating ghost is `position: fixed`, itself viewport-relative, and
   *  reuses this same snapshot for its initial placement. */
  const captureRects = useCallback(() => {
    const container = containerRef.current
    captureScrollYRef.current = window.scrollY
    rowRectsRef.current = container
      ? Array.from(container.children).map((el) => (el as HTMLElement).getBoundingClientRect())
      : []
  }, [])

  /** Position among the rows not in `excludeIndices`, 0..count inclusive: how
   *  many of them a Y coordinate has passed the midpoint of, against the
   *  rects `captureRects` recorded. */
  const insertionIndexAmong = useCallback((clientY: number, excludeIndices: Set<number> | null): number => {
    const y = clientY + (window.scrollY - captureScrollYRef.current)
    const rects = rowRectsRef.current
    let count = 0
    for (let i = 0; i < rects.length; i++) {
      if (excludeIndices?.has(i)) continue
      if (y < rects[i].top + rects[i].height / 2) return count
      count++
    }
    return count
  }, [])

  /** Which original row index a Y coordinate is over, clamped to the list -
   *  used for internal reordering, where every row (including the one being
   *  dragged) keeps a real rect to compare against. */
  const rowIndexAt = useCallback((clientY: number): number => {
    const y = clientY + (window.scrollY - captureScrollYRef.current)
    const rects = rowRectsRef.current
    for (let i = 0; i < rects.length; i++) {
      if (y < rects[i].top + rects[i].height / 2) return i
    }
    return Math.max(0, rects.length - 1)
  }, [])

  /** Where the dragged block would land right now, as a position among the
   *  rows not in the block, 0..count inclusive. -1 while nothing is being
   *  dragged or the pointer has not moved yet.
   *
   *  Uses the actual last pointer Y (see `pointerYRef` in beginDrag), not a
   *  position derived from `hoverIndex`'s own row: reusing a row's own
   *  midpoint as the Y to test against that same row's midpoint is a tie,
   *  and a tie always loses to "not yet passed" - which meant the very first
   *  row could never be the one a block lands before, no matter how far
   *  above it the pointer actually was, since row 0's own midpoint was the
   *  only Y this ever tested with the pointer sitting anywhere above it. */
  const targetSlot = useMemo(() => {
    if (dragIndex === -1 || hoverIndex === -1 || !draggedIndices) return -1
    return insertionIndexAmong(pointerYRef.current, draggedIndices)
  }, [dragIndex, hoverIndex, draggedIndices, insertionIndexAmong])

  // What each row should display as its live position: plain array order
  // when nothing is being previewed, otherwise the hypothetical result of
  // dropping right now, so a number column can update as the pointer moves
  // rather than only once the drag is committed.
  const displayIndexOf = useMemo(() => {
    const map = new Map<Key, number>()
    if (targetSlot === -1 || !draggedKeys) {
      order.forEach((item, i) => map.set(keyOf(item), i))
      return map
    }
    const others = order.filter((item) => !draggedKeys.has(keyOf(item)))
    const block = order.filter((item) => draggedKeys.has(keyOf(item)))
    const next = [...others.slice(0, targetSlot), ...block, ...others.slice(targetSlot)]
    next.forEach((item, i) => map.set(keyOf(item), i))
    return map
  }, [order, targetSlot, draggedKeys, keyOf])

  // How far (if at all) each other row needs to slide, purely a CSS
  // transform, to visually swap places with the dragged block: rows between
  // where the block started and wherever the pointer is now slide back by
  // exactly the block's own height, the same distance the block itself
  // effectively moved past them.
  const rowShift = useMemo(() => {
    const map = new Map<Key, number>()
    if (targetSlot === -1 || !draggedIndices || draggedIndices.size === 0) return map

    const blockHeight = [...draggedIndices].reduce((sum, i) => sum + (rowRectsRef.current[i]?.height ?? 0), 0)
    const originalSlot = order.reduce((n, _item, i) => (i < dragIndex && !draggedIndices.has(i) ? n + 1 : n), 0)

    let slot = 0
    order.forEach((item, i) => {
      if (draggedIndices.has(i)) return
      if (originalSlot <= slot && slot < targetSlot) map.set(keyOf(item), -blockHeight)
      else if (targetSlot <= slot && slot < originalSlot) map.set(keyOf(item), blockHeight)
      slot++
    })
    return map
  }, [order, dragIndex, targetSlot, draggedIndices, keyOf])

  const beginDrag = useCallback((index: number, e: React.PointerEvent) => {
    if (disabled) return
    e.preventDefault()
    // On a phone the handle sits inside a row that has its own long-press/
    // swipe gesture tracking (see useRowGestures in TrackRow); without this
    // the same pointerdown would arm both at once, and a moment later either
    // a long-press selection or a swipe-reveal would fire mid-drag.
    e.stopPropagation()

    const startOrder = orderRef.current
    const dragged = startOrder[index]
    const selection = selectedRef.current
    const keys = selection && selection.size > 1 && selection.has(keyOf(dragged))
      ? selection
      : new Set<Key>([keyOf(dragged)])
    const indices = new Set<number>()
    startOrder.forEach((item, i) => { if (keys.has(keyOf(item))) indices.add(i) })

    captureRects()
    const rects = rowRectsRef.current
    const blockRects = [...indices].map((i) => rects[i]).filter((r): r is Rect => !!r)
    if (blockRects.length === 0) return

    ghostBoxRef.current = {
      top: Math.min(...blockRects.map((r) => r.top)),
      left: Math.min(...blockRects.map((r) => r.left)),
      width: Math.max(...blockRects.map((r) => r.left + r.width)) - Math.min(...blockRects.map((r) => r.left)),
      height: blockRects.reduce((sum, r) => sum + r.height, 0),
    }

    const startX = e.clientX
    const startY = e.clientY
    const pointerId = e.pointerId
    pointerYRef.current = startY

    setDragIndex(index)
    setHoverIndex(index)

    const hoverIndexRef = { current: index }
    let cleaned = false

    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('blur', onBlur)
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      ev.preventDefault()
      // Captured, and stopped here: without this, this same pointermove goes
      // on to bubble through whatever row it is currently over, and that
      // row's own long-press/swipe tracking (see useRowGestures) would start
      // treating it as movement of a gesture it never saw begin.
      ev.stopPropagation()
      pointerYRef.current = ev.clientY
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`
      }
      const hover = rowIndexAt(ev.clientY)
      if (hover !== hoverIndexRef.current) {
        hoverIndexRef.current = hover
        setHoverIndex(hover)
      }
    }

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      // Captured, and stopped here: the drag can end with the pointer
      // physically over a completely different row than the one grabbed
      // (that is the whole point of reordering). Left to bubble, that row's
      // own tap handler would see a pointerup it has no matching pointerdown
      // for and fire anyway, playing whatever track happens to be under the
      // cursor the instant the drag is released.
      ev.preventDefault()
      ev.stopPropagation()
      finish()
    }

    const onBlur = () => finish()

    const finish = () => {
      cleanup()

      setDragIndex(-1)
      setHoverIndex(-1)
      dragRef.current = -1

      const at = insertionIndexAmong(pointerYRef.current, indices)

      const others = startOrder.filter((item) => !keys.has(keyOf(item)))
      const block = startOrder.filter((item) => keys.has(keyOf(item)))
      const next = [...others.slice(0, at), ...block, ...others.slice(at)]

      orderRef.current = next
      setOrder(next)

      const changed = next.some((item, i) => keyOf(item) !== keyOf(items[i] ?? item))
      if (changed) onReorder(next)
    }

    // Captured (the `true`), not bubble-phase: that is what lets onMove and
    // onUp stop this pointer's events from ever reaching whatever row they
    // are currently over, rather than merely reacting after the fact.
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    // A stuck drag is worse than a cancelled one: losing window focus
    // (alt-tab, devtools, a native file picker) mid-gesture ends it instead
    // of leaving the list waiting for a pointerup that may never come.
    window.addEventListener('blur', onBlur)
  }, [disabled, captureRects, rowIndexAt, insertionIndexAmong, keyOf, items, onReorder])

  const onHandleKey = useCallback((index: number, e: React.KeyboardEvent) => {
    if (disabled) return
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (delta === 0) return

    e.preventDefault()
    const to = index + delta
    if (to < 0 || to >= orderRef.current.length) return

    const next = moveItem(orderRef.current, index, to)
    orderRef.current = next
    setOrder(next)
    onReorder(next)
  }, [disabled, onReorder])

  const clearDragPreview = useCallback(() => {
    dragOverRef.current = false
    setDragOver(false)
    setGapIndex(-1)
  }, [])

  // External drop only: which row (by key) gets the open margin, whichever
  // one currently sits at gapIndex. Past the last of them means "at the
  // end", which opens below the last row instead.
  const gapMargins = useMemo(() => {
    if (!dragOver || gapIndex === -1 || order.length === 0) {
      return { topKey: null as Key | null, bottomKey: null as Key | null }
    }
    if (gapIndex < order.length) return { topKey: keyOf(order[gapIndex]), bottomKey: null }
    return { topKey: null, bottomKey: keyOf(order[order.length - 1]) }
  }, [order, dragOver, gapIndex, keyOf])

  // Position the ghost the instant it mounts (dragIndex just became a real
  // index), before the browser paints, so it appears exactly over the row it
  // represents rather than flashing at the origin for a frame.
  useLayoutEffect(() => {
    if (dragIndex === -1 || !ghostRef.current) return
    const box = ghostBoxRef.current
    ghostRef.current.style.top = `${box.top}px`
    ghostRef.current.style.left = `${box.left}px`
    ghostRef.current.style.width = `${box.width}px`
    ghostRef.current.style.transform = 'translate(0px, 0px)'
  }, [dragIndex])

  const draggedItems = useMemo(() => {
    if (dragIndex === -1 || !draggedKeys) return []
    return order.filter((item) => draggedKeys.has(keyOf(item)))
  }, [order, dragIndex, draggedKeys, keyOf])

  return (
    <div
      ref={containerRef}
      className={`track-list${dragOver ? ' drop-target' : ''}`}
      onDragOver={onDropExternal && ((e) => {
        e.preventDefault()
        if (!dragOverRef.current) {
          dragOverRef.current = true
          setDragOver(true)
          captureRects()
          // Match the gap to a real row's height, measured once per drag so
          // it does not keep re-reading layout on every dragover.
          setGapHeight(rowRectsRef.current[0]?.height ?? 0)
        }
        setGapIndex(insertionIndexAmong(e.clientY, null))
      })}
      onDragLeave={onDropExternal && ((e) => {
        // dragleave also fires when crossing from the container onto a
        // child row, only actually leaving the whole list should clear it.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        clearDragPreview()
      })}
      onDrop={onDropExternal && ((e) => {
        e.preventDefault()
        const index = gapIndex === -1 ? insertionIndexAmong(e.clientY, null) : gapIndex
        clearDragPreview()
        onDropExternal(index, e)
      })}
    >
      {order.map((item, index) => {
        const key = keyOf(item)
        const isDragged = draggedKeys?.has(key) ?? false
        const shift = rowShift.get(key)
        return (
          <div
            key={key}
            className="track-list-item"
            style={{
              // External drop only: opens an actual gap, there being no
              // existing row's own slot to reuse for it.
              marginTop: gapMargins.topKey === key ? gapHeight : undefined,
              marginBottom: gapMargins.bottomKey === key ? gapHeight : undefined,
              // Internal reorder only: the real row is hidden in place (its
              // slot still reserves the list's own height) while the floating
              // ghost shows its content instead, and every row between the
              // drag's start and the pointer's current slot slides by exactly
              // one block-height to visually swap places with it.
              visibility: isDragged ? 'hidden' : undefined,
              transform: shift ? `translateY(${shift}px)` : undefined,
              transition: shift !== undefined || isDragged ? 'transform .18s ease' : undefined,
            }}
          >
            {renderItem(item, {
              index,
              displayIndex: displayIndexOf.get(key) ?? index,
              dragging: index === dragIndex,
              handle: {
                onPointerDown: (e) => beginDrag(index, e),
                onKeyDown: (e) => onHandleKey(index, e),
                tabIndex: disabled ? -1 : 0,
                role: 'button',
                'aria-label': 'Reorder, drag, or focus and use arrow keys',
              },
            })}
          </div>
        )
      })}

      {dragIndex !== -1 && (
        <div ref={ghostRef} className="drag-ghost">
          {draggedItems.map((item, i) => {
            const key = keyOf(item)
            return (
              <div key={key} className="track-list-item">
                {renderItem(item, {
                  index: dragIndex + i,
                  displayIndex: displayIndexOf.get(key) ?? dragIndex + i,
                  dragging: true,
                  handle: INERT_HANDLE,
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
