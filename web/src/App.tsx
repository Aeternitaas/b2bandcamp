import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Player } from './components/Player'
import { AuthPage } from './pages/AuthPage'
import { PlaylistPage } from './pages/PlaylistPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { SharePage } from './pages/SharePage'
import { useAuth } from './state/auth'

function Header() {
  const { user, logout } = useAuth()
  return (
    <header className="header">
      <Link to="/" className="brand">b2b<span>/</span>helper</Link>
      <div className="spacer" />
      {user ? (
        <>
          <span className="dim small truncate" style={{ maxWidth: 140 }}>{user.username}</span>
          <button className="ghost icon" onClick={() => void logout()}>Sign out</button>
        </>
      ) : (
        <Link to="/" className="small">Sign in</Link>
      )}
    </header>
  )
}

/** Routes that need an account; share links deliberately do not. */
function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return <div className="row"><div className="spin" /> <span className="dim">Loading…</span></div>
  }
  if (!user) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}

function Home() {
  const { user, loading } = useAuth()
  if (loading) {
    return <div className="row"><div className="spin" /> <span className="dim">Loading…</span></div>
  }
  return user ? <PlaylistsPage /> : <AuthPage />
}

export default function App() {
  return (
    <div className="app">
      <Header />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/p/:id" element={<Protected><PlaylistPage /></Protected>} />
          <Route path="/s/:token" element={<SharePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Player />
    </div>
  )
}
