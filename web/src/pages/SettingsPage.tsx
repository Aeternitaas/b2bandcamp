import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../state/auth'
import { ApiTokens } from '../components/ApiTokens'
import { Avatar } from '../components/Avatar'
import { BandcampLink } from '../components/BandcampLink'
import { ShareLinks } from '../components/ShareLinks'
import { Icon } from '../components/Icon'

/** Account settings: identity, linked Bandcamp profile, email and password. */
export function SettingsPage() {
  const { user, loading, refresh } = useAuth()

  const [currentPassword, setCurrentPassword] = useState('')
  const [email, setEmail] = useState(user?.email ?? '')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  if (loading) {
    return <div className="row"><div className="spin" /> <span className="dim">Loading…</span></div>
  }
  if (!user) {
    return (
      <div className="col">
        <div className="notice info">Sign in to manage your account.</div>
        <Link to="/">Back</Link>
      </div>
    )
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setStatus('')

    if (newPassword && newPassword !== confirmPassword) {
      setError('The new passwords do not match.')
      return
    }

    setBusy(true)
    try {
      const res = await api.updateAccount({
        current_password: currentPassword,
        email: email !== user.email ? email : '',
        new_password: newPassword,
      })
      await refresh()
      setStatus(
        res.other_sessions_ended
          ? 'Saved. Your other devices have been signed out.'
          : 'Saved.',
      )
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="col" style={{ maxWidth: 460 }}>
      <Link to="/" className="small row" style={{ gap: 4, display: 'inline-flex' }}>
        <Icon name="arrow-left" size={13} /> Back
      </Link>
      <h1>Settings</h1>

      <div className="card col" style={{ gap: 10 }}>
        <div className="row">
          <Avatar
            name={user.username}
            avatarUrl={user.avatar_url}
            userId={user.id}
            size={48}
            title={user.username}
          />
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="truncate">{user.username}</span>
            <span className="faint small">Usernames cannot be changed.</span>
          </div>
        </div>
        <Link to={`/u/${encodeURIComponent(user.username)}`} className="small">
          View your public profile
        </Link>
      </div>

      <BandcampLink user={user} onChange={refresh} />

      <ShareLinks />

      <ApiTokens />

      <form className="card col" onSubmit={submit}>
        <div className="field">
          <label htmlFor="acc-email">Email</label>
          <input
            id="acc-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>

        <div className="field">
          <label htmlFor="acc-new">New password</label>
          <input
            id="acc-new"
            type="password"
            value={newPassword}
            placeholder="leave blank to keep your current password"
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={10}
          />
        </div>

        {newPassword && (
          <div className="field">
            <label htmlFor="acc-confirm">Confirm new password</label>
            <input
              id="acc-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        )}

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '4px 0' }} />

        <div className="field">
          <label htmlFor="acc-current">Current password</label>
          <input
            id="acc-current"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          <span className="faint small">Required to confirm any change.</span>
        </div>

        {error && <div className="notice error">{error}</div>}
        {status && <div className="notice ok">{status}</div>}

        <button className="primary" type="submit" disabled={busy || !currentPassword}>
          {busy ? <div className="spin" /> : null} Save changes
        </button>
      </form>
    </div>
  )
}
