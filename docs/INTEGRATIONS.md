# Integrations

How a track source plugs into this server, why the seams are where they are, and
what it takes to add a third one.

**Status: implemented.** Bandcamp and YouTube both run through the contract
below. Where the built code differs from the first design, this document names
the difference inline and gives the reason.

Bandcamp started out welded in rather than integrated. Its identifiers were the
column names. Its taxonomy was the request format. Its CDN sat in the
Content-Security-Policy. This document describes the contract that replaced
that, and uses YouTube as the second implementation. Section 1 records the
coupling as it stood, because every decision after it answers something there.

Bandcamp stays **first-class**. It keeps search, wishlist browsing,
server-resolved streaming, and audio analysis.

YouTube started as **second-class**, and this document was written that way. A
person could add it by link, see it in the list, and play it in YouTube's own
embedded player. Nothing more. **Section 12 records how that changed**, and why
the change cost so little. Sections 1 to 11 keep the original wording, because
the reasoning is what makes section 12 legible. Where a statement in them is now
false, a note beside it says so.

The point of the contract is that a class is a set of capability flags, not a
pile of special cases in the handlers. What makes that claim worth anything is
that YouTube changed class without the contract changing at all.

## 1. Where the Bandcamp coupling sat

This was the starting state. Every decision below answers one of these rows.
The line references point at the pre-change code.

