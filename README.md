# b2b/helper

Self-hosted Bandcamp playlists. Collect tracks from across Bandcamp into your
own playlists, reorder them, and share them with a link that lets other people
edit alongside you.

Playlists are entirely local to this app — it does not use, read, or write
Bandcamp's own playlist features.

- **Frontend:** React + TypeScript (Vite), installable PWA, mobile-first, monospaced UI
- **Backend:** Go, standard library HTTP, MySQL
- **Runs on:** `http://localhost:9185` via Docker Compose

---

## Quick start

```bash
cp .env.example .env
$EDITOR .env          # set MYSQL_ROOT_PASSWORD and MYSQL_PASSWORD

docker compose up -d --build
```

Open <http://localhost:9185> and create an account. The database schema is
created automatically on first boot.

To close the instance to new sign-ups once your accounts exist, set
`ALLOW_REGISTRATION=false` in `.env` and run `docker compose up -d`.

---

## Features

**Playlists**
- Create, rename, describe, and delete playlists
- Set cover art by URL, or fall back to the first track's album art
- Drag to reorder playlists; sort by name, recent activity, or track count
- Drag to reorder tracks (works with touch, mouse, and keyboard)

**Adding music**
- Paste any Bandcamp album or track link
- Search Bandcamp by album, track, or artist
- Add a whole album with one button, or pick individual songs off it

**Wishlist sidebar**
- Point a playlist at any Bandcamp user, then browse their wishlist in a
  toggleable side panel
- Add a wishlisted album whole, or open it and add individual tracks
- Pages through wishlists of any size

**Sharing**

| Visibility | Who can view | Who can edit |
|---|---|---|
| `private` | Owner only | Owner only — the share link stops working |
| `shared` | Anyone with the link | Owner + signed-in visitors who open the link |
| `public` | Anyone with the link | Anyone with the link, no account needed |

Under `shared`, opening the link while signed in enrols you as a named
collaborator, so the owner can see who has access and revoke individuals.
Under `public`, edits are anonymous.

**Playback**
- Streams Bandcamp's public 128kbps previews, the same audio the Bandcamp
  website plays to logged-out visitors
- Lock-screen and notification controls via the Media Session API

---

## Security

Passwords are hashed with **Argon2id** (64 MiB, 3 iterations, parallelism 2)
using a per-password random salt, stored in PHC string format so the cost
parameters can be raised later without invalidating existing hashes. Login
compares in constant time and spends equivalent CPU on unknown usernames, so
response timing does not reveal which accounts exist.

Session tokens are 256 bits of CSPRNG output. Only their SHA-256 is stored, so
a database leak does not yield usable sessions. They are delivered in a cookie
that is `HttpOnly` (unreachable from JavaScript), `SameSite=Lax`, and `Secure`
when `COOKIE_SECURE=true`. Expired sessions are purged hourly.

Share tokens are generated and stored the same way — hashed, never in plaintext.
This means a share link is shown **exactly once**, at creation; it cannot be
recovered afterwards, only regenerated (which invalidates the previous link).

Other measures:

- **CSRF** — double-submit cookie; every state-changing request must echo the
  token in an `X-CSRF-Token` header. This matters because public playlists
  accept edits without a session.
- **SQL injection** — every query uses bound parameters. Reorder operations are
  additionally scoped by owner/playlist so a crafted id list cannot touch other
  users' rows.
- **SSRF** — the URL resolver only accepts `bandcamp.com` and `*.bandcamp.com`
  hosts, so it cannot be pointed at internal addresses.
- **Enumeration** — unauthorised requests for a playlist return `404`, not `403`.
- **Rate limiting** — on sign-in, sign-up, and outbound Bandcamp calls.
- **Headers** — CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- **Cover art URLs** are restricted to `https://` so a playlist cannot smuggle
  `javascript:` or `data:` URLs into another viewer's browser.

If you expose this beyond localhost, put it behind a TLS-terminating reverse
proxy and set `COOKIE_SECURE=true`.

---

## How the Bandcamp integration works

Bandcamp has no public playlist API, so this app uses the same unauthenticated
endpoints that back Bandcamp's own web and mobile clients. All were verified
against live responses while building this:

| Purpose | Endpoint |
|---|---|
| Search | `POST /api/bcsearch_public_api/1/autocomplete_elastic` |
| URL → ids | the page's `bc-page-properties` meta tag |
| Album/track detail | `GET /api/mobile/24/tralbum_details` |
| Wishlist | `POST /api/fancollection/1/wishlist_items` |
| Fan lookup | the profile page's `pagedata` blob |

Two consequences worth knowing:

**Stream URLs are never stored.** Bandcamp signs each preview URL with an
expiring timestamp and token. Playlists therefore store Bandcamp *track ids*,
and `/api/bc/stream/{trackId}` resolves a fresh signed URL at play time and
redirects the browser to it. Audio bytes go straight from Bandcamp's CDN to the
listener and never transit this server.

**Album pages no longer inline track data.** The `data-tralbum` blob that older
scrapers rely on is gone from Bandcamp's HTML; only identifiers remain in the
page head. This app reads just those identifiers and gets everything else from
the mobile API, which is both lighter and more stable.

Metadata is cached in memory — 5 minutes for release detail (short, because it
carries signed stream URLs), 30 minutes for URL→id mappings.

**Known limitation:** artists using a custom domain instead of a
`*.bandcamp.com` address are rejected by the URL resolver, deliberately, since
accepting arbitrary hosts would make that endpoint an SSRF primitive. Use the
artist's `*.bandcamp.com` URL, or find the release through search.

This app only ever touches public preview streams. It does not access purchased
media, downloads, or anything requiring a Bandcamp login. Please buy the music
you like from the artists.

---

## Development

The two halves build and run independently.

**Backend** (needs Go 1.23+ and a MySQL you can reach):

```bash
cd server
export MYSQL_PASSWORD=... MYSQL_HOST=127.0.0.1
go run .
```

**Frontend** (needs Node 20+):

```bash
cd web
npm install
npm run dev        # http://localhost:5173, proxies /api to :9185
```

Vite proxies `/api` to the Go server in development. In production the Go
server serves the built `web/dist` as static files with SPA fallback, so
client-side routes such as `/p/12` and `/s/<token>` survive a page reload.

```
server/
  main.go                     entrypoint, static file serving, graceful shutdown
  internal/config/            environment configuration
  internal/auth/              argon2id hashing, token generation and hashing
  internal/store/             MySQL schema, migrations, queries
  internal/bandcamp/          Bandcamp client + TTL cache
  internal/api/               routing, middleware, access control, handlers
web/
  src/state/                  auth and player contexts
  src/components/             player, sortable list, sidebar, modals
  src/pages/                  auth, playlist list, playlist detail, share view
  public/                     manifest, service worker, icons
```

### API

All endpoints are under `/api`. Mutations require `X-CSRF-Token`; share-link
access is granted with `X-Share-Token`.

```
POST   /api/auth/register        POST   /api/auth/login
POST   /api/auth/logout          GET    /api/auth/me

GET    /api/playlists            POST   /api/playlists
POST   /api/playlists/reorder
GET    /api/playlists/{id}       PATCH  /api/playlists/{id}
DELETE /api/playlists/{id}

POST   /api/playlists/{id}/tracks
POST   /api/playlists/{id}/tracks/reorder
DELETE /api/playlists/{id}/tracks/{trackId}

POST   /api/playlists/{id}/share      DELETE /api/playlists/{id}/share
GET    /api/share/{token}
GET    /api/playlists/{id}/collaborators
DELETE /api/playlists/{id}/collaborators/{userId}

GET    /api/bc/search?q=&type=        POST   /api/bc/resolve
GET    /api/bc/details?type=&id=&band_id=
GET    /api/bc/fan?username=          GET    /api/bc/wishlist?fan_id=&token=
GET    /api/bc/stream/{trackId}?band_id=
```

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9185` | Listen port |
| `WEB_DIR` | `./web` | Directory of built frontend files |
| `MYSQL_DSN` | — | Full DSN; overrides the parts below |
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | Database address |
| `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` | `b2b_helper` / `b2b` / — | Credentials |
| `SESSION_TTL_DAYS` | `30` | Session lifetime |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close sign-ups |
