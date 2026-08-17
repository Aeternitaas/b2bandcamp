import { useState } from 'react'
import { useAuth } from '../state/auth'

export function AuthPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')

  const [loginName, setLoginName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'login') {
        await login(loginName, password)
      } else {
        await register(username, email, password)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="col" style={{ gap: 18 }}>
        <div className="center">
          <div className="brand" style={{ fontSize: 24 }}>b2b<span>/</span>helper</div>
          <div className="dim small">Bandcamp playlists you actually own.</div>
        </div>

        <div className="auth-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} onClick={() => { setMode('login'); setError('') }}>
            Sign in
          </button>
          <button role="tab" aria-selected={mode === 'register'} onClick={() => { setMode('register'); setError('') }}>
            Create account
          </button>
        </div>

        <form className="card col" onSubmit={submit}>
          {mode === 'login' ? (
            <div className="field">
              <label htmlFor="login">Username or email</label>
              <input
                id="login"
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                autoComplete="username"
                autoCapitalize="off"
                required
              />
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="username">Username</label>
                <input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="off"
                  minLength={3}
                  maxLength={32}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
            </>
          )}

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 10 : undefined}
              required
            />
            {mode === 'register' && <span className="faint small">At least 10 characters.</span>}
          </div>

          {error && <div className="notice error">{error}</div>}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? <div className="spin" /> : null}
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  )
}
