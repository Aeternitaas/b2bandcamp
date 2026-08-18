import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Icon } from './Icon'
import { copyText } from '../utils'
import type { ShareLink } from '../types'

/**
 * Every live invite link the user owns, in one place.
 *
 * Links are otherwise only visible inside the playlist that issued them, which
 * makes it easy to lose track of who still has access to what.
 */
export function ShareLinks() {
  const [shares, setShares] = useState<ShareLink[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [revoking, setRevoking] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.listShares()
      .then((res) => { setShares(res.shares); setError('') })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  const revoke = useCallback(async (playlistId: number) => {
    setRevoking(playlistId)
    setError('')
    setStatus('')
    try {
      await api.revokeShareLink(playlistId)
      setShares((prev) => prev.filter((s) => s.playlist_id !== playlistId))
      setConfirming(null)
      setStatus('Link revoked, anyone holding it has lost access.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRevoking(null)
    }
  }, [])

  const copy = useCallback(async (token: string) => {
    const ok = await copyText(`${window.location.origin}/s/${token}`)
    setStatus(ok ? 'Link copied.' : 'Copy failed, select the link and copy it manually.')
  }, [])

  return (
    <div className="card col">
      <div className="row">
        <h3 style={{ flex: 1 }}>Active share links</h3>
        {shares.length > 0 && <span className="faint small">{shares.length}</span>}
      </div>

      {loading && <div className="row"><div className="spin" /> <span className="dim small">Loading…</span></div>}
      {error && <div className="notice error">{error}</div>}
      {status && <div className="notice ok">{status}</div>}

      {!loading && shares.length === 0 && !error && (
        <span className="faint small">
          No playlists are shared by link right now. Create one from a playlist's settings.
        </span>
      )}

      {shares.length > 0 && (
        // Fixed height with its own scrollbar: this list grows with every
        // playlist shared, and it should not push the rest of the page down.
        <div className="share-list">
          {shares.map((share) => (
            <div className="share-row" key={share.playlist_id}>
              <Link to={`/p/${share.playlist_id}`} className="share-title truncate" title={share.title}>
                {share.title}
              </Link>

              <div className="row small" style={{ gap: 6 }}>
                <span className={`badge ${share.visibility}`}>{share.visibility}</span>
                <span className="faint">
                  {share.track_count} track{share.track_count === 1 ? '' : 's'}
                  {share.collaborators > 0 && ` · ${share.collaborators} collaborator${share.collaborators === 1 ? '' : 's'}`}
                </span>
              </div>

              <code className="share-token" title={`${window.location.origin}/s/${share.token}`}>
                /s/{share.token}
              </code>

              <div className="row" style={{ gap: 4 }}>
                <button className="ghost icon" onClick={() => copy(share.token)} aria-label={`Copy link for ${share.title}`}>
                  <Icon name="link" size={13} /> Copy
                </button>

                {confirming === share.playlist_id ? (
                  <>
                    <button
                      className="danger icon"
                      disabled={revoking !== null}
                      onClick={() => revoke(share.playlist_id)}
                    >
                      {revoking === share.playlist_id ? <div className="spin" /> : null} Confirm
                    </button>
                    <button className="ghost icon" onClick={() => setConfirming(null)}>Cancel</button>
                  </>
                ) : (
                  <button
                    className="ghost icon danger"
                    onClick={() => setConfirming(share.playlist_id)}
                    aria-label={`Revoke link for ${share.title}`}
                  >
                    <Icon name="trash" size={13} /> Revoke
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <span className="faint small">
        Revoking a link takes effect immediately. Collaborators already added by name keep their
        access, remove them from the playlist's settings.
      </span>
    </div>
  )
}
