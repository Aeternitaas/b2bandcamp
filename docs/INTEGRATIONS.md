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
server-resolved streaming, and audio analysis. YouTube is **second-class**. A
person can add it by link, see it in the list, and play it in YouTube's own
embedded player. Nothing more.

The point of the contract is that "second-class" means a set of capability flags
that a provider declines to set. It does not mean a pile of special cases in the
handlers.

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
// does not implement it, and must not: its terms require its own player.
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
// Frame is the set of origins a provider's playback needs. Each provider
// declares its own, and securityHeaders merges them into the policy.
type Frame struct {
	Media  []string // media-src, direct audio
	Script []string // script-src, a provider-supplied player
	Frame  []string // frame-src, an embedded player
	Connect []string
}
```

Bandcamp returns `Media: {"https://*.bcbits.com", "https://bandcamp.com"}`,
reproducing today's policy exactly. YouTube returns
`Frame: {"https://www.youtube-nocookie.com"}` and
`Script: {"https://www.youtube.com"}`. The merge happens once at startup, not
per request, so the header stays a constant string in the hot path.

Note that `X-Frame-Options: DENY` and `frame-ancestors 'none'` control who may
frame *this app*. They have nothing to do with `frame-src`, and they stay as
they are.

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

`Caps` is `{Stream: false, Analyze: false, Search: false, Embed: true}`.
`Analyze` is false because BPM, key and waveform detection all require the raw
audio samples same-origin, which is what `/api/bc/audio` exists to provide
([bandcamp_handlers.go:170-178](../server/internal/api/bandcamp_handlers.go#L170-L178)),
and YouTube's terms do not permit that relay. Manual `bpm`, `key_override` and
`note` still work on YouTube rows, because those columns were never
Bandcamp-specific.

The 53-line TTL cache in [cache.go](../server/internal/bandcamp/cache.go) is
worth lifting to `internal/source/cache.go` and sharing, rather than copied.

## 8. What first-class and second-class actually mean

Falls out of `Caps`, which is the point.

| | Bandcamp | YouTube |
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
