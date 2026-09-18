# b2bandcamp API

This is the HTTP API behind the b2bandcamp web app. The Chrome extension
(`extension/`) uses the same one. No endpoint here belongs to the extension
alone, and this file covers every endpoint the web app calls. It is therefore
the one reference for anyone who builds a client against a b2bandcamp
instance.

## Conventions

- **Base URL.** Every path below is relative to your instance's origin, for
  example `https://b2b.example.com`. There is no version prefix. This is one
  API that evolves with one deployment. It is not a published package with a
  compatibility contract across versions.
- **Format.** Request and response bodies are JSON
  (`Content-Type: application/json`) except where noted (the audio and
  redirect endpoints under `/api/bc/`). Empty responses use `204` or a small
  `{"ok": true}` body depending on the endpoint, see each entry.
- **Errors.** A non-2xx response always has the form
  `{"error": "human-readable message"}`. You can show the message to a user
  unchanged. It never carries internal detail. The server logs database errors
  and stack traces, then collapses them to a generic "internal error".
- **IDs.** All numeric IDs (`id`, `playlist_id`, `user_id`, `bc_track_id`, ...)
  are 64-bit and JSON-encoded as plain numbers.

## Authentication

A request can authenticate in two independent ways. An endpoint that requires
sign-in accepts either one. By design, no endpoint in this API takes only a
cookie or only a token.

| Method | Carried in | Who uses it | Lifetime |
|---|---|---|---|
| Session cookie | `Cookie` header, set by the browser | The web app | Expires (`SESSION_TTL_DAYS`, default 30) |
| Bearer token | `Authorization: Bearer <token>` header | Everything else, the Chrome extension, scripts, other integrations | Until revoked |

### Session cookie

This method is for browsers only. `POST /api/auth/login` or
`POST /api/auth/register` sets an `HttpOnly` cookie. The browser then attaches
that cookie to each later request on its own. State-
changing requests (anything but `GET`/`HEAD`/`OPTIONS`) also need a
`X-CSRF-Token` header matching the `b2bandcamp_csrf` cookie the server sets on
first contact, the standard double-submit pattern, and the reason a plain
`curl` with just the session cookie gets `403 invalid csrf token` on a `POST`.
This exists to stop a *different* website from riding a signed-in browser's
cookie to make a request the user never intended, it has nothing to do with
you as an API caller, so it does not apply to bearer tokens at all (see next
section for why).

### Bearer token, for scripts, the extension, anything that is not a browser tab

```
POST /api/auth/tokens
Content-Type: application/json

{ "login": "yourname", "password": "your-password", "label": "My script" }
```

```json
201 Created
{ "token": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "id": 4, "label": "My script" }
```

