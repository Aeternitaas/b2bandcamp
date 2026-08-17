import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { moveItem } from '../utils'

export type ColumnKey = 'bpm' | 'key' | 'duration' | 'contributor'

export interface ColumnConfig {
  key: ColumnKey
  visible: boolean
  width: number
}

export const COLUMN_LABELS: Record<ColumnKey, string> = {
  bpm: 'BPM',
  key: 'Key',
  duration: 'Time',
  contributor: 'Added by',
}

/** Columns whose heading can be clicked to sort. */
export const SORTABLE: ColumnKey[] = ['bpm', 'key']

/**
 * Sortable fields. `position` is the track number, which is not a configurable
 * column but is still the most natural thing to sort back to.
 */
export type SortKey = ColumnKey | 'position'
export type SortDirection = 'asc' | 'desc'
export interface SortState { key: SortKey; direction: SortDirection }

export const SORT_LABELS: Record<SortKey, string> = {
  position: '#',
  bpm: 'BPM',
  key: 'Key',
  duration: 'Time',
  contributor: 'Added by',
}

/** Everything the user can sort by, in the order the controls present them. */
export const SORT_KEYS: SortKey[] = ['position', 'bpm', 'key']

const MIN_WIDTH = 44
const MAX_WIDTH = 220
// Versioned: widths are saved per browser, so a stored layout would otherwise
// pin existing users to an old default forever. Bump this whenever a default
// width changes, or the change will not reach anyone who has used the app.
const STORAGE_KEY = 'b2bandcamp:columns:v3'

// BPM sits to the left of the time, which is the order these are read in when
// beat-matching.
const DEFAULT_COLUMNS: ColumnConfig[] = [
  { key: 'bpm', visible: true, width: 62 },
  { key: 'key', visible: true, width: 62 },
  { key: 'duration', visible: true, width: 56 },
  { key: 'contributor', visible: true, width: 44 },
]

function load(): ColumnConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_COLUMNS
    const parsed = JSON.parse(raw) as ColumnConfig[]

    // Merge rather than trust: a stored layout from an older build may be
    // missing a column that has since been added.
    const merged = DEFAULT_COLUMNS.map((d) => {
      const found = parsed.find((c) => c.key === d.key)
      return found
        ? { key: d.key, visible: !!found.visible, width: clamp(found.width ?? d.width) }
        : d
    })
    const order = parsed.map((c) => c.key).filter((k) => merged.some((m) => m.key === k))
    merged.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    return merged
  } catch {
    return DEFAULT_COLUMNS
  }
}

function clamp(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}

/** Column layout state, persisted so it survives reloads. */
export function useTrackColumns() {
  const [columns, setColumns] = useState<ColumnConfig[]>(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(columns))
    } catch {
      // Private-mode storage failures are not worth surfacing.
    }
  }, [columns])

  const visible = useMemo(() => columns.filter((c) => c.visible), [columns])

  const toggle = useCallback((key: ColumnKey) => {
    setColumns((prev) => prev.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))
  }, [])

  const resize = useCallback((key: ColumnKey, width: number) => {
    setColumns((prev) => prev.map((c) => (c.key === key ? { ...c, width: clamp(width) } : c)))
  }, [])

  const reorder = useCallback((from: number, to: number) => {
    setColumns((prev) => moveItem(prev, from, to))
  }, [])

  const reset = useCallback(() => setColumns(DEFAULT_COLUMNS), [])

  return { columns, visible, toggle, resize, reorder, reset }
}

/**
 * Builds the grid template shared by the header and every track row. Each row
 * is its own grid, so an identical template is what keeps the columns lined up.
 */
export function trackGridTemplate(
  visible: ColumnConfig[],
  opts: { select?: boolean; handle: boolean; actions: number },
): string {
  const parts: string[] = []
  if (opts.select) parts.push('26px')
  if (opts.handle) parts.push('26px')
  parts.push('30px', '36px', 'minmax(0, 1fr)')
  for (const c of visible) parts.push(`${c.width}px`)
  for (let i = 0; i < opts.actions; i++) parts.push('32px')
  return parts.join(' ')
}

interface HeaderProps {
  columns: ColumnConfig[]
  visible: ColumnConfig[]
  template: string
  showHandle: boolean
  actions: number
  onResize: (key: ColumnKey, width: number) => void
  onReorder: (from: number, to: number) => void
  /** Select-all control, shown only to editors. */
  select?: { checked: boolean; onChange: () => void }
  sort?: SortState | null
  onSort?: (key: SortKey) => void
}

/**
 * Column header: drag a label to reorder, drag its right edge to resize.
 * Rendered only when at least one configurable column is on.
 */