| Coupling | Location |
| --- | --- |
| Track identity is a Bandcamp numeric id | [models.go:74-76](../server/internal/store/models.go#L74-L76), [store.go:112-114](../server/internal/store/store.go#L112-L114) |
| Art is a Bandcamp art id, URL derived client-side | [models.go:89](../server/internal/store/models.go#L89), [client.go:191](../server/internal/bandcamp/client.go#L191) |
| Playlist cover picks the first row's `art_id` | [playlists.go:14-16](../server/internal/store/playlists.go#L14-L16), [playlists.go:229-231](../server/internal/store/playlists.go#L229-L231) |
| Analysis cache keys on `bc_track_id` | [store.go:180-191](../server/internal/store/store.go#L180-L191), [analysis.go:26-30](../server/internal/store/analysis.go#L26-L30) |
| Track list joins analysis on `bc_track_id` | [playlists.go:274](../server/internal/store/playlists.go#L274) |
| `Server` holds a concrete `*bandcamp.Client` | [server.go:19-23](../server/internal/api/server.go#L19-L23) |
| Adding tracks calls Bandcamp directly | [playlist_handlers.go:207](../server/internal/api/playlist_handlers.go#L207), [playlist_handlers.go:235](../server/internal/api/playlist_handlers.go#L235) |
| Request items use Bandcamp's `a`/`t` taxonomy | [playlist_handlers.go:175-179](../server/internal/api/playlist_handlers.go#L175-L179) |
| `fail()` special-cases `bandcamp.ErrNotFound` | [server.go:118](../server/internal/api/server.go#L118) |
| CSP names bcbits, and blocks any third-party frame | [middleware.go:184-189](../server/internal/api/middleware.go#L184-L189) |

That last row is a hard blocker, not a tidiness problem. `default-src 'self'`
with no `frame-src` makes `frame-src` inherit `'self'`. The browser therefore
refuses a YouTube IFrame embed, and `script-src 'self'` refuses YouTube's player
API script. YouTube playback cannot work at all until the server assembles the
CSP instead of hard-coding it. See section 6.

## 2. The contract

A new package, `internal/source`, holds the interface, the registry, and the
neutral types. The providers live beside it as siblings: `internal/bandcamp`,
where it already was, and `internal/youtube`. This mirrors `database/sql` and
its drivers. The contract package knows nothing about any implementation.

```go
package source

// Ref names something a provider can expand into tracks: a Bandcamp album, a
// single track, a YouTube video, a YouTube playlist.
type Ref struct {
	Source string // registry key: "bandcamp", "youtube"
	Kind   string // provider-defined: bandcamp "a"/"t", youtube "v"/"p"
	ID     string // provider-native, opaque to everything but its provider
	Extra  string // opaque handle needed to act on it later, may be empty
}

// Track is one row a provider wants inserted. Everything here is display data
// or an identifier; nothing in it is provider-shaped.
type Track struct {
	SourceID   string  // identity within the provider, keys the analysis cache
	SourceRef  string  // carries Ref.Extra forward, Bandcamp's band id
	AlbumRef   string  // the source's own album id, empty if it has none
	ArtRef     string  // the source's own artwork id, empty if art is a URL
	Title      string
	Artist     string
	AlbumTitle string
	Duration   float64 // seconds, 0 when the provider cannot determine it
	ArtURL     string  // absolute https url, or empty
	PageURL    string  // human-facing link back to the source
	Playable   bool    // false is silently skipped, as non-streamable is today
}

// Caps tells the client what it may do with this source's tracks. A provider
// that sets none of these still supports adding by link and manual metadata.
type Caps struct {
	Stream  bool // the server can resolve a playable audio url per play
	Analyze bool // raw audio can be fetched same-origin for BPM, key, waveform
	Search  bool // the source has a catalog search endpoint
	Embed   bool // playback happens in a provider-supplied iframe player
}

// Provider is the minimum a source must implement. Anything richer is an
// optional interface, so a second-class source stays small.
type Provider interface {
	ID() string               // registry key, stored in the db
	Name() string             // what a person sees, "Bandcamp"
	Match(rawURL string) bool // cheap, no network
	Resolve(ctx context.Context, rawURL string) (Ref, error)
	Expand(ctx context.Context, ref Ref) ([]Track, error)
	Caps() Caps
	CSP() CSP // origins this source's playback needs, see section 6
}

// Streamer is implemented by providers whose audio this server can hand to a
// browser. Bandcamp resolves a short-lived signed CDN url per play. YouTube
// does not implement it.
type Streamer interface {
	StreamURL(ctx context.Context, t Ref) (string, error)
}
```

Three points about the shape, since they are the decisions that matter.

**`ID` is opaque.** Bandcamp needs a band id as well as an item id before it
can fetch anything. An earlier sketch carried that as a typed `BandID int64` on
the Ref. That leaks one provider's schema into the contract, and the next
provider then adds another field. Instead, each provider encodes whatever it
needs and parses its own value back.

Bandcamp puts the item id in `ID` and the band id in `Extra`. YouTube puts the
video id in `ID` and leaves `Extra` empty. YouTube also needs no network to
resolve a link, because a YouTube URL carries its own id.

**`AlbumRef` and `ArtRef` arrived during implementation, and the step order was
wrong without them.** In the design, `Expand` returned only neutral display
fields. That would have dropped `art_id` and `bc_album_id` as soon as adds
started to route through the registry.

Art ids drive cover rendering and the MediaSession artwork at two pixel sizes.
Losing them is a visible regression, and it would have landed several steps
before the schema could replace them. These two opaque fields carry a source's
own album and artwork ids through the neutral contract, so both identities
survive the change. YouTube leaves both empty and fills `ArtURL` instead.

**Capabilities are data, not type assertions at the call site.** A handler must
already answer "can the client analyse this" for the client, over HTTP. The
answer therefore has to be a value the server can serialise. `Caps` is that
value. `Streamer` exists only so that a provider which sets `Stream: false` does
not have to write a method that always fails.

**`Expand` returns tracks, not a provider-shaped detail object.** Before the
change, `handleAddTracks` took a `bandcamp.Tralbum` and did the filtering and
field mapping itself
([playlist_handlers.go:235-256](../server/internal/api/playlist_handlers.go#L235-L256)).
Moving that work into the provider is what lets the handler stop knowing what a
band id is. The `Playable` flag keeps the old behaviour, where the server skips
non-streamable tracks without comment. The handler never learns why a provider
skipped a track.

## 3. The registry

```go
type Registry struct { /* ordered, plus an id index */ }

func (r *Registry) Register(p Provider)
func (r *Registry) ByID(id string) (Provider, bool)
func (r *Registry) ForURL(rawURL string) (Provider, bool) // first Match wins
func (r *Registry) All() []Provider
```

Wired once in `main.go`:

```go
reg := source.NewRegistry()
reg.Register(bandcamp.NewProvider(bc))          // first, so it wins ties
if p, err := youtube.New(cfg.YouTubeAPIKey); err == nil {
	reg.Register(p)
}
```

`Server` gains `reg *source.Registry`. It keeps `bc *bandcamp.Client` as well,
and that is deliberate rather than a leftover.

The Bandcamp-only endpoints are wishlist, fan lookup, catalog search and the
audio proxy. Those endpoints are what first-class means. Forcing them through a
lowest-common-denominator interface would produce an interface with one
implementation. The registry covers what every source must do. `s.bc` covers
what only Bandcamp does.

## 4. Schema

[SCHEMA.md](SCHEMA.md) documents the current shape of every table, after these
migrations. This section covers only what changes, and why.

These changes are additive, which follows the decision to keep the `bc_*`
columns working. Apart from a backfill, existing rows stay as they are. No
client has to ship at the same time.

Six entries, each exactly one statement. `migrate()` runs one `ExecContext` per
entry ([store.go:229-236](../server/internal/store/store.go#L229-L236)) and the
DSN does not set `multiStatements`
([config.go:74-75](../server/internal/config/config.go#L74-L75)), so a migration
carrying two statements would fail at runtime. That is why the two backfills are
separate entries rather than tacked onto their `ALTER`.

```
015_track_source
  ALTER TABLE playlist_tracks
    ADD COLUMN source     VARCHAR(16)  NOT NULL DEFAULT 'bandcamp' AFTER position,
    ADD COLUMN source_id  VARCHAR(64)  NOT NULL DEFAULT ''         AFTER source,
    ADD COLUMN source_ref VARCHAR(64)  NULL                        AFTER source_id,
    ADD COLUMN art_url    VARCHAR(500) NULL                        AFTER art_id

016_backfill_track_source
  UPDATE playlist_tracks
     SET source_id  = CAST(bc_track_id AS CHAR),
         source_ref = CAST(bc_band_id AS CHAR)
   WHERE source_id = ''

017_track_source_key
  ALTER TABLE playlist_tracks
    MODIFY bc_track_id BIGINT UNSIGNED NULL,
    ADD KEY idx_tracks_source (source, source_id)

018_analysis_source
  ALTER TABLE track_analysis
    ADD COLUMN source    VARCHAR(16) NOT NULL DEFAULT 'bandcamp' FIRST,
    ADD COLUMN source_id VARCHAR(64) NOT NULL DEFAULT ''         AFTER source

019_backfill_analysis_source
  UPDATE track_analysis SET source_id = CAST(bc_track_id AS CHAR) WHERE source_id = ''

020_analysis_source_pk
  ALTER TABLE track_analysis
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (source, source_id),
    DROP COLUMN bc_track_id
```

**Verified.** A test ran these six against a throwaway MySQL 8.4, restored from
a dump of the live `b2bandcamp-db-1` (284 track rows, 360 analysis rows, 12
playlists). All six succeeded. Afterwards: every `source_id` equals
`CAST(bc_track_id AS CHAR)`, every `source_ref` equals `CAST(bc_band_id AS CHAR)`
including the NULLs, all 360 analysis rows survived with 360 distinct
`(source, source_id)` pairs so the new primary key had no collisions, and the
re-keyed analysis join returns results identical to the old `bc_track_id` join on
all 284 Bandcamp rows. A synthetic YouTube row with NULL Bandcamp ids inserts and
survives the `LEFT JOIN` with no analysis attached.

Why the columns are what they are:

- **`source_id` is text, not a number.** Bandcamp ids are 64-bit integers,
  YouTube video ids are 11 characters of base64url. Text is the only type both
  fit, and `CAST(bc_track_id AS CHAR)` makes the backfill exact and reversible.
- **`source_ref` is separate from `source_id`.** Analysis and duplicate
  detection want track identity alone. Streaming additionally wants Bandcamp's
  band id. Folding them into one compound key would make the analysis cache key
  carry a field it does not need, and would break the 1:1 backfill from the
  existing `track_analysis` rows.
- **`bc_track_id` becomes nullable.** A YouTube row has no Bandcamp track id,
  and writing `0` would be a lie that a later migration cannot distinguish from
  real data. It serialises as JSON `null`, which the web's `bc_track_id: number`
  type must widen to `number | null`. The player already refuses to play a row
  with no `bc_band_id` ([player.tsx:121](../web/src/state/player.tsx#L121)), so
  a null id never reaches the stream URL builder.
- **`art_url` sits beside `art_id` rather than replacing it.** Bandcamp's art id
  is better than a URL for Bandcamp, because the web picks the pixel size it
  wants per view, and a hundred-row playlist rendering 600px covers as
  thumbnails is real bandwidth. YouTube gives a URL and no such control. The
  client prefers `art_url` when set and derives from `art_id` otherwise. This is
  a documented wart with a cleanup path, not a permanent design.

The analysis join ([playlists.go:274](../server/internal/store/playlists.go#L274))
moves to `ON a.source = t.source AND a.source_id = t.source_id`.

The playlist cover subqueries ([playlists.go:14-16](../server/internal/store/playlists.go#L14-L16))
need more care than they look like they do. The obvious change, adding a
parallel `cover_art_url` that picks the first non-null `art_url`, is wrong: on a
mixed playlist every Bandcamp row has `art_id` and no `art_url`, so "first row
with an `art_url`" skips past a Bandcamp track at position 0 and picks a YouTube
thumbnail from position 40. The playlist's cover would silently change the moment
anyone added a YouTube link. The dry run described above reproduced exactly that.

Both subqueries must instead select from the first row that has *either* kind of
art, so they always describe the same row:

```sql
(SELECT ft.art_id FROM playlist_tracks ft
  WHERE ft.playlist_id = p.id AND (ft.art_url IS NOT NULL OR ft.art_id IS NOT NULL)
  ORDER BY ft.position ASC, ft.id ASC LIMIT 1) AS cover_art_id,
(SELECT ft.art_url FROM playlist_tracks ft
  WHERE ft.playlist_id = p.id AND (ft.art_url IS NOT NULL OR ft.art_id IS NOT NULL)
  ORDER BY ft.position ASC, ft.id ASC LIMIT 1) AS cover_art_url,
```

A test against the restored copy checked all three cases:

- An all-Bandcamp playlist returns its existing `cover_art_id` and a null
  `cover_art_url`, exactly as before.
- A mixed playlist returns the Bandcamp art at position 0, not the YouTube
  thumbnail.
- A YouTube-only playlist returns a null `cover_art_id` and the thumbnail URL.

`SharesByOwner` holds an identical subquery
([playlists.go:229-231](../server/internal/store/playlists.go#L229-L231)). The
same "either kind of art" predicate belongs there too.

## 5. HTTP surface

**`POST /api/playlists/{id}/tracks`** accepts a third item shape. All three
coexist:

```json
{ "url": "https://youtu.be/dQw4w9WgXcQ" }
{ "items": [ { "source": "youtube", "kind": "v", "id": "dQw4w9WgXcQ" } ] }
{ "items": [ { "type": "a", "id": 23244101, "band_id": 3439762373 } ] }
```

The third shape is the current format. The server treats an item with no
`source` as Bandcamp: `type` becomes `kind`, `id` becomes text, and `band_id`
becomes `Extra`. The extension and the web app therefore keep working with no
change.

A `url` goes to `reg.ForURL`. When no provider matches, the server returns `400`
and names the link, instead of returning a Bandcamp parse error.

**`GET /api/sources`** is new, and it is what makes the system extensible
rather than only refactored. It returns the registry's capabilities. The client
therefore asks the server which sources exist, instead of hard-coding a list:

```json
{ "sources": [
  { "id": "bandcamp", "name": "Bandcamp",
    "caps": { "stream": true, "analyze": true, "search": true, "embed": false } },
  { "id": "youtube", "name": "YouTube",
    "caps": { "stream": false, "analyze": false, "search": false, "embed": true } }
] }
```

**`GET /api/analysis/{source}/{sourceId}`** and the matching `PUT` replace the
`{trackId}` routes. The old routes stay as aliases that fill in `"bandcamp"`, so
cached analysis keeps resolving for old clients.

The server returns `400` for a `PUT` against a source whose `Caps.Analyze` is
false. Accepting numbers that nobody could have measured is how a BPM column
becomes untrustworthy.

**The `/api/bc/*` routes do not change.** They are Bandcamp's own, and they stay
that way.

YouTube adds no streaming endpoint at all. The client sees `source: "youtube"`
with `embed: true`, then mounts YouTube's IFrame player on `source_id`. That is
the only permitted way to play it. It also adds no server surface, which is a
good sign that the seam sits in the right place.

> **No longer true.** `/api/yt/*` now exists: search, channel and playlist
> browsing, and two audio endpoints. See section 12. The paragraph above stands
> as the reasoning that made the endpoints optional rather than assumed.

**`fail()`** ([server.go:118](../server/internal/api/server.go#L118)) drops the
`bandcamp.ErrNotFound` case in favour of a `source.ErrNotFound` that providers
wrap, so a new provider's not-found does not fall through to a `500`.

The outbound rate limiter ([bandcamp_handlers.go:13](../server/internal/api/bandcamp_handlers.go#L13))
becomes per-source rather than one global bucket, so a YouTube quota problem
cannot exhaust a user's Bandcamp allowance or the reverse.

## 6. Content-Security-Policy

The CSP is currently a hard-coded string listing bcbits
([middleware.go:184-189](../server/internal/api/middleware.go#L184-L189)). With
providers registered at startup it should be assembled from them, which is the
difference between "add a provider" and "add a provider and remember to go edit
the security headers".

```go
// CSP is the set of origins a provider's playback needs. Each provider
// declares its own, and the API layer merges them once at startup.
type CSP struct {
	Media   []string // media-src, direct audio
	Script  []string // script-src, a provider-supplied player
	Frame   []string // frame-src, an embedded player
	Connect []string // connect-src
}
```

The design called this type `Frame`, with a `Frame()` method. The code calls it
`source.CSP`, with a `CSP()` method, because the type covers more than framing.

Bandcamp returns `Media: {"https://*.bcbits.com", "https://bandcamp.com"}`,
reproducing today's policy exactly. YouTube returns
`Frame: {"https://www.youtube-nocookie.com"}` and
`Script: {"https://www.youtube.com"}`. The merge happens once at startup, not
per request, so the header stays a constant string in the hot path.

Note that `X-Frame-Options: DENY` and `frame-ancestors 'none'` control who may
frame *this app*. They have nothing to do with `frame-src`, and they stay as
they are.

### The page must carry the headers

A browser enforces a Content-Security-Policy only from the response that
delivers the page. The same is true of `Referrer-Policy` and of the frame
rules. A policy on a JSON response governs nothing the user sees.

Until 2026-09-16, only `/api/` responses carried these headers. The web app
itself, at `/`, carried none. The live site therefore ran with no CSP, no
`Referrer-Policy` and no `X-Frame-Options`, so any site could frame it. The
policy that the README describes never reached a browser. Traefik adds only
`X-Robots-Tag`, so it did not cover the gap.

`routes()` in [main.go](../server/main.go) now wraps the web app with the same
`securityHeaders` that the API uses, through `api.Server.SecurityHeaders`. One
policy string serves both halves. `TestPageCarriesSecurityHeaders` in
[main_test.go](../server/main_test.go) checks `/`, a client route, an asset
and `/api/health`, and fails if the page and the API ever send different
policies. With the wrap removed, the test fails on the three page paths.

A real browser checked the change before it shipped. Headless Chromium loaded
the built app in both YouTube modes and reported no CSP violations and no
console errors, and the app rendered.

## 7. The YouTube provider

Recognised URL forms: `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/shorts/`,
`music.youtube.com/watch?v=`, and `&list=` for playlist expansion.

`.env.example` and both compose files already carry `YOUTUBE_API_KEY`. The
remaining config work is one field on `Config` and one line in `Load()`
([config.go:37-45](../server/internal/config/config.go#L37-L45)). `Load()` reads
it with the existing `env()` helper and defaults it to empty.

The key must stay optional. An empty key selects the oEmbed path, which the
server supports. It is not a startup error.

The provider reads metadata from the Data API v3 when `YOUTUBE_API_KEY` holds a
value, and from keyless oEmbed when it does not. There are two paths for one
reason: demanding an API key before the feature works at all costs a self-hosted
instance real effort, and the fallback is small.

| | Data API v3 | oEmbed |
| --- | --- | --- |
| Config | `YOUTUBE_API_KEY` | none |
| Title, channel, thumbnail | yes | yes |
| Duration | yes, ISO-8601 in `contentDetails` | **no, rows display 0:00** |
| Embeddable check | yes, `status.embeddable` | no |
| Playlist expansion | yes, `playlistItems.list` | no |
| Batching | 50 ids per call, 1 quota unit | one call per video |

Quota is 10,000 units/day and `videos.list` costs 1 unit for up to 50 ids, so
even heavy use is unlikely to approach it. Catalog search is deliberately not
implemented: `search.list` costs 100 units per call, which would exhaust the
daily quota in 100 searches, and search is a first-class feature anyway.

> **Superseded.** Search is implemented, and the quota arithmetic above is why
> it caches every query for 15 minutes. See section 12.

### Artist and track names

YouTube gives a video title and a channel name. Neither one is the artist and
track that an export needs, so the provider derives both. `metadata.go` holds
that work. Three shapes cover almost everything YouTube returns.

**An auto-generated art track.** The channel is `Muadeep - Topic` and the title
is `Tsunami`. YouTube Music displays the artist as `Muadeep`, and so does this
provider. The channel names the artist exactly, so the provider trusts it and
does not split the title. Splitting would be wrong for a track whose own name
holds a dash, such as `Blue Monday - 2016 Remaster`.

**A normal upload.** The channel is `Rick Astley` and the title is
`Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)`. The
title carries `artist - track`, so the provider splits on the first separator.
It accepts a hyphen, an en dash or an em dash, and it requires spaces on both
sides. `Jay-Z` therefore stays one word.

**An upload with no separator.** The channel is `Alan Walker` and the title is
`Faded`. The channel is the best artist available. The provider strips the
decoration that channel names carry, so `LuisFonsiVEVO` becomes `LuisFonsi` and
`Queen Official` becomes `Queen`.

The provider then removes promotional decoration from the track title:
`(Official Video)`, `[Lyrics]`, `(4K Remaster)`, `| Official Video`, a trailing
`M/V`, and the rest of that family.

**Removal is deliberately conservative.** A bracketed group goes only when its
whole content matches a known promotional phrase. Any group that holds a word a
DJ needs stays, whatever else it says. That list covers mix, remix, edit,
version, feat, live, acoustic, extended, radio, club, original, instrumental and
more. Losing `(Extended Mix)` from a track title is far worse than keeping an
occasional `(Official Live Video)`, because the two records are different
records.

The provider never returns an empty field. If stripping would empty a title, it
keeps the original.

`Caps` was `{Stream: false, Analyze: false, Search: false, Embed: true}`. It is
now computed from how the instance is configured. Section 12 gives the values
and what turns each one on. The reasoning that fixed them at `false` was this:
`Analyze` is false because BPM, key and waveform detection all require the raw
audio samples same-origin, which is what `/api/bc/audio` exists to provide
([bandcamp_handlers.go:170-178](../server/internal/api/bandcamp_handlers.go#L170-L178)),
Manual `bpm`, `key_override` and `note` still work on YouTube rows, because those
columns were never Bandcamp-specific.

The 53-line TTL cache in [cache.go](../server/internal/bandcamp/cache.go) is
worth lifting to `internal/source/cache.go` and sharing, rather than copied.

## 8. What first-class and second-class actually mean

Falls out of `Caps`, which is the point.

The YouTube column is what this table said before section 12. It now reads as
that section's table does, and the two are worth comparing: every row that
changed, changed by a provider setting a flag it had declined to set.

| | Bandcamp | YouTube (as first written) |
| --- | --- | --- |
| Add by pasted link | yes | yes |
| Add from catalog search | yes | no |
| Wishlist and fan browsing | yes | no |
| Playback | server-resolved signed CDN url | provider's iframe player |
| BPM, key, waveform detection | yes | no |
| Manual bpm, key, note | yes | yes |
| Cover art | art id, size chosen per view | thumbnail url |
| Duration | yes | only with an API key |

## 9. Adding a third integration

The payoff. A new source is one package implementing `Provider`, plus one line
in `main.go`. Concretely:

1. `internal/<name>/provider.go`, implementing the six methods.
2. `Match` and `Resolve` for its URL forms.
3. `Expand` returning `[]source.Track`.
4. `Caps` and `Frame` describing what it can do and what origins it needs.
5. `reg.Register(...)` in `main.go`.

No migration, no new column, no handler change, no CSP edit, no route. If adding
a source requires touching anything in `internal/api` or `internal/store`, the
contract is wrong and should be fixed rather than worked around.

## 10. Implementation order

Each step is independently shippable and leaves the tree green.

**Before any step that carries a migration (3 and 5), dump the live database and
rehearse the migration against a restored copy.** Migrations here run at server
startup, against whatever database the container points at, with no rollback
path. A bad statement therefore applies in part, and you find it in production,
at boot. The rehearsal is cheap:

```sh
docker exec b2bandcamp-db-1 sh -c \
  'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines \
   --triggers --databases "$MYSQL_DATABASE"' | gzip > backup-$(date +%F-%H%M).sql.gz

docker run -d --name mig-dryrun -e MYSQL_ROOT_PASSWORD=dryrun mysql:8.4
# wait for "init process done" in the logs before connecting: the entrypoint
# runs a temporary server first, and restoring into that one silently vanishes
zcat backup-*.sql.gz | docker exec -i mig-dryrun mysql -u root -pdryrun
```

Then apply the new statements one at a time and assert on the result, not just
on the exit code. The live database is `b2bandcamp-db-1`.

1. **`internal/source` contract and registry, with no change in behaviour.**
   Check: `go build ./...` passes, and the new package imports nothing outside
   the standard library.
2. **Bandcamp adapter.** `bandcamp.NewProvider` wraps the existing client, and
   `handleAddTracks` goes through the registry. Nothing else moves.
   Check: the existing add-by-url and add-by-items requests return identical
   JSON.
3. **Migrations 015 to 017, dual-write.** `AddTracks` writes both the
   `source`/`source_id` columns and the `bc_*` columns. Reads still use `bc_*`.
   Check: migrate a copy of production. Every row must have `source_id` equal to
   `bc_track_id`, and no row may have `source_id = ''`.
4. **Reads move to `source`/`source_id`.** This covers the track list join and
   the cover subqueries. The `Track` JSON gains `source`, `source_id` and
   `art_url`.
   Check: the web app renders an all-Bandcamp playlist as before.
5. **Migrations 018 to 020, analysis re-keyed.** New routes, plus aliases.
   Check: a track analysed before the migration still returns its cached result
   through both the old route and the new one.
6. **CSP assembly from providers.**
   Check: with only Bandcamp registered, the response header on `/` is
   byte-identical to the old one.
7. **`GET /api/sources`.**
8. **The YouTube provider**, with the Data API path and the oEmbed fallback.
   Check: paste a video link into a playlist. The row must appear with a title,
   a channel, a thumbnail, and a real duration once you set a key.

Steps 1 to 7 refactor the server and change nothing a user can see. That is the
honest shape of this work. The YouTube integration itself is the small part.

### What the verification actually caught

Both of these would have reached production, and neither one appears in a build
or a unit test. They are worth recording for that reason.

- **The cover-art subquery picked the wrong row.** Section 4 covers it. Running
  the query against a mixed playlist found it. Reasoning about the query did
  not.
- **An empty playlist returned `500`.** The fixed subquery wraps its art lookup
  in `COALESCE`, but that only fires when a row exists. A playlist with no
  tracks yields no row at all, so NULL reached a `string` scan. The end-to-end
  script found it, because that script creates a playlist before it adds to the
  playlist. The fix wraps the whole subquery instead of the column inside it.

The end-to-end method that found them is worth reusing: build a binary from
`HEAD` and one from the working tree, run both against separate databases,
drive the same requests at each, and diff the responses with timestamps and row
ids normalised. It turns "I think this is compatible" into a byte comparison.

## 12. YouTube as a first-class source

Sections 1 to 11 describe YouTube as second-class. It is not any more, and this
section records what changed. Read it as the test of the contract, because that
is what it turned out to be: **no file in `internal/source`, `internal/store` or
the add path changed.** Section 9 claims a source's class is a set of flags.
Changing YouTube's class changed those flags and added endpoints beside them.

### What drove it

Three things a person wanted, none of which the design allowed:

1. Search YouTube from the add-music popup, not only paste links into it.
2. Browse a YouTube account's public playlists, the way the wishlist browses a
   Bandcamp fan's wishlist.
3. Detect tempo and key on YouTube rows, the same as on Bandcamp rows.

The first two were refused on quota. The third was refused on a hard fact: the
browser never sees the samples, so nothing client-side can measure them.

### The extractor, and what it decides

One decision answers all three. **The server runs an audio extractor (`yt-dlp`)
to fetch a video's audio.** Once the audio is reachable, playback and analysis
both follow, because they are one question and not two. Section 7 said `Analyze`
is false because the samples never arrive same-origin. That was right. The
extractor is what makes them arrive.

This is the one part of the integration that depends on something outside the
binary, so it is optional and checked once at startup:

```go
yt := youtube.New(cfg.YouTubeAPIKey, youtube.WithExtractor(cfg.YTDLPPath))
```

`Caps` is then computed rather than constant, which is the shape section 2
argued for and the first implementation did not need:

| Flag | True when |
| --- | --- |
| `Stream` | an extractor is on PATH |
| `Analyze` | the same, because both need the same samples |
| `Search` | `YOUTUBE_API_KEY` is set |
| `Embed` | no extractor, so the iframe player is the only way to play a row |

With neither configured, YouTube behaves exactly as sections 1 to 11 describe.
That is the point of putting the answer in `Caps`: the degraded instance is not
a special case, it is the same code reporting less.

`CSP()` follows. With an extractor the provider asks for no origins at all,
because the audio comes from this server and thumbnails are already covered by
the blanket `https:` `img-src`. The iframe origins are only in the policy on an
instance that uses the iframe. An origin nothing loads from is still an origin
the policy permits.

### The two audio endpoints, and why there are two

`/api/yt/stream/{videoId}` relays the bytes for playback.
`/api/yt/audio/{videoId}` downloads the file, serves it, and removes it.

Bandcamp splits the same way and for a related reason, but the mechanics differ
on both halves:

- **`stream` relays where Bandcamp redirects.** A signed Bandcamp URL works from
  the listener's browser. A URL the extractor resolves carries the address that
  resolved it, so a browser on any other address receives a `403`.
- **`audio` downloads to a temporary directory rather than relaying.** Web Audio
  decodes a whole buffer rather than reading progressively, and a relayed signed
  URL is throttled hard enough that a full track often stalls. The extractor
  knows how to work around that. A plain proxy does not.

Nothing stays on disk between requests. One directory per download, removed
whole, so a partial file cannot outlive the request either. That costs a
download per analysis, which is the right trade: analysis runs once per track
for every user of the instance, and its result is then a row of tempo and key in
the database. Audio kept on disk would accumulate for a feature that has already
finished with it.

### Search, and the quota

`search.list` costs 100 of the 10,000 daily units. Section 7 called that
disqualifying. It is affordable with two things the first version lacked:

- Every query is cached for 15 minutes, so going back to an earlier search costs
  nothing.
- The client debounces typing, so a search is one call and not one per keystroke.

Everything else costs 1 unit: channel lookup, listing playlists, expanding one.
A search enriches its own results with a second call for durations and playlist
lengths, because a list with neither is hard to read, and one more unit next to
a hundred is not the expensive part.

**YouTube treats `type` as a hint.** Asking `search.list` for playlists also
returns the channel it thinks you meant. The provider drops anything that does
not match the requested kind. This is worth stating because it is not in
Google's documentation and it looks like a bug in this code.

### The embedded player

An instance with no extractor plays YouTube rows in YouTube's iframe player. A
headless browser tested that path on 2026-09-16, against a built image, under
the real policy. Four facts came out of it.

**The frame must set its own referrer policy.** The page sends
`Referrer-Policy: no-referrer`, and YouTube refuses to play in a frame that
sends no referrer. It reports error `153`. The web app creates the frame itself
and sets `referrerPolicy = 'strict-origin-when-cross-origin'` before it inserts
the frame, and inserting it is what starts the load. In the test, a frame with
that attribute reached `playing`. A frame without it inherited `no-referrer` and
failed with `153`. Keep the server header as it is, and keep the attribute in
[player.tsx](../web/src/state/player.tsx). Removing either one breaks
something.

**The player is smaller than YouTube's terms allow.** YouTube's
[Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)
says: "Embedded players must have a viewport that is at least 200px by 200px."
The web app renders the player at 78 by 44, in the artwork's place. That size
played without error in the test, so YouTube does not enforce the rule today.
It still breaks the terms, and YouTube could start to enforce the rule at any
time. The same page also forbids any overlay in front of any part of the
player, so nothing may sit on top of that slot.

**Tempo control does not work for beatmatching.** The iframe player offers
eight rates: 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75 and 2. In the test, a request
for 1.03 came back as exactly 1. Every adjustment in the range a DJ uses
therefore snaps to normal speed, and the tempo slider displays that. An instance
with an extractor has no such limit, because the row then plays in an `<audio>`
element, whose rate is continuous.

**No detection runs.** The browser never receives the samples, so tempo, key
and waveform detection cannot run, and the server refuses to store results for
these rows. The BPM and key readouts display only what is already stored: a manual
override, or an analysis saved while this instance had an extractor.

All four limits disappear with an extractor, which the production image now
installs. The embedded player remains the fallback for an instance without one.

### What did not change

The list is the load-bearing part of this section:

- `internal/source` is untouched. No new field, no new method, no new optional
  interface. `Streamer` was already there for exactly this.
- No migration. `source`, `source_id` and `art_url` already carried everything a
  YouTube row needs.
- `handleAddTracks` is untouched. Adding a link already went through the
  registry.
- The analysis handlers are untouched. They gate on `Caps().Analyze`, so
  flipping that flag was the whole change. Writes that were refused with a `400`
  now succeed, through the same code.

Section 9 says that if adding a source requires touching `internal/api` or
`internal/store`, the contract is wrong. Promoting one required touching
`internal/api`, and only to add endpoints that are YouTube's own, beside
Bandcamp's own. That is the same exception section 3 already carved out for
`s.bc`, and `s.yt` sits next to it for the same reason.

## 11. Open points

- **Duplicate detection.** Nothing today prevents adding the same track twice,
  and `(source, source_id)` now makes it cheap. Out of scope, worth noting.
- **Dropping the `bc_*` columns.** Deferred deliberately. Once the web and the
  extension read `source`/`source_id`/`art_url`, a later migration backfills
  `art_url` from `art_id` and drops all four columns.
- **Mixed-source playback continuity.** A playlist alternating Bandcamp and
  YouTube rows switches between an `<audio>` element and an iframe player
  mid-queue. That is a web problem, but the server should not make it worse:
  `Caps` is per source and the client can see the whole queue up front.