- `login` is your username or email.
- `label` is optional (defaults to "API
token") and is only there to help you tell tokens apart later, pick
something that says what's holding it ("Chrome extension", "laptop", "backup
script").
- The server returns the `token` value exactly once. There is no "reveal token"
call later. Store it somewhere your client controls. The extension keeps it in
`chrome.storage.local`. If you lose it, revoke it and issue a new one.

This call needs no `X-CSRF-Token`, and no earlier cookie from this instance. It
is the first request a fresh client ever makes here, so no cookie exists to echo
back yet. The password in the body guards it instead, and that serves the same
purpose. A third-party page cannot forge this request either way, because it
does not know your password.

Every subsequent request authenticates with:

```
Authorization: Bearer xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

A bearer-authenticated request **does not need `X-CSRF-Token`** and is never
rejected for lacking one. This is deliberate, not an oversight: the CSRF
check exists to catch a browser *automatically* attaching a cookie to a
request the page's own script never meant to send. A bearer token is the
opposite of automatic, nothing attaches it for you, so a request carrying
one only exists because the code that holds the token decided to send it.
There is nothing for a forged cross-site request to ride along on.

This endpoint shares the login form's rate limit (10 attempts per 15 minutes
per IP), since it verifies a password the same way.

#### Managing tokens

```
GET /api/account/tokens
```

Requires sign-in (either method). Lists your own tokens, never the raw
value, only what you'd need to recognize and revoke one:

```json
{ "tokens": [
  { "id": 4, "label": "Chrome extension", "created_at": "2026-08-18T10:00:00Z", "last_used_at": "2026-08-18T14:22:09Z" }
] }
```
`last_used_at` stays `null` until a client uses the token at least once.

```
DELETE /api/account/tokens/{id}
```
Revokes one of *your own* tokens immediately (the `id` from the list above,
not the raw token value). `404` if it does not exist or is not yours.

The web app also has a **Settings → API tokens** panel that lists and
revokes tokens with the same data, useful if you lose the extension's
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
`role` is `owner` or `collaborator`, the extension filters on this to decide
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
Visibility rules decide whether you need to be signed in at all, a `public`
anyone can read a `public` playlist. A `private` one needs the owner or a
collaborator. A `shared` one also needs the share token (see
Sharing) unless you already are one.

```
PATCH /api/playlists/{id}
{ "title": "...", "description": "...", "cover_url": "...", "visibility": "shared" }
```
Every field is optional. Only `visibility` requires the *owner*
specifically (a collaborator can rename it, but not change who can see it).

```
DELETE /api/playlists/{id}
```
Owner only.

```
POST /api/playlists/reorder
{ "ids": [12, 4, 9] }
```
Reorders your own playlist list (not a specific playlist's tracks, see
below for that).

## Tracks

A `Track` (one row in a playlist):
```json
{
  "id": 501, "playlist_id": 12, "position": 3,
  "source": "bandcamp", "source_id": "2281976120", "source_ref": "3439762373",
  "bc_track_id": 2281976120, "bc_album_id": 23244101, "bc_band_id": 3439762373,
  "title": "Jazz Carnival", "artist": "Azymuth", "album_title": "AZ Selects",
  "duration": 673.9, "bpm": null, "key_override": "", "note": "",
  "detected_bpm": 122.4, "key_camelot": "8A", "key_name": "A minor",
  "art_id": 3883465068, "art_url": "https://f4.bcbits.com/img/a3883465068_9.jpg",
  "track_url": "https://azymuth.bandcamp.com/track/...",
  "added_by": 3, "added_at": "...", "added_by_name": "sola", "added_by_avatar": ""
}
```
`source` names the integration the row came from, one of the ids listed by
`GET /api/sources`, and `source_id` is that integration's own identifier for
the track. Together they are the row's identity: they key the analysis cache
and are what a duplicate check compares. `source_ref` is an opaque handle the
integration needs to act on the track later. For Bandcamp that is the band id.
Treat it as meaningless outside that integration.

The `bc_*` fields are the older Bandcamp-only identity, kept working for
existing clients. **They are `null` on any row that did not come from
Bandcamp**, so new code should read `source`/`source_id` instead. They will be
removed in a later release.

Art follows the same pattern. `art_id` is Bandcamp's artwork id, from which a
client builds a CDN URL at whatever pixel size it needs. `art_url` holds a ready
image URL, for sources that expose no id. Each row sets exactly one of the two.
Prefer `art_url` when it holds a value. Otherwise derive the URL from
`art_id`.
The same applies to a playlist's `cover_art_id` / `cover_art_url`, which both
describe the first track that has any art.

For a YouTube row, the server derives `artist` and `title` instead of copying
them. YouTube supplies a channel name and a video title, and neither is the
field an export needs. The server reads an art-track channel such as
`Muadeep - Topic` as the artist `Muadeep`, which matches what YouTube Music
shows. For a normal upload it
splits a title like `Rick Astley - Never Gonna Give You Up (Official Video)`
into the artist `Rick Astley` and the title `Never Gonna Give You Up`.

Promotional decoration goes: `(Official Video)`, `[Lyrics]`, `(4K Remaster)`, a
trailing `| Official Video` and the rest of that family. Anything a DJ needs
stays, including `(Extended Mix)`, `(Radio Edit)`, `(Someone Remix)`,
`(Live)` and `ft.` credits. `track_url` always points at the original video, so
you can check the untouched title there.

A YouTube row looks like this. Note the null `bc_*` fields, and that
`duration` is `0` when the server has no YouTube API key (see
`GET /api/sources`):
```json
{
  "id": 502, "playlist_id": 12, "position": 4,
  "source": "youtube", "source_id": "dQw4w9WgXcQ", "source_ref": "",
  "bc_track_id": null, "bc_album_id": null, "bc_band_id": null,
  "title": "Rick Astley - Never Gonna Give You Up", "artist": "Rick Astley",
  "album_title": "", "duration": 213, "bpm": null, "key_override": "", "note": "",
  "detected_bpm": null, "key_camelot": "", "key_name": "",
  "art_id": null, "art_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  "track_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "added_by": 3, "added_at": "...", "added_by_name": "sola", "added_by_avatar": ""
}
```
`bpm`/`key_override`/`note` are hand-entered and always take priority over
`detected_bpm`/`key_camelot` when both are present. `added_by` is `null` for a
track that somebody added through an anonymous public-playlist link.

```
POST /api/playlists/{id}/tracks
```
Adds one or more items. **Either** shape works, and this is the endpoint the
extension's "Add to playlist" button calls, passing whatever Bandcamp page
the user was looking at needs no separate resolve step first:

```json
{ "url": "https://artist.bandcamp.com/album/some-album" }
```
```json
{ "url": "https://youtu.be/dQw4w9WgXcQ" }
```
```json
{ "items": [ { "type": "a", "id": 23244101, "band_id": 3439762373 } ] }
```
The server offers a `url` to each registered integration in turn. The first
integration that recognises the link handles it. Any link from any source that
`GET /api/sources` lists therefore works here. When no integration recognises a
link, the server returns `400` with
`"no integration handles that link"`.

The `items` form is Bandcamp-specific and predates there being more than one
source. `type` is `"a"` for an album, which adds every streamable track on it,
or `"t"` for a single track. It still works, and the extension still sends it.
For anything else, paste the URL.

One call can carry both `url` and `items`. The server resolves the pasted URL
and appends it to whatever `items` also holds.

The server skips tracks that nobody could ever play back, and reports no error.
For Bandcamp that means a track with no preview stream. For YouTube it means a
video whose uploader blocked embedding.

The response is `{ "added": 12, "tracks": [...] }`, which carries the *full*
updated track list, in order.

Playlists can mix sources freely, which is the point: a B2B playlist can run
a Bandcamp track into a YouTube one. Expanding a **YouTube playlist** link
needs the server to have an API key, and returns `400` with an explanation
when it does not.

```
POST /api/playlists/{id}/tracks/reorder
{ "ids": [501, 499, 503] }
```
Rewrites every position from this ordered list of track-row IDs (not
Bandcamp IDs). There is no "insert at position N" endpoint, to land a new
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
Every field is optional and independent, send only what you're changing.
`null` clears an override back to the detected value (or, for `added_by`,
back to anonymous). The server leaves an absent field alone. That is why this
endpoint reads field by field instead of taking one struct: updating the tempo
must never wipe the key. `added_by` must be the playlist's owner or an
existing collaborator, reassigning credit to an unrelated account is
rejected with `400`.

### Live updates

```
GET /api/playlists/{id}/events
```
Server-Sent Events. Requires the *session cookie* specifically, an
`Authorization` header cannot be attached to a live `EventSource` connection
from a browser, so this one endpoint is cookie-only regardless of what else
in this API accepts a bearer token. Emits `data: changed\n\n` whenever
anything about this playlist's tracks changes (add, remove, reorder, or a
field edit). The payload is empty on purpose. A client that wants to know what
changed re-reads `GET /api/playlists/{id}`. A `: ping` comment
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
opening it while signed in makes you a collaborator. On `public`, it grants
editing to anyone holding it, signed in or not.

## Users

```
GET /api/users/search?q=partial-name          (signed in; playlist-invite autocomplete)
GET /api/users/{username}/profile             (public: username, join date, their public playlists)
```

## Integrations

```
GET /api/sources
```
This endpoint lists the track sources in this build, and what each one can do.
It needs no sign-in, because it describes the build and not your data.

```json
{ "sources": [
  { "id": "bandcamp", "name": "Bandcamp",
    "caps": { "stream": true, "analyze": true, "search": true, "embed": false } },
  { "id": "youtube", "name": "YouTube",
    "caps": { "stream": true, "analyze": true, "search": true, "embed": false } }
] }
```

**Read this per instance, not as a constant.** Three of YouTube's four
capabilities depend on how the server is set up, which is the reason this
endpoint exists. A `YOUTUBE_API_KEY` turns `search` on. An audio extractor
(`yt-dlp`) turns `stream` and `analyze` on together, and turns `embed` off. An
instance with neither answers
`{ "stream": false, "analyze": false, "search": false, "embed": true }`, and
still adds YouTube videos by link.

An `id` here is what appears in a track's `source` field. The capabilities
are what a client should branch on rather than hard-coding a list of sources:

- `stream` - this server can supply the audio, so playback goes through an
  `<audio>` element pointed at `/api/bc/stream/...` or `/api/yt/stream/...`.
  `stream` wins when both flags are true.
- `embed` - this server has no audio for the row, so playback uses the
  source's own player. For YouTube that is the IFrame player, mounted on
  `source_id`. See **Embedding a YouTube row** below before you build it.
- `analyze` - the browser can get the raw audio same-origin, so in-browser
  tempo, key and waveform detection can run. It is always equal to `stream`:
  both need the same samples. Manual `bpm`, `key_override` and `note` work on
  every row whatever this says.
- `search` - the source has a catalog search endpoint (`/api/bc/search` or
  `/api/yt/search`).

### Embedding a YouTube row

A client that plays a row with `embed` true must meet four conditions. A test
in a real browser, against a built server, checked each one on 2026-09-16.

1. **Load the frame from `https://www.youtube-nocookie.com/embed/`, and load
   the player script from `https://www.youtube.com/iframe_api`.** The server's
   Content-Security-Policy permits those two origins only while `embed` is
   true. An instance with an extractor removes them.
2. **Set the frame's own referrer policy before you insert it.** The page
   carries `Referrer-Policy: no-referrer`, and YouTube refuses to play in a
   frame that sends no referrer. It reports error `153`. Set
   `referrerPolicy = "strict-origin-when-cross-origin"` on the frame element.
3. **Give the player a viewport of at least 200 by 200 pixels, and put nothing
   in front of it.** YouTube's
   [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)
   requires both. A smaller player still plays today, but it breaks those terms.
4. **Expect coarse tempo.** The player offers eight rates: 0.25, 0.5, 0.75, 1,
   1.25, 1.5, 1.75 and 2. It turns a request for 1.03 into exactly 1. Read the
   rate back with `getPlaybackRate()`, and show that value, not the value you
   asked for.

The set depends on server configuration: YouTube appears with or without a
`YOUTUBE_API_KEY`, but without one it cannot report video durations (they
come back as `0`), expand playlist links, search, or browse an account.

## Bandcamp catalog proxy

Everything under `/api/bc/` proxies Bandcamp's own APIs, cached briefly
server-side. Rate-limited at 240 requests/minute per caller IP across all of
`/api/bc/*`. None require sign-in, they don't touch your playlists, only
Bandcamp's public catalog.

```
GET /api/bc/search?q=text&type=a|t|b|f     (albums, tracks, artists, fans; type optional = all)
POST /api/bc/resolve      { "url": "https://artist.bandcamp.com/album/x" }
GET /api/bc/details?type=a&id=...&band_id=...
```
`resolve` and `details` return the same shape, full release detail
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
IDs itself, this is what the extension calls with `location.href` on an
album or track page, and with a discovered link's `href` anywhere else, so
it never needs to know Bandcamp's own internal ID scheme. `genres` is at
most 3 tags that match one of Bandcamp's own established genres (their
`/discover` taxonomy), an album tagged "shoegaze, Montreal, indie" for
instance only surfaces as `["Alternative"]` here, since the other two are a
style and a location, not a genre Bandcamp itself recognizes.

