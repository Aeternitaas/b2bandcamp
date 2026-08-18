import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Icon } from './Icon'
import type { ApiToken } from '../types'

/**
 * Every bearer token issued to a non-browser client — the Chrome extension
 * signs in this way, since it has nowhere to hold a session cookie. Tokens
 * are created by that sign-in, not from here; this is only for reviewing
 * what has access and revoking a token that is lost or no longer trusted.
 */
export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [revoking, setRevoking] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    api.listApiTokens()
      .then((res) => { setTokens(res.tokens); setError('') })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  const revoke = useCallback(async (id: number) => {
    setRevoking(id)
    setError('')
    setStatus('')
    try {
      await api.revokeApiToken(id)
      setTokens((prev) => prev.filter((t) => t.id !== id))
      setConfirming(null)
      setStatus('Token revoked — anything using it will need to sign in again.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRevoking(null)
    }
  }, [])

  return (
    <div className="card col">
      <div className="row">
        <h3 style={{ flex: 1 }}>API tokens</h3>
        {tokens.length > 0 && <span className="faint small">{tokens.length}</span>}
      </div>

      {loading && <div className="row"><div className="spin" /> <span className="dim small">Loading…</span></div>}
      {error && <div className="notice error">{error}</div>}
      {status && <div className="notice ok">{status}</div>}

      {!loading && tokens.length === 0 && !error && (
        <span className="faint small">
          No tokens yet. Sign in from the b2bandcamp browser extension to create one.
        </span>
      )}

      {tokens.length > 0 && (
        <div className="share-list">
          {tokens.map((token) => (
            <div className="share-row" key={token.id}>
              <span className="share-title truncate" title={token.label}>{token.label}</span>

              <div className="row small" style={{ gap: 6 }}>
                <span className="faint">
                  Created {new Date(token.created_at).toLocaleDateString()}
                  {token.last_used_at
                    ? ` · last used ${new Date(token.last_used_at).toLocaleDateString()}`
                    : ' · never used'}
                </span>
              </div>

              <div className="row" style={{ gap: 4 }}>
                {confirming === token.id ? (
                  <>
                    <button
                      className="danger icon"
                      disabled={revoking !== null}
                      onClick={() => revoke(token.id)}
                    >
                      {revoking === token.id ? <div className="spin" /> : null} Confirm
                    </button>
                    <button className="ghost icon" onClick={() => setConfirming(null)}>Cancel</button>
                  </>
                ) : (
                  <button
                    className="ghost icon danger"
                    onClick={() => setConfirming(token.id)}
                    aria-label={`Revoke ${token.label}`}
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
        Each token grants full access to your playlists, same as signing in — revoke one the
        moment you stop trusting whatever holds it.
      </span>
    </div>
  )
}
