import { useState } from 'react'
import { Icon } from './Icon'
import type { Playlist } from '../types'

interface Props {
  /** The user's other editable playlists — excludes whichever one is open. */
  playlists: Playlist[]
  disabled?: boolean
  label: string
  onAdd: (playlistId: number) => Promise<void>
}

/**
 * A second add button next to the wishlist's usual "+": that one always
 * targets whichever playlist is open, this one lets you send the same item
 * to a different one without first navigating there and repeating the
 * search.
 */
export function AddToPlaylistButton({ playlists, disabled, label, onAdd }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [done, setDone] = useState<Set<number>>(new Set())

  if (playlists.length === 0) return null

  const pick = async (playlistId: number) => {
    setBusy(playlistId)
    try {
      await onAdd(playlistId)
      setDone((prev) => new Set(prev).add(playlistId))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="dropdown">
      <button
        className="icon"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Add ${label} to another playlist`}
        title="Add to another playlist"
      >
        <Icon name="list" size={14} />
      </button>

      {open && (
        <>
          <div className="dropdown-scrim" onClick={() => setOpen(false)} role="presentation" />
          <div className="dropdown-menu align-end" role="menu">
            {playlists.map((p) => {
              const isDone = done.has(p.id)
              return (
                <button
                  key={p.id}
                  role="menuitem"
                  disabled={busy !== null || isDone}
                  onClick={() => void pick(p.id)}
                >
                  {busy === p.id
                    ? <div className="spin" />
                    : <Icon name={isDone ? 'check' : 'plus'} size={13} />}
                  <span className="truncate">{p.title}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
