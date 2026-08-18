# b2bandcamp

Self-hosted Bandcamp playlists. Collect tracks from across Bandcamp into your
own playlists, reorder them, and share them with a link that lets other people
edit alongside you.

<img width="1065" height="476" alt="image" src="https://github.com/user-attachments/assets/2c2e6e88-32b1-444e-b824-cc730c977858" />

Playlists are entirely local to this app and it does not use, read, or write
Bandcamp's own playlist features.

- **Frontend:** React + TypeScript (Vite), installable PWA, mobile-first, monospaced UI
- **Backend:** Go, standard library HTTP, MySQL
- **Runs on:** `http://localhost:9185` via Docker Compose

---

## Quick start

```bash
cp .env.example .env
cp docker-compose-prod.yml docker-compose.yml
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
- Configurable track columns: tempo, length and contributor can be shown,
  hidden, reordered (drag the heading) and resized (drag its right edge); the
  layout is remembered per browser
- Tempo is editable inline, because detection gets tracks wrong
- Filter by contributor, with original track numbering preserved
- Set cover art by URL, or fall back to the first track's album art
- Drag to reorder playlists; sort by name, recent activity, or track count
- Drag to reorder tracks (works with touch, mouse, and keyboard)

**Adding music**
- Paste any Bandcamp album or track link
- Search Bandcamp by album, track, or artist
- Add a whole album with one button, or pick individual songs off it
- Wishlist albums offer both explicitly rather than guessing which you meant

**Wishlist sidebar**
- Enter any Bandcamp username (or display name, or profile link) and browse
  their wishlist in a toggleable side panel.
- Add a wishlisted album whole, or open it and add individual tracks
- Pages through wishlists of any size

**Sharing**

| Visibility | Who can view | Who can edit |
|---|---|---|
| `private` | Owner + invited collaborators | Same; the share link stops working |
| `shared` | Invited collaborators, or anyone with the link | Owner + invited collaborators |
| `public` | Anyone (listed on the owner's profile) | Owner, invitees, or anyone with the link |

Collaborators can be added two ways:

- **By name**: the owner invites an existing account by username or email.
  This is the deliberate path: no link circulates, and each person can be
  revoked individually.
- **By link**: a 10-character invite link. Under `shared`, opening it while
  signed in enrols you as a named collaborator. Under `public`, it grants
  editing outright and edits may be anonymous.

Public playlists are readable without any link (that is what makes them
listable on a profile); editing them still requires the link or an invite.

**Player**
- Streams Bandcamp's public 128kbps previews, the same audio the Bandcamp
  website plays to logged-out visitors
- Volume control, and lock-screen/notification controls via the Media Session API
- Expanded now-playing view with a waveform, detected tempo (BPM) and musical
  key (with Camelot notation), a 0.5×–2× tempo slider that can preserve pitch,
  the source album, a link out to Bandcamp, and one-tap saving to another playlist

**Accounts**
- Settings page for changing email and password (both require the current
  password; changing the password signs out every other device)
- Optionally link a Bandcamp profile and adopt its picture as your avatar
- Public profile page listing your public playlists; owners can change any
  playlist's visibility from there
- Tracks are attributed to whoever added them, with their avatar (or coloured
  initials derived from their account id)
- API tokens for non-browser clients (see **Browser extension** below), listed
  and revocable from Settings

**Browser extension**

`extension/` is a Chrome extension that adds a **+ Add to playlist** control
directly on Bandcamp's own album, track, wishlist, and discover/browse pages —
add something without leaving Bandcamp or switching tabs. It links to any
b2bandcamp instance by URL and signs in with a token rather than a shared
session, so it works the same way against a self-hosted instance as this app
itself does. See `extension/README.md` to install it and `docs/API.md` for the
API it talks to (the same one the web app uses — nothing extension-only).

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

Share tokens are 10 characters drawn with rejection sampling from a 57-symbol
alphabet (~58 bits), which keeps links short enough to paste and retype while
leaving guessing infeasible against the rate limiter. Lookups match on the
SHA-256 hash. The raw token is **also** stored so an owner can retrieve their
own invite link instead of being forced to rotate it, a deliberate trade: it
means the database holds a working credential, which is an acceptable position
for a single-box self-hosted deployment but would not be for a shared host.

Other measures:

- **CSRF**: double-submit cookie; every state-changing request must echo the
  token in an `X-CSRF-Token` header. This matters because public playlists
  accept edits without a session.
- **SQL injection**: every query uses bound parameters. Reorder operations are
  additionally scoped by owner/playlist so a crafted id list cannot touch other
  users' rows.
- **SSRF**: the URL resolver only accepts `bandcamp.com` and `*.bandcamp.com`
  hosts, so it cannot be pointed at internal addresses.
- **Enumeration**: unauthorised requests for a playlist return `404`, not `403`.
- **Rate limiting**: on sign-in, sign-up, and outbound Bandcamp calls.
- **Headers**: CSP, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- **Cover art URLs** are restricted to `https://` so a playlist cannot smuggle
  `javascript:` or `data:` URLs into another viewer's browser.

