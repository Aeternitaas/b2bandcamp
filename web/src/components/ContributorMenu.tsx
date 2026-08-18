import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Avatar } from './Avatar'
import type { Collaborator } from '../types'

interface Props {
  name: string
  avatarUrl: string
  userId: number | null
  /** True when this contributor is the only one currently shown. */
  isolated: boolean
  onIsolate: () => void
  onClearFilter: () => void
  /**
   * Who this track can be reassigned to. Omitted (rather than empty) when
   * reassigning isn't allowed here at all, the contributor-filter strip at
   * the top of the playlist reuses this menu for a whole contributor, not one
   * track, so it never passes this.
   */
  reassignable?: Collaborator[]
  onChangeOwner?: (collaborator: Collaborator) => void
}

/**
 * The contributor avatar on a track row, with a menu for acting on that person.
 *
 * Opens on hover for pointer users and on click/tap for everyone, hover alone
 * would leave the menu unreachable on a phone, which is the primary target here.
 */
export function ContributorMenu({
  name, avatarUrl, userId, isolated, onIsolate, onClearFilter, reassignable, onChangeOwner,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const [pickingOwner, setPickingOwner] = useState(false)

  const label = name || 'Anonymous'
  const anonymous = !name

  useEffect(() => {
    // Close when focus or a click lands outside this menu.
    const onDocPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        ref.current.removeAttribute('data-open')
        setPickingOwner(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        ref.current?.removeAttribute('data-open')
        setPickingOwner(false)
      }
    }

    document.addEventListener('pointerdown', onDocPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const toggle = () => {
    const el = ref.current
    if (!el) return
    if (el.hasAttribute('data-open')) {
      el.removeAttribute('data-open')
      setPickingOwner(false)
    } else {
      el.setAttribute('data-open', '')
    }
  }

  const close = () => {
    ref.current?.removeAttribute('data-open')
    setPickingOwner(false)
  }

  return (
    <div className="contributor-menu" ref={ref}>
      <button
        className="contributor-trigger"
        onClick={(e) => { e.stopPropagation(); toggle() }}
        aria-haspopup="menu"
        aria-label={`Added by ${label}, show options`}
        title={`Added by ${label}`}
      >
        <Avatar name={name} avatarUrl={avatarUrl} userId={userId} size={24} />
      </button>

      <div className="contributor-popover" role="menu">
        <div className="row" style={{ gap: 8, padding: '2px 4px 6px' }}>
          <Avatar name={name} avatarUrl={avatarUrl} userId={userId} size={28} />
          <span className="truncate small">{label}</span>
        </div>

        {pickingOwner ? (
          <>
            {reassignable?.map((c) => (
              <button
                key={c.user_id}
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); onChangeOwner?.(c); close() }}
              >
                <Avatar name={c.username} avatarUrl={c.avatar_url} userId={c.user_id} size={20} />
                <span className="truncate">{c.username}</span>
              </button>
            ))}
            <button role="menuitem" onClick={(e) => { e.stopPropagation(); setPickingOwner(false) }}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {isolated ? (
              <button role="menuitem" onClick={(e) => { e.stopPropagation(); onClearFilter(); close() }}>
                Show all contributors
              </button>
            ) : (
              <button role="menuitem" onClick={(e) => { e.stopPropagation(); onIsolate(); close() }}>
                Show only their tracks
              </button>
            )}

            {anonymous ? (
              <span className="faint small" style={{ padding: '4px' }}>
                Added through a public link, so there is no profile to open.
              </span>
            ) : (
              <button
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); close(); navigate(`/u/${encodeURIComponent(name)}`) }}
              >
                View profile
              </button>
            )}

            {reassignable && reassignable.length > 0 && (
              <button
                role="menuitem"
                className="danger"
                onClick={(e) => { e.stopPropagation(); setPickingOwner(true) }}
              >
                Change track owner
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
