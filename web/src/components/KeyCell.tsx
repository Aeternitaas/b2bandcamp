import { useEffect, useRef, useState } from 'react'
import { isCamelot, keyNameFromCamelot } from '../audio/analysis'

interface Props {
  /** Camelot code in force: a hand-entered override, else what analysis found. */
  camelot: string
  keyName: string
  /** True when the value came from the user rather than the detector. */
  overridden?: boolean
  editable: boolean
  onSave: (camelot: string) => Promise<void>
}

/**
 * Musical key as `CAMELOT (Key)`, e.g. `8A (Am)`.
 *
 * Camelot leads because harmonic mixing is done on it — adjacent numbers are
 * compatible keys — with the conventional name in brackets. Detection is a
 * heuristic, so like tempo the value is always hand-correctable; anything that
 * is not a real wheel position is rejected rather than stored.
 */
export function KeyCell({ camelot, keyName, overridden, editable, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const begin = () => {
    if (!editable) return
    setDraft(camelot)
    setInvalid(false)
    setEditing(true)
  }

  const commit = async () => {
    const value = draft.trim().toUpperCase()

    if (value !== '' && !isCamelot(value)) {
      setInvalid(true)
      return // keep the editor open so the entry can be corrected
    }
    setEditing(false)
    if (value === camelot) return

    setBusy(true)
    try {
      await onSave(value)
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`key-input${invalid ? ' invalid' : ''}`}
        value={draft}
        placeholder="8A"
        maxLength={3}
        onChange={(e) => { setDraft(e.target.value); setInvalid(false) }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        onClick={(e) => e.stopPropagation()}
        aria-label="Musical key as a Camelot code"
        aria-invalid={invalid}
        title={invalid ? 'Enter a Camelot code such as 8A or 12B' : undefined}
      />
    )
  }

  const name = keyName || keyNameFromCamelot(camelot)

  return (
    <button
      className={`key-cell${camelot ? '' : ' empty'}${overridden ? ' overridden' : ''}`}
      onClick={(e) => { e.stopPropagation(); begin() }}
      disabled={!editable || busy}
      title={overridden ? `Manually set — ${name || camelot}` : name || undefined}
    >
      {busy ? <div className="spin" /> : camelot ? (
        <>
          <span className="key-camelot">{camelot}</span>
          {name && <span className="key-name">({shortKey(name)})</span>}
        </>
      ) : '\u2014'}
    </button>
  )
}

/** "A# minor" -> "Bbm", "C major" -> "C" — the notation DJs actually write. */
function shortKey(name: string): string {
  const [tonic, scale] = name.split(' ')
  if (!tonic) return name
  const asFlat: Record<string, string> = {
    'A#': 'Bb', 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab',
  }
  const root = scale === 'minor' ? (asFlat[tonic] ?? tonic) : tonic
  return scale === 'minor' ? `${root}m` : root
}