```
GET /api/bc/fan?username=someone
GET /api/bc/wishlist?fan_id=...&token=...&count=40
```
This returns a Bandcamp fan's identity (`fan_id`, `username`, `name`,
avatar) and one page of their wishlist. `token` is the pagination cursor from
the previous page's response (`last_token`). Omit it for the first page.

```
GET /api/bc/stream/{trackId}?band_id=...     -> 302 to a signed Bandcamp CDN URL
GET /api/bc/audio/{trackId}?band_id=...      -> the audio bytes, relayed
```
`stream` is what an `<audio>` element's `src` should point at, it redirects
straight to Bandcamp's CDN so the bytes never pass through this server.
`audio` exists only because Web Audio's `AnalyserNode` cannot read a
cross-origin stream with no CORS headers (which is what Bandcamp's CDN
sends), it relays the same bytes same-origin, at real bandwidth cost, so
only use it if you're actually analyzing the waveform.

## YouTube catalog proxy

Everything under `/api/yt/` proxies YouTube's own APIs, cached briefly
server-side. Rate-limited at 240 requests/minute per caller IP across all of
`/api/yt/*`, in a bucket of its own: a burst of YouTube browsing must not use up
an allowance that Bandcamp playback also draws on. None require sign-in.

Every endpoint here needs `YOUTUBE_API_KEY`. Without one the server answers
`400` and names the variable to set. Check `GET /api/sources` first rather than
probing.