If you expose this beyond localhost, put it behind a TLS-terminating reverse
proxy and set `COOKIE_SECURE=true`.

---

## Deploying behind a domain

Nothing in the app hardcodes a hostname. The UI calls `/api` with relative
paths and builds share links from the address you are browsing, so pointing a
new FQDN at it needs no code or build changes. The same image works on
`localhost`, a LAN address and `music.example.com`.

Three settings matter once a reverse proxy is in front:

| Variable | Why |
|---|---|
| `COOKIE_SECURE=true` | Session and CSRF cookies are then only sent over HTTPS |
| `TRUSTED_PROXIES=private` | Restores per-user rate limiting (see below) |
| `PUBLIC_BASE_URL` | Optional; makes copied share links always name your domain |

**`TRUSTED_PROXIES` is not optional in practice.** Behind a proxy every request
arrives from the proxy's address, so all users land in the same rate-limit
bucket and one person's failed logins lock out everybody. Setting it lets the
server read `X-Forwarded-For`, but only when the immediate peer is one of the
listed networks, because that header is trivially forged and believing it from
any client would let anyone bypass the limiters outright.

`private` covers loopback and the RFC1918 ranges, which is what a proxy on the
same host or docker network will be. Never list a public range.

A minimal nginx front end:

```nginx
server {
    listen 443 ssl;
    server_name music.example.com;

    location / {
        proxy_pass http://127.0.0.1:9185;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Two caveats:

- **Serve it at a domain root, not a subpath.** The built assets are referenced
  from `/assets/...` and the client routes are absolute, so `example.com/b2b/`
  would need a Vite `base` and a router `basename`. Say the word if you need it.
- **The audio proxy streams through the server** when the analysis panel is
  open, so give it a generous `proxy_read_timeout` if you put buffering limits
  in front of it.

---

## How the Bandcamp integration works

Bandcamp has no public playlist API, so this app uses the same unauthenticated
endpoints that back Bandcamp's own web and mobile clients. All were verified
against live responses while building this:

| Purpose | Endpoint |
|---|---|
| Search (also used to resolve fans by display name) | `POST /api/bcsearch_public_api/1/autocomplete_elastic` |
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

Metadata is cached in memory: 5 minutes for release detail (short, because it
carries signed stream URLs), 30 minutes for URL→id mappings.

**Analysis needs a proxy.** Bandcamp's CDN sends no CORS headers, so an
`<audio>` element can play a stream but Web Audio only ever sees silence from
it. `/api/bc/audio/{trackId}` therefore relays the bytes same-origin, which is
what makes the waveform, BPM and key detection possible. It is used only when
the analysis panel is open; ordinary playback still uses the redirect.

**`wishlist_count` is unreliable.** Some profile pages report `0` even when the
wishlist is populated, so the UI reports how many items it actually loaded
rather than trusting that number.

**Known limitation:** artists using a custom domain instead of a
`*.bandcamp.com` address are rejected by the URL resolver, deliberately, since
accepting arbitrary hosts would make that endpoint an SSRF primitive. Use the
artist's `*.bandcamp.com` URL, or find the release through search.

This app only ever touches public preview streams. It does not access purchased
media, downloads, or anything requiring a Bandcamp login. Please buy the music
you like from the artists.

---

### Icons

The UI contains no emoji. Emoji glyphs come from the OS font, so the same
character renders differently (or not at all) across platforms and is announced
unpredictably by screen readers. Icons are inline SVG from
[Feather](https://feathericons.com) (MIT), copied into `src/components/Icon.tsx`
rather than fetched; the CSP forbids external assets and the PWA must render
offline.

---

## Development

### Hot reload

```bash
docker compose -f docker-compose.dev.yml up
```

Open <http://localhost:5173>. Both halves reload on save: Vite serves the UI
with hot module replacement, and `air` rebuilds and restarts the Go server. The
dev stack uses its own database volume, so it will not disturb the production
one on port 9185.

Vite proxies `/api` to the Go container, so there is no CORS configuration and
no build step coupling the two. If your filesystem does not propagate inotify
events into containers, set `VITE_USE_POLLING=true`.

### Running the halves separately

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
  src/audio/                  waveform / tempo / key analysis + its worker
  src/state/                  auth and player contexts
  src/components/             player, sortable list, sidebar, modals
  src/pages/                  auth, playlist list, playlist detail, share view
  public/                     manifest, service worker, icons
```

