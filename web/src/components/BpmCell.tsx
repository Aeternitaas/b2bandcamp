import { useEffect, useRef, useState } from 'react'

interface Props {
  bpm: number | null
  /** True when this value is a hand-entered override rather than detected. */
  overridden?: boolean
  editable: boolean
  onSave: (bpm: number | null) => Promise<void>
}

/**
 * Tempo cell. Detection is a heuristic and gets tracks wrong — especially
 * half/double-time — so the value is always hand-correctable.
 */
export function BpmCell({ bpm, overridden, editable, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const begin = () => {
    if (!editable) return
    setDraft(bpm ? String(Math.round(bpm)) : '')
    setEditing(true)
  }

  const commit = async () => {
    setEditing(false)
    const trimmed = draft.trim()
    const value = trimmed === '' ? null : Number(trimmed)

    if (value !== null && (!Number.isFinite(value) || value <= 0 || value > 400)) return
    if (value === (bpm === null ? null : Math.round(bpm))) return

    setBusy(true)
    try {
      await onSave(value)
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <span className="bpm-edit" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="bpm-input"
          value={draft}
          inputMode="numeric"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          aria-label="Tempo in BPM"
        />
      </span>
    )
  }

  return (
    <button
      className={`bpm-cell${bpm ? '' : ' empty'}${overridden ? ' overridden' : ''}`}
      onClick={(e) => { e.stopPropagation(); begin() }}
      disabled={!editable || busy}
      title={overridden ? 'Manually set — click to edit' : editable ? 'Click to edit tempo' : undefined}
    >
      {busy ? <div className="spin" /> : bpm ? Math.round(bpm) : '—'}
    </button>
  )
}
