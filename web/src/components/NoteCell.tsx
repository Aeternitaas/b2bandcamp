import { useEffect, useRef, useState } from 'react'

interface Props {
  note: string
  editable: boolean
  onSave: (note: string) => Promise<void>
}

/**
 * A free-text note on a playlist entry — "great intro", "needs a re-edit",
 * or whatever else is worth remembering about that particular row.
 */
export function NoteCell({ note, editable, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const begin = () => {
    if (!editable) return
    setDraft(note)
    setEditing(true)
  }

  const commit = async () => {
    setEditing(false)
    const trimmed = draft.trim().slice(0, 280)
    if (trimmed === note) return

    setBusy(true)
    try {
      await onSave(trimmed)
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <span className="note-edit" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="note-input"
          value={draft}
          maxLength={280}
          placeholder="Add a note…"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          aria-label="Note"
        />
      </span>
    )
  }

  return (
    <button
      className={`note-cell${note ? '' : ' empty'}`}
      onClick={(e) => { e.stopPropagation(); begin() }}
      disabled={!editable || busy}
      title={note || (editable ? 'Click to add a note' : undefined)}
    >
      {busy ? <div className="spin" /> : (note ? <span className="truncate">{note}</span> : '—')}
    </button>
  )
}