### API

**Full reference, with request/response bodies and examples: [`docs/API.md`](docs/API.md).**
This is the same API the web app itself uses — nothing is held back for an
"internal" surface, which is what makes the browser extension (and anything
else you might build) possible without a second, parallel API.

Quick orientation — every endpoint is under `/api`. Requests authenticate with
either the browser's session cookie (plus `X-CSRF-Token` on any mutation) or
an `Authorization: Bearer <token>` header (see `POST /api/auth/tokens`);
share-link access additionally takes `X-Share-Token`.

```
POST   /api/auth/register        POST   /api/auth/login
POST   /api/auth/logout          GET    /api/auth/me
POST   /api/auth/tokens                 issue a bearer token from a login+password
PATCH  /api/account                     email / password (needs current password)
GET    /api/account/tokens       DELETE /api/account/tokens/{id}
POST   /api/account/bandcamp     DELETE /api/account/bandcamp
PUT    /api/account/avatar

GET    /api/playlists            POST   /api/playlists
POST   /api/playlists/reorder
GET    /api/playlists/{id}       PATCH  /api/playlists/{id}
DELETE /api/playlists/{id}
GET    /api/playlists/{id}/events       Server-Sent Events, live track changes

POST   /api/playlists/{id}/tracks
POST   /api/playlists/{id}/tracks/reorder
POST   /api/playlists/{id}/tracks/delete
PATCH  /api/playlists/{id}/tracks/{trackId}
DELETE /api/playlists/{id}/tracks/{trackId}

GET    /api/playlists/{id}/share      POST   /api/playlists/{id}/share
DELETE /api/playlists/{id}/share
GET    /api/share/{token}
GET    /api/playlists/{id}/collaborators
POST   /api/playlists/{id}/collaborators      invite by username or email
DELETE /api/playlists/{id}/collaborators/{userId}
GET    /api/users/search              GET    /api/users/{username}/profile

GET    /api/bc/search?q=&type=        POST   /api/bc/resolve
GET    /api/bc/details?type=&id=&band_id=
GET    /api/bc/fan?username=          GET    /api/bc/wishlist?fan_id=&token=
GET    /api/bc/stream/{trackId}?band_id=   302 redirect, used for playback
GET    /api/bc/audio/{trackId}?band_id=    same-origin relay, used for analysis

GET    /api/analysis/version          GET    /api/analysis/{trackId}
PUT    /api/analysis/{trackId}
```

### Tests

```bash
cd server
go test ./...            # includes live Bandcamp integration tests
go test ./... -short     # skips anything that touches the network
```

The Bandcamp tests deliberately hit the real API. They are the tripwire for the
thing most likely to break this app: Bandcamp changing a response shape.

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9185` | Listen port |
| `WEB_DIR` | `./web` | Directory of built frontend files |
| `MYSQL_DSN` | - | Full DSN; overrides the parts below |
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | Database address |
| `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` | `b2bandcamp` / `b2bandcamp` / - | Credentials |
| `SESSION_COOKIE` / `CSRF_COOKIE` | `b2bandcamp_session` / `b2bandcamp_csrf` | Cookie names |
| `SESSION_TTL_DAYS` | `30` | Session lifetime |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close sign-ups |