```
GET /api/yt/search?q=text&kind=v|p|c      (videos, playlists, channels; kind optional = all)
```
One `Result[]`, whatever the kind. Search, channel browsing and playlist
expansion all return this same shape, so a client that renders one renders all
three:
```json
{ "results": [ {
  "kind": "v", "id": "dQw4w9WgXcQ",
  "title": "Never Gonna Give You Up", "artist": "Rick Astley",
  "channel_id": "UCuAXFkgsw1L7xaCfnd5JJOw",
  "art_url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "duration": 213, "item_count": 0, "playable": true
} ] }
```
`kind` is `v` for a video, `p` for a playlist, `c` for a channel. The first two
match what `POST /api/playlists/{id}/tracks` accepts, so a result's `url` goes
straight back as an add.

`artist` and `title` are split and cleaned by the rules under **Tracks** above,
not copied raw, so a search result and the row it becomes read identically.
`duration` is seconds, and is `0` for a playlist. `item_count` is how many
videos a playlist holds, and is `0` for anything else. **A `0` in either field
means "not reported", not "empty"**: show nothing rather than a zero.
`playable` is false for a video that could never play here, such as one taken
down, and adding it would produce a row nobody can play.

```
GET /api/yt/lookup?url=https://youtu.be/dQw4w9WgXcQ
```
Describes the video or playlist behind one pasted link, and adds nothing. The
response is `{ "result": Result }`, one row in the shape above. Show it, and
send the add only when a person presses Add. This is the YouTube equivalent of
`POST /api/bc/resolve`.

