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
export function SortableList<T>({ items, keyOf, onReorder, renderItem, disabled }: Props<T>) {
  const [order, setOrder] = useState(items)
  const [dragIndex, setDragIndex] = useState(-1)

  const containerRef = useRef<HTMLDivElement>(null)
  const orderRef = useRef(order)
  const dragRef = useRef(-1)
  orderRef.current = order
  dragRef.current = dragIndex

  // Adopt changes from the parent, except mid-drag where local state is the
  // source of truth for what the user is currently seeing.
  useEffect(() => {
    if (dragRef.current === -1) setOrder(items)
  }, [items])

  /** Index whose midpoint the pointer has crossed. */
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
      if (to !== -1 && to !== from) {
        const next = moveItem(orderRef.current, from, to)
        orderRef.current = next
        dragRef.current = to
        setOrder(next)
        setDragIndex(to)
      }
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

  return (
    <div ref={containerRef} className="track-list">
      {order.map((item, index) => (
        <div key={keyOf(item)}>
          {renderItem(item, {
            index,
            dragging: index === dragIndex,
            handle: {
              onPointerDown: (e) => beginDrag(index, e),
              onKeyDown: (e) => onHandleKey(index, e),
              tabIndex: disabled ? -1 : 0,
              role: 'button',
              'aria-label': 'Reorder — drag, or focus and use arrow keys',
            },
          })}
        </div>
      ))}
    </div>
  )
}
