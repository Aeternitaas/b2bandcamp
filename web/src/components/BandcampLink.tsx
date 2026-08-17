import { useState } from 'react'
import { api } from '../api'
import { Avatar } from './Avatar'
import type { Fan, User } from '../types'
import { Icon } from './Icon'

interface Props {
  user: User
  onChange: () => Promise<void>
}

/**
 * Links a Bandcamp profile to the account and optionally adopts its picture.
 *
 * The link is a self-declared association, not a verified one — it grants no
 * access to anything, it just puts a recognisable face on the tracks you add.
 */
export function BandcampLink({ user, onChange }: Props) {
  const [username, setUsername] = useState(user.bandcamp_username ?? '')
  const [found, setFound] = useState<Fan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  const link = async (useAvatar: boolean) => {
    const name = username.trim()
    if (!name) return

    setBusy(true)
    setError('')
    setStatus('')
    try {
      const res = await api.linkBandcamp(name, useAvatar)
      setFound(res.bandcamp)
      await onChange()
      setStatus(useAvatar ? 'Linked, and your picture was updated.' : `Linked to ${res.bandcamp.username}.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const unlink = async () => {
    setBusy(true)
    setError('')
    try {
      await api.unlinkBandcamp()
      setFound(null)
      setUsername('')
      await onChange()
      setStatus('Bandcamp account unlinked.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const clearAvatar = async () => {
    setBusy(true)
    try {
      await api.setAvatar('')
      await onChange()
      setStatus('Picture removed — your initials will be shown instead.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const linked = !!user.bandcamp_username
  const candidate = found ?? null

  return (
    <div className="card col">
      <h3>Bandcamp account</h3>

      {linked ? (
        <div className="row">
          <Avatar name={user.username} avatarUrl={user.avatar_url} userId={user.id} size={40} />
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="truncate">{user.bandcamp_username}</span>
            <a
              href={`https://bandcamp.com/${encodeURIComponent(user.bandcamp_username!)}`}
              target="_blank"
              rel="noreferrer noopener"
              className="small"
            >
              View on Bandcamp <Icon name="external-link" size={12} />
            </a>
          </div>
          <div className="spacer" />
          <button className="ghost danger" onClick={unlink} disabled={busy}>Unlink</button>
        </div>
      ) : (
        <span className="faint small">
          Link your Bandcamp profile so your contributions are recognisable. This is just a label —
          it gives b2bandcamp no access to your Bandcamp account.
        </span>
      )}

      <div className="field">
        <label htmlFor="bc-username">{linked ? 'Change linked profile' : 'Bandcamp username'}</label>
        <div className="row">
          <input
            id="bc-username"
            value={username}
            placeholder="username or profile link"
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void link(false) } }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button onClick={() => link(false)} disabled={busy || !username.trim()}>
            {busy ? <div className="spin" /> : null} Link
          </button>
        </div>
      </div>

      {/* Adopting the picture is offered as a separate, explicit step. */}
      {(candidate?.image_url || (linked && !user.avatar_url)) && (
        <div className="row">
          {candidate?.image_url && <Avatar name={username} avatarUrl={candidate.image_url} size={40} />}
          <span className="small dim" style={{ flex: 1 }}>
            {candidate?.image_url
              ? 'Use this Bandcamp picture as your b2bandcamp profile picture?'
              : 'That profile has no picture, so your initials will be shown.'}
          </span>
          {candidate?.image_url && (
            <button className="primary" onClick={() => link(true)} disabled={busy}>
              Use it
            </button>
          )}
        </div>
      )}

      {user.avatar_url && (
        <button className="ghost" onClick={clearAvatar} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          Remove picture
        </button>
      )}

      {error && <div className="notice error">{error}</div>}
      {status && <div className="notice ok">{status}</div>}
    </div>
  )
}