Do not add a pasted link straight from a render or an effect. The web app used
to do that, and one paste added the same video twice while music played. Every
position update re-rendered the popup, and each render queued the add again.

A video link costs 1 quota unit with a key, and no quota without one. A
playlist link needs `YOUTUBE_API_KEY`, and returns `400` without it. A private
or removed item returns `404` with a sentence you can show as-is.

Two notes on cost and behavior, because both surprise people:

- **A search costs 100 of the 10,000 daily quota units**, where everything else
  here costs 1. Identical queries are cached for 15 minutes. Debounce typing.
- **YouTube treats `type` as a hint, not a filter.** Asking it for playlists
  also returns the channel it thinks you meant. This server drops anything that
  does not match the `kind` you asked for, so the results are what you asked
  for.

```
GET /api/yt/channel?q=@handle|channel-link|name
```
Resolves whatever somebody typed into one channel. It accepts an `@handle`, any
of YouTube's four channel-link shapes, or a plain channel name. A plain name
costs a search, at 100 units. The other two forms cost 1.
```json
{
  "id": "UCuAXFkgsw1L7xaCfnd5JJOw", "title": "Rick Astley",
  "handle": "@rickastleyyt",
  "image_url": "https://yt3.ggpht.com/...",
  "uploads_playlist_id": "UUuAXFkgsw1L7xaCfnd5JJOw"
}
```
`uploads_playlist_id` holds everything the channel has posted. Every channel has
one, and it is the only thing to show for an account that posts videos but
curates no playlists. Treat it as one more playlist.

