import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { debounce } from '../utils'
import type { AccountSummary, Collaborator } from '../types'

interface Props {
  playlistId: number
  collaborators: Collaborator[]
  onChange: (list: Collaborator[]) => void
}

/**
 * Grants named accounts access to a playlist. This is the deliberate
 * alternative to handing out a link: the owner picks exactly who gets in, and
 * can revoke any one of them individually.
 */
export function InviteCollaborators({ playlistId, collaborators, onChange }: Props) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<AccountSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  // Suggestions match usernames only. An email typed here still works on
  // submit, but is never echoed back as a suggestion, so this field cannot be
  // used to discover which addresses have accounts.
  const lookup = useMemo(() => debounce((q: string) => {
    if (q.trim().length < 2 || q.includes('@')) {
      setSuggestions([])
      return
    }
    api.searchUsers(q)
      .then((res) => setSuggestions(res.users))
      .catch(() => setSuggestions([]))
  }, 220), [])

  useEffect(() => { lookup(query) }, [query, lookup])

  const invite = useCallback(async (login: string) => {
    const value = login.trim()
    if (!value) return

    setBusy(true)
    setError('')
    setStatus('')
    try {
      const res = await api.addCollaborator(playlistId, value)
      onChange(res.collaborators)
      setQuery('')
      setSuggestions([])
      setStatus(`${value} can now edit this playlist.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [playlistId, onChange])

  const remove = useCallback(async (userId: number, username: string) => {
    setError('')
    try {
      await api.removeCollaborator(playlistId, userId)
      onChange(collaborators.filter((c) => c.user_id !== userId))
      setStatus(`${username} no longer has access.`)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [playlistId, collaborators, onChange])

  const alreadyInvited = new Set(collaborators.map((c) => c.username.toLowerCase()))

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="field">
        <label htmlFor="invite">Invite by username or email</label>
        <div className="row">
          <input
            id="invite"
            value={query}
            placeholder="username or name@example.com"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void invite(query) } }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <button className="primary" onClick={() => invite(query)} disabled={busy || !query.trim()}>
            {busy ? <div className="spin" /> : null} Invite
          </button>
        </div>
        <span className="faint small">
          They must already have a b2bandcamp account. Invited people can edit the playlist and
          will see it in their own list.
        </span>
      </div>

      {suggestions.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          {suggestions.map((u) => (
            <button
              key={u.id}
              className="ghost"
              style={{ justifyContent: 'flex-start' }}
              disabled={alreadyInvited.has(u.username.toLowerCase())}
              onClick={() => invite(u.username)}
            >
              {u.username}
              {alreadyInvited.has(u.username.toLowerCase()) && (
                <span className="faint small">, already invited</span>
              )}
            </button>
          ))}
        </div>
      )}

      {error && <div className="notice error">{error}</div>}
      {status && <div className="notice ok">{status}</div>}

      {collaborators.length > 0 ? (
        <div className="col" style={{ gap: 6 }}>
          <h3>Has access</h3>
          {collaborators.map((c) => (
            <div className="row" key={c.user_id}>
              <span className="truncate">{c.username}</span>
              <div className="spacer" />
              <button
                className="ghost icon danger"
                onClick={() => remove(c.user_id, c.username)}
                aria-label={`Remove ${c.username}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <span className="faint small">Nobody else has been invited yet.</span>
      )}
    </div>
  )
}