export function TrackColumnHeader({
  visible, template, showHandle, actions, onResize, onReorder, select, sort, onSort,
}: HeaderProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number>(-1)

  const startResize = (key: ColumnKey, startX: number, startWidth: number, target: HTMLElement) => {
    target.setPointerCapture?.(0)

    const onMove = (e: PointerEvent) => {
      e.preventDefault()
      onResize(key, startWidth + (e.clientX - startX))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startDrag = (index: number, e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(index)
    let current = index

    const onMove = (ev: PointerEvent) => {
      const row = rowRef.current
      if (!row) return
      const cells = Array.from(row.querySelectorAll('[data-col]')) as HTMLElement[]

      for (let i = 0; i < cells.length; i++) {
        const rect = cells[i].getBoundingClientRect()
        if (ev.clientX < rect.left + rect.width / 2) {
          if (i !== current) {
            onReorder(current, i)
            current = i
            setDragging(i)
          }
          return
        }
      }
      if (current !== cells.length - 1) {
        onReorder(current, cells.length - 1)
        current = cells.length - 1
        setDragging(current)
      }
    }
    const onUp = () => {
      setDragging(-1)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  if (visible.length === 0 && !select) return null

  return (
    <div className="track-head" ref={rowRef} style={{ gridTemplateColumns: template }}>
      {select && (
        <label className="track-select">
          <input
            type="checkbox"
            checked={select.checked}
            onChange={select.onChange}
            aria-label="Select all tracks"
          />
        </label>
      )}
      {showHandle && <span />}

      {/* The track-number column has no configurable entry, but sorting back to
          playlist order is the most common thing to want. */}
      <span className="track-head-cell">
        <button
          className="track-head-label sortable"
          onClick={() => onSort?.('position')}
          title="Track number — click to sort"
        >
          #
          {sort?.key === 'position' && (
            <Icon
              name="chevron-down"
              size={11}
              className={sort.direction === 'asc' ? 'flip-v' : undefined}
            />
          )}
        </button>
      </span>

      <span />
      <span className="faint">Title</span>

      {visible.map((col, i) => (
        <span
          key={col.key}
          data-col={col.key}
          className={`track-head-cell${dragging === i ? ' dragging' : ''}`}
        >
          <button
            className={`track-head-label${SORTABLE.includes(col.key) ? ' sortable' : ''}`}
            onPointerDown={(e) => startDrag(i, e)}
            onClick={() => { if (SORTABLE.includes(col.key)) onSort?.(col.key) }}
            title={SORTABLE.includes(col.key)
              ? `${COLUMN_LABELS[col.key]} — click to sort, drag to move`
              : `${COLUMN_LABELS[col.key]} — drag to move`}
          >
            {COLUMN_LABELS[col.key]}
            {sort?.key === col.key && (
              <Icon
                name="chevron-down"
                size={11}
                className={sort.direction === 'asc' ? 'flip-v' : undefined}
              />
            )}
          </button>
          <span
            className="col-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${COLUMN_LABELS[col.key]} column`}
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              startResize(col.key, e.clientX, col.width, e.currentTarget as HTMLElement)
            }}
          />
        </span>
      ))}

      {Array.from({ length: actions }, (_, i) => <span key={`a${i}`} />)}
    </div>
  )
}

interface PanelProps {
  columns: ColumnConfig[]
  onToggle: (key: ColumnKey) => void
  onReorder: (from: number, to: number) => void
  onReset: () => void
  sort?: SortState | null
  onSort?: (key: SortKey) => void
}

/** Visibility and ordering controls, including a pointer-free way to reorder. */
export function TrackColumnPanel({
  columns, onToggle, onReorder, onReset, sort, onSort,
}: PanelProps) {
  return (
    <div className="card col" style={{ gap: 8 }}>
      {onSort && (
        <>
          <h3>Sort by</h3>
          <div className="row wrap" style={{ gap: 6 }}>
            {SORT_KEYS.map((key) => (
              <button
                key={key}
                className={sort?.key === key ? 'icon' : 'ghost icon'}
                onClick={() => onSort(key)}
                aria-pressed={sort?.key === key}
              >
                {SORT_LABELS[key]}
                {sort?.key === key && (
                  <Icon
                    name="chevron-down"
                    size={11}
                    className={sort.direction === 'asc' ? 'flip-v' : undefined}
                  />
                )}
              </button>
            ))}
            {sort && (
              <button className="ghost icon" onClick={() => onSort(sort.key)}>
                Clear
              </button>
            )}
          </div>
        </>
      )}

      <div className="row">
        <h3 style={{ flex: 1 }}>Columns</h3>
        <button className="ghost icon" onClick={onReset}>Reset</button>
      </div>

      <div className="col" style={{ gap: 4 }}>
        {columns.map((c, i) => (
          <div className="row" key={c.key} style={{ gap: 8 }}>
            <label className="row" style={{ gap: 8, flex: 1, cursor: 'pointer', minHeight: 36 }}>
              <input
                type="checkbox"
                checked={c.visible}
                onChange={() => onToggle(c.key)}
                style={{ width: 'auto' }}
              />
              <span>{COLUMN_LABELS[c.key]}</span>
            </label>

            <button
              className="ghost icon"
              disabled={i === 0}
              onClick={() => onReorder(i, i - 1)}
              aria-label={`Move ${COLUMN_LABELS[c.key]} left`}
              title="Move left"
            >
              <Icon name="arrow-left" size={13} />
            </button>
            <button
              className="ghost icon"
              disabled={i === columns.length - 1}
              onClick={() => onReorder(i, i + 1)}
              aria-label={`Move ${COLUMN_LABELS[c.key]} right`}
              title="Move right"
            >
              <Icon name="arrow-left" size={13} className="flip" />
            </button>
          </div>
        ))}
      </div>

      <span className="faint small">
        Drag a column heading to move it, or its right edge to resize. Hidden columns keep
        their width for when you turn them back on.
      </span>
    </div>
  )
}
