import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { Player } from './components/Player'
import { Icon } from './components/Icon'
import { SettingsPage } from './pages/SettingsPage'
import { AuthPage } from './pages/AuthPage'
import { PlaylistPage } from './pages/PlaylistPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { ProfilePage } from './pages/ProfilePage'
import { SharePage } from './pages/SharePage'
import { useAuth } from './state/auth'

function Header() {
  const { user, logout } = useAuth()
  return (
    <header className="header">
      <Link to="/" className="brand">b2<span>bandcamp</span></Link>
      <div className="spacer" />
      {user ? (
        <>
          <Link to="/" className="ghost icon" style={{ display: 'inline-flex', alignItems: 'center' }}>
            Playlists
          </Link>
          <div>|</div>
          <Link to="/settings" className="ghost icon" style={{ display: 'inline-flex', alignItems: 'center' }}>
            Settings
          </Link>
          <div>|</div>
          <button className="ghost icon" onClick={() => void logout()}>Sign out</button>
        </>
      ) : (
        <Link to="/" className="small">Sign in</Link>
      )}
    </header>
  )
}

function Footer() {
  return (
    <footer className="footer">
      Built with   <Icon name="heart" size={12} className="footer-heart" label="love" />   by Sola Lang
    </footer>
  )
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
          {/* Not wrapped in Protected: public playlists are viewable by anyone,
              and the API decides what an anonymous caller may see. */}
          <Route path="/p/:id" element={<PlaylistPage />} />
          <Route path="/s/:token" element={<SharePage />} />
          <Route path="/u/:username" element={<ProfilePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Footer />
      </main>
      <Player />
    </div>
  )
}