```
GET /api/yt/playlists?channel_id=UC...&page_token=...
GET /api/yt/playlist?id=PL...&page_token=...
```
A channel's public playlists, and the videos inside one playlist. Both page:
pass the previous response's `next_page_token` back, and stop when it is empty.
```json
{ "results": [ ... ], "next_page_token": "" }
```
`/api/yt/playlist` returns rows with real durations, which costs it a second
lookup per page. That is deliberate: YouTube's playlist endpoint reports no
duration, and titles a deleted video `"Deleted video"`.

```
GET /api/yt/stream/{videoId}     -> the audio bytes, relayed
GET /api/yt/audio/{videoId}      -> the whole audio file, same-origin
```
These are YouTube's counterparts to `/api/bc/stream` and `/api/bc/audio`, and
they split the same way: `stream` is what an `<audio>` element's `src` should
point at, and `audio` is for analysis only.

They differ from Bandcamp's in two ways that matter to a client:

- **`stream` relays rather than redirecting.** Bandcamp signs a URL the
  listener's own browser may load. A URL resolved for YouTube only works from
  the address that resolved it, so handing it to a browser gets a `403`. This
  server forwards Range requests, so seeking still works.
- **`audio` downloads the file, serves it, and removes it.** Nothing stays on
  disk between requests. It costs a download per call, which is why it is for
  analysis and not for playback: analysis happens once per track for everybody
  on the instance and is then cached as tempo and key. Web Audio decodes a whole
  buffer rather than reading progressively, and a relayed signed URL is
  throttled hard enough that loading a whole track through it often stalls.

Both need an audio extractor on the server, which is what `"stream": true`
reports. Without one they answer `400`.

## Cached audio analysis

The server caches detected tempo and key once per *track*, not once per
playlist row, and shares that one result across every playlist the track appears
in. A track carries the same identity as a playlist row: `source` and
`source_id`.

```
GET /api/analysis/version                    -> { "analyzer_version": 3 }
GET /api/analysis/{source}/{sourceId}        -> 404 if never analyzed
PUT /api/analysis/{source}/{sourceId}        (signed in)
{ "bpm": 122.4, "bpm_confidence": 0.8, "key_name": "A minor", "key_camelot": "8A",
  "key_tonic": 9, "key_scale": "minor", "key_confidence": 0.7, "peaks": "<base64>" }
```

The older single-segment forms, `GET`/`PUT /api/analysis/{trackId}`, still
work and mean the Bandcamp source. They are equivalent to passing
`bandcamp` explicitly, including for reading back rows written either way.

The server returns `400` to a `PUT` for any source whose audio it cannot get,
which means any source that reports `"analyze": false` from
`GET /api/sources`. Nobody could have measured those numbers, and they drive a
visible BPM column.

Client-side code (the web app's in-browser detector) computes these and
writes them back so nobody else has to re-download and re-analyze the same
track. There's no reason an external integration would call `PUT` here
unless it's running the same detection, reading via `GET` is the
interesting half for anything else.

## Healthcheck Endpoint

```
GET /api/health   -> { "status": "ok" }
```

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
