# b2bandcamp API

This is the HTTP API behind the b2bandcamp web app, and the same one the
Chrome extension (`extension/`) talks to. Nothing here is extension-only —
every endpoint the web app calls is documented here too, so this file is the
one reference for anyone building a client against a b2bandcamp instance.

## Conventions

- **Base URL.** Every path below is relative to your instance's origin, e.g.
  `https://b2b.example.com`. There is no version prefix; this is a single,
  evolving API tied to one deployment, not a published package with a
  compatibility contract across versions.
- **Format.** Request and response bodies are JSON
  (`Content-Type: application/json`) except where noted (the audio and
  redirect endpoints under `/api/bc/`). Empty responses use `204` or a small
  `{"ok": true}` body depending on the endpoint — see each entry.
- **Errors.** A non-2xx response is always `{"error": "human-readable message"}`.
  The message is safe to show to a user as-is; it never contains internal
  detail (database errors, stack traces, etc. are logged server-side and
  collapsed to a generic "internal error").
- **IDs.** All numeric IDs (`id`, `playlist_id`, `user_id`, `bc_track_id`, ...)
  are 64-bit and JSON-encoded as plain numbers.

## Authentication

Two independent ways to authenticate a request. An endpoint that requires
sign-in accepts either one — nothing in this API is cookie-only or
token-only by design.

| Method | Carried in | Who uses it | Lifetime |
|---|---|---|---|
| Session cookie | `Cookie` header, set by the browser | The web app | Expires (`SESSION_TTL_DAYS`, default 30) |
| Bearer token | `Authorization: Bearer <token>` header | Everything else — the Chrome extension, scripts, other integrations | Until revoked |

### Session cookie

Browser-only. `POST /api/auth/login` or `POST /api/auth/register` sets an
`HttpOnly` cookie; the browser attaches it automatically after that. State-
changing requests (anything but `GET`/`HEAD`/`OPTIONS`) also need a
`X-CSRF-Token` header matching the `b2bandcamp_csrf` cookie the server sets on
first contact — the standard double-submit pattern, and the reason a plain
`curl` with just the session cookie gets `403 invalid csrf token` on a `POST`.
This exists to stop a *different* website from riding a signed-in browser's
cookie to make a request the user never intended — it has nothing to do with
you as an API caller, so it does not apply to bearer tokens at all (see next
section for why).

### Bearer token — for scripts, the extension, anything that is not a browser tab

```
POST /api/auth/tokens
Content-Type: application/json

{ "login": "yourname", "password": "your-password", "label": "My script" }
```

```json
201 Created
{ "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "id": 4, "label": "My script" }
```

