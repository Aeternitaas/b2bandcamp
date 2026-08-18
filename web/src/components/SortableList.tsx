import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { moveItem } from '../utils'

export interface HandleProps {
  onPointerDown: (e: React.PointerEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  tabIndex: number
  role: string
  'aria-label': string
}

interface Props<T> {
  items: T[]
  keyOf: (item: T) => string | number
  onReorder: (items: T[]) => void
  renderItem: (item: T, ctx: { index: number; dragging: boolean; handle: HandleProps }) => ReactNode
  disabled?: boolean
  /**
   * Keys of selected items. Dragging any one of them moves the whole selection
   * as a contiguous block, which is what "move these three together" means.
   */
  selectedKeys?: Set<string | number>
  /**
   * Handles something dropped in from outside the list, a link dragged in
   * from the browser's address bar or another tab, at the position it was
   * dropped, reusing the same "which row's midpoint did this cross" logic
   * that dragging an existing row to reorder it already relies on.
   */
  onDropExternal?: (index: number, e: React.DragEvent) => void
}

/**
 * A drag-to-reorder list built on Pointer Events.
 *
 * HTML5 drag-and-drop does not fire on touch screens, so it is not an option
 * for a mobile-first app. Pointer Events cover mouse, touch and stylus with one
 * code path. Dragging is restricted to an explicit handle so that a finger
 * dragging anywhere else still scrolls the page, and arrow keys on the focused
 * handle provide a non-pointer path to the same operation.
 */
export function SortableList<T>({
  items, keyOf, onReorder, renderItem, disabled, selectedKeys, onDropExternal,
}: Props<T>) {
  const [order, setOrder] = useState(items)
  const [dragIndex, setDragIndex] = useState(-1)
  const [externalDragOver, setExternalDragOver] = useState(false)
  // Where a link dragged in from outside would land if dropped right now,
  // 0..order.length inclusive (order.length means "after everything"), and
  // the height to open up there to preview it, measured from a real row so
  // it matches whatever size the rows actually are.
  const [externalDragIndex, setExternalDragIndex] = useState(-1)
  const [gapHeight, setGapHeight] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const orderRef = useRef(order)
  const dragRef = useRef(-1)
  const selectedRef = useRef(selectedKeys)
  const externalDragOverRef = useRef(false)
  orderRef.current = order
  dragRef.current = dragIndex
  selectedRef.current = selectedKeys

  // Adopt changes from the parent, except mid-drag where local state is the
  // source of truth for what the user is currently seeing.
  useEffect(() => {
    if (dragRef.current === -1) setOrder(items)
  }, [items])

  /** Index whose midpoint the pointer has crossed, for moving an existing
   *  row, always a valid index into `order` (never past the last one, there
   *  is nowhere for an existing row to land "after" the last position). */
  const indexAt = useCallback((clientY: number): number => {
    const container = containerRef.current
    if (!container) return -1
    const rows = Array.from(container.children) as HTMLElement[]
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return i
    }
    return rows.length - 1
  }, [])

  /** Where a link dropped in from outside should be inserted, 0..order.length
   *  inclusive. Unlike indexAt above, past the last row's midpoint has to
   *  mean "after everything" (order.length), not "before the last row", an
   *  external drop has no existing row of its own to take that row's place. */
  const insertionIndexAt = useCallback((clientY: number): number => {
    const container = containerRef.current
    if (!container) return 0
    const rows = Array.from(container.children) as HTMLElement[]
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return i
    }
    return rows.length
  }, [])

  const beginDrag = useCallback((index: number, e: React.PointerEvent) => {
    if (disabled) return
    e.preventDefault()

    const startTarget = e.currentTarget as HTMLElement
    startTarget.setPointerCapture(e.pointerId)
    setDragIndex(index)

    const onMove = (ev: PointerEvent) => {
      ev.preventDefault()
      const from = dragRef.current
      if (from === -1) return
      const to = indexAt(ev.clientY)
      if (to === -1 || to === from) return

      const current = orderRef.current
      const selection = selectedRef.current
      const dragged = current[from]
      const asBlock = !!selection && selection.size > 1 && selection.has(keyOf(dragged))

      let next: T[]
      if (asBlock) {
        const anchor = current[to]
        // Hovering over the block itself is not a move.
        if (selection!.has(keyOf(anchor))) return

        const block = current.filter((item) => selection!.has(keyOf(item)))
        const others = current.filter((item) => !selection!.has(keyOf(item)))
        const anchorAt = others.findIndex((item) => keyOf(item) === keyOf(anchor))
        const firstSelected = current.findIndex((item) => selection!.has(keyOf(item)))

        // Land after the hovered row when dragging down and before it when
        // dragging up, so dropping past the last row puts the block at the end
        // rather than one short of it.
        const at = to > firstSelected ? anchorAt + 1 : anchorAt
        next = [...others.slice(0, at), ...block, ...others.slice(at)]
      } else {
        next = moveItem(current, from, to)
      }

      orderRef.current = next
      const landed = next.findIndex((item) => keyOf(item) === keyOf(dragged))
      dragRef.current = landed
      setOrder(next)
      setDragIndex(landed)
    }

    const onUp = () => {
      startTarget.releasePointerCapture?.(e.pointerId)
      startTarget.removeEventListener('pointermove', onMove)
      startTarget.removeEventListener('pointerup', onUp)
      startTarget.removeEventListener('pointercancel', onUp)

      dragRef.current = -1
      setDragIndex(-1)

      // Only notify when the order actually changed.
      const changed = orderRef.current.some((item, i) => keyOf(item) !== keyOf(items[i] ?? item))
      if (changed) onReorder(orderRef.current)
    }

    startTarget.addEventListener('pointermove', onMove)
    startTarget.addEventListener('pointerup', onUp)
    startTarget.addEventListener('pointercancel', onUp)
  }, [disabled, indexAt, items, keyOf, onReorder])

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

  const clearExternalDrag = useCallback(() => {
    externalDragOverRef.current = false
    setExternalDragOver(false)
    setExternalDragIndex(-1)
  }, [])

  return (
    <div
      ref={containerRef}
      className={`track-list${externalDragOver ? ' drop-target' : ''}`}
      onDragOver={onDropExternal && ((e) => {
        e.preventDefault()
        if (!externalDragOverRef.current) {
          externalDragOverRef.current = true
          setExternalDragOver(true)
          // Match the gap to a real row's height, measured once per drag so
          // it does not keep re-reading layout on every dragover.
          const first = containerRef.current?.children[0] as HTMLElement | undefined
          if (first) setGapHeight(first.getBoundingClientRect().height)
        }
        setExternalDragIndex(insertionIndexAt(e.clientY))
      })}
      onDragLeave={onDropExternal && ((e) => {
        // dragleave also fires when crossing from the container onto a
        // child row, only actually leaving the whole list should clear it.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        clearExternalDrag()
      })}
      onDrop={onDropExternal && ((e) => {
        e.preventDefault()
        const index = externalDragIndex === -1 ? insertionIndexAt(e.clientY) : externalDragIndex
        clearExternalDrag()
        onDropExternal(index, e)
      })}
    >
      {order.map((item, index) => (
        <div
          key={keyOf(item)}
          className="track-list-item"
          style={{
            marginTop: externalDragIndex === index ? gapHeight : undefined,
            marginBottom: externalDragIndex === order.length && index === order.length - 1 ? gapHeight : undefined,
          }}
        >
          {renderItem(item, {
            index,
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
      ))}
    </div>
  )
}