`login` is your username or email. `label` is optional (defaults to "API
token") and is only there to help you tell tokens apart later — pick
something that says what's holding it ("Chrome extension", "laptop", "backup
script").

**The `token` value is shown exactly once, in this response.** There is no
"reveal token" later — store it somewhere your client controls (the
extension keeps it in `chrome.storage.local`) and if you lose it, revoke it
and issue a new one.

This call needs no `X-CSRF-Token` and no prior cookie from this instance at
all — it is the very first request a fresh client ever makes here, so there
is nothing to have echoed back yet. It is gated on the password in the body
instead, which serves the same purpose: a third-party page cannot forge this
request either way, since it does not know your password.

Every subsequent request authenticates with:

```
Authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

A bearer-authenticated request **does not need `X-CSRF-Token`** and is never
rejected for lacking one. This is deliberate, not an oversight: the CSRF
check exists to catch a browser *automatically* attaching a cookie to a
request the page's own script never meant to send. A bearer token is the
opposite of automatic — nothing attaches it for you, so a request carrying
one only exists because the code that holds the token decided to send it.
There is nothing for a forged cross-site request to ride along on.

This endpoint shares the login form's rate limit (10 attempts per 15 minutes
per IP), since it verifies a password the same way.

#### Managing tokens

```
GET /api/account/tokens
```
Requires sign-in (either method). Lists your own tokens — never the raw
value, only what you'd need to recognize and revoke one:
```json
{ "tokens": [
  { "id": 4, "label": "Chrome extension", "created_at": "2026-08-18T10:00:00Z", "last_used_at": "2026-08-18T14:22:09Z" }
] }
```
`last_used_at` is `null` until the token is used at least once.

```
DELETE /api/account/tokens/{id}
```
Revokes one of *your own* tokens immediately (the `id` from the list above,
not the raw token value). `404` if it does not exist or is not yours.

The web app also has a **Settings → API tokens** panel that lists and
revokes tokens with the same data — useful if you lose the extension's
storage and just want to invalidate whatever it was holding.

## Playlists

```
GET /api/playlists
```
Every playlist you own or collaborate on.
```json
{ "playlists": [ {
  "id": 12, "owner_id": 3, "owner_name": "sola", "title": "Late shift",
  "description": "", "cover_url": "", "cover_art_id": null,
  "visibility": "private", "has_share_link": false, "sort_index": 0,
  "track_count": 41, "duration_seconds": 9840,
  "created_at": "...", "updated_at": "...", "role": "owner"
} ] }
```
`role` is `owner` or `collaborator` — the extension filters on this to decide
what shows up in its playlist picker.

```
POST /api/playlists
{ "title": "New playlist", "description": "" }
```
Creates and returns a playlist (`description` optional). `title` falls back
to "Untitled playlist" if blank.

```
GET /api/playlists/{id}
```
The playlist plus its full track list (`tracks: Track[]`, see below).
Visibility rules decide whether you need to be signed in at all — a `public`
playlist is readable by anyone; a `private` one needs to be the owner or a
collaborator; a `shared` one additionally needs the share token (see
Sharing) unless you already are one.

```
PATCH /api/playlists/{id}
{ "title": "...", "description": "...", "cover_url": "...", "visibility": "shared" }
```
All fields optional; only `visibility` requires being the *owner*
specifically (a collaborator can rename it, but not change who can see it).

```
DELETE /api/playlists/{id}
```
Owner only.

```
POST /api/playlists/reorder
{ "ids": [12, 4, 9] }
```
Reorders your own playlist list (not a specific playlist's tracks — see
below for that).

## Tracks

A `Track` (one row in a playlist):
```json
{
  "id": 501, "playlist_id": 12, "position": 3,
  "bc_track_id": 2281976120, "bc_album_id": 23244101, "bc_band_id": 3439762373,
  "title": "Jazz Carnival", "artist": "Azymuth", "album_title": "AZ Selects",
  "duration": 673.9, "bpm": null, "key_override": "", "note": "",
  "detected_bpm": 122.4, "key_camelot": "8A", "key_name": "A minor",
  "art_id": 3883465068, "track_url": "https://azymuth.bandcamp.com/track/...",
  "added_by": 3, "added_at": "...", "added_by_name": "sola", "added_by_avatar": ""
}
```
`bpm`/`key_override`/`note` are hand-entered and always take priority over
`detected_bpm`/`key_camelot` when both are present; `added_by` is `null` for
a track added through an anonymous public-playlist link.

```
POST /api/playlists/{id}/tracks
```
Adds one or more items. **Either** shape works, and this is the endpoint the
extension's "Add to playlist" button calls — passing whatever Bandcamp page
the user was looking at needs no separate resolve step first:

```json
{ "url": "https://artist.bandcamp.com/album/some-album" }
```
```json
{ "items": [ { "type": "a", "id": 23244101, "band_id": 3439762373 } ] }
```
`type` is `"a"` (album — every streamable track on it is added) or `"t"`
(a single track). `url` and `items` can be combined in one call; a pasted
URL is resolved and appended to whatever `items` also contains. Non-
streamable tracks (no preview available) are silently skipped, not an
error. Response: `{ "added": 12, "tracks": [...] }` — the *full* updated
track list, in order.

```
POST /api/playlists/{id}/tracks/reorder
{ "ids": [501, 499, 503] }
```
Rewrites every position from this ordered list of track-row IDs (not
Bandcamp IDs). There is no "insert at position N" endpoint — to land a new
track at a specific spot rather than the end, add it first (which appends),
then reorder using the full desired order. This is exactly what the web
app's drag-and-drop does.

```
POST /api/playlists/{id}/tracks/delete
{ "ids": [501, 499] }
```
Removes several rows at once. `{ "removed": 2, "tracks": [...] }`.

```
DELETE /api/playlists/{id}/tracks/{trackId}
```
Removes one row.

```
PATCH /api/playlists/{id}/tracks/{trackId}
{ "bpm": 128, "key_override": "8A", "note": "great intro", "added_by": 7 }
```
Every field is optional and independent — send only what you're changing.
`null` clears an override back to the detected value (or, for `added_by`,
back to anonymous); an absent field is left untouched entirely (this is why
it's field-by-field rather than one struct: updating the tempo must not
accidentally wipe the key). `added_by` must be the playlist's owner or an
existing collaborator — reassigning credit to an unrelated account is
rejected with `400`.

### Live updates

```
GET /api/playlists/{id}/events
```
Server-Sent Events. Requires the *session cookie* specifically — an
`Authorization` header cannot be attached to a live `EventSource` connection
from a browser, so this one endpoint is cookie-only regardless of what else
in this API accepts a bearer token. Emits `data: changed\n\n` whenever
anything about this playlist's tracks changes (add, remove, reorder, or a
field edit) — the payload is deliberately empty; a client that wants to know
what changed just re-fetches `GET /api/playlists/{id}`. A `: ping` comment
line arrives every 25 seconds to keep the connection alive through a
reverse proxy's idle timeout.

## Collaborators & sharing

```
GET /api/playlists/{id}/collaborators
POST /api/playlists/{id}/collaborators        { "username": "someone" }
DELETE /api/playlists/{id}/collaborators/{userId}
```
List, invite by username/email, and remove. Inviting someone promotes a
`private` playlist to `shared` (otherwise they'd have no way to reach it).
Owner only for add/remove.

```
GET /api/playlists/{id}/share      -> the existing link, if any
POST /api/playlists/{id}/share     -> mint a new one, replacing any existing
DELETE /api/playlists/{id}/share   -> revoke it
GET /api/share/{token}             -> resolve a link (no auth required)
GET /api/account/shares            -> every link you own, across all playlists
```
A share link's effect depends on the playlist's `visibility`: on `shared`,
opening it while signed in makes you a collaborator; on `public`, it grants
editing to anyone holding it, signed in or not.

## Users

```
GET /api/users/search?q=partial-name          (signed in; playlist-invite autocomplete)
GET /api/users/{username}/profile             (public: username, join date, their public playlists)
```

## Bandcamp catalog proxy

Everything under `/api/bc/` proxies Bandcamp's own APIs, cached briefly
server-side. Rate-limited at 240 requests/minute per caller IP across all of
`/api/bc/*`. None require sign-in — they don't touch your playlists, only
Bandcamp's public catalog.

```
GET /api/bc/search?q=text&type=a|t|b|f     (albums, tracks, artists, fans; type optional = all)
POST /api/bc/resolve      { "url": "https://artist.bandcamp.com/album/x" }
GET /api/bc/details?type=a&id=...&band_id=...
```
`resolve` and `details` return the same shape — full release detail
including every track:
```json
{
  "id": 23244101, "type": "a", "title": "AZ Selects", "artist": "Azymuth",
  "band_id": 3439762373, "art_id": 3883465068, "art_url": "https://...",
  "url": "https://azymuth.bandcamp.com/album/az-selects",
  "release_date": "2020-11-08", "genres": ["Funk", "Jazz"],
  "tracks": [ {
    "track_id": 2281976120, "track_num": 2, "title": "Jazz Carnival",
    "artist": "Azymuth", "album_title": "AZ Selects", "album_id": 23244101,
    "band_id": 3439762373, "art_id": 3883465068, "duration": 673.9,
    "track_url": "https://...", "streamable": true
  } ]
}
```
`resolve` takes any Bandcamp album/track URL and figures out the type and
IDs itself — this is what the extension calls with `location.href` on an
album or track page, and with a discovered link's `href` anywhere else, so
it never needs to know Bandcamp's own internal ID scheme. `genres` is at
most 3 tags that match one of Bandcamp's own established genres (their
`/discover` taxonomy) — an album tagged "shoegaze, Montreal, indie" for
instance only surfaces as `["Alternative"]` here, since the other two are a
style and a location, not a genre Bandcamp itself recognizes.

```
GET /api/bc/fan?username=someone
GET /api/bc/wishlist?fan_id=...&token=...&count=40
```
A Bandcamp fan's identity (`fan_id`, `username`, display name, avatar) and
one page of their wishlist. `token` is the pagination cursor from the
previous page's response (`last_token`); omit it for the first page.

```
GET /api/bc/stream/{trackId}?band_id=...     -> 302 to a signed Bandcamp CDN URL
GET /api/bc/audio/{trackId}?band_id=...      -> the audio bytes, relayed
```
`stream` is what an `<audio>` element's `src` should point at — it redirects
straight to Bandcamp's CDN so the bytes never pass through this server.
`audio` exists only because Web Audio's `AnalyserNode` cannot read a
cross-origin stream with no CORS headers (which is what Bandcamp's CDN
sends) — it relays the same bytes same-origin, at real bandwidth cost, so
only use it if you're actually analyzing the waveform.

## Cached audio analysis

Detected tempo and key are cached once per Bandcamp track (not per playlist
row) and shared across every playlist that track appears in.

```
GET /api/analysis/version           -> { "analyzer_version": 3 }
GET /api/analysis/{trackId}         -> 404 if never analyzed
PUT /api/analysis/{trackId}         (signed in)
{ "bpm": 122.4, "bpm_confidence": 0.8, "key_name": "A minor", "key_camelot": "8A",
  "key_tonic": 9, "key_scale": "minor", "key_confidence": 0.7, "peaks": "<base64>" }
```
Client-side code (the web app's in-browser detector) computes these and
writes them back so nobody else has to re-download and re-analyze the same
track. There's no reason an external integration would call `PUT` here
unless it's running the same detection — reading via `GET` is the
interesting half for anything else.

## Health

```
GET /api/health   -> { "status": "ok" }
```
No auth. What a container's `HEALTHCHECK` and an uptime monitor should hit.

## A minimal client, end to end

```bash
# 1. Sign in once, keep the token.
TOKEN=$(curl -s https://b2b.example.com/api/auth/tokens \
  -H 'Content-Type: application/json' \
  -d '{"login":"me","password":"...","label":"curl example"}' | jq -r .token)

# 2. See what's yours.
curl -s https://b2b.example.com/api/playlists \
  -H "Authorization: Bearer $TOKEN"

# 3. Add an album by link to playlist 12.
curl -s https://b2b.example.com/api/playlists/12/tracks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://artist.bandcamp.com/album/some-album"}'
```

No `X-CSRF-Token`, no cookie jar — the bearer token is the entire credential,
which is exactly what makes it the right fit for something that isn't a
browser tab.
