// Package source defines what a track source has to provide to be usable by
// this server, and nothing else. It imports no provider, so adding an
// integration never means editing this package.
//
// Providers live beside it (internal/bandcamp, internal/youtube) and are
// registered at startup, the way a database/sql driver is.
package source

import (
	"context"
	"errors"
)

// ErrNotFound is what a provider returns when the thing behind a URL or id is
// gone. Providers wrap it rather than defining their own, so the API layer can
// map "no longer there" to a 404 without knowing which provider spoke.
var ErrNotFound = errors.New("source: not found")

// ErrUnsupported is for a request a provider understands but cannot serve, a
// playlist URL given to a provider that only handles single tracks.
var ErrUnsupported = errors.New("source: unsupported")

// Ref names something a provider can expand into tracks: a Bandcamp album, a
// single Bandcamp track, a YouTube video, a YouTube playlist.
type Ref struct {
	Source string // registry key of the provider that issued this, "bandcamp"
	Kind   string // provider-defined: bandcamp "a"/"t", youtube "v"/"p"

	// ID is the provider's own identifier, as text. It is opaque: nothing
	// outside the provider that issued it may parse or interpret it. Bandcamp
	// ids are 64-bit integers and YouTube ids are 11 characters of base64url,
	// which is why this is a string rather than the int64 the schema used when
	// Bandcamp was the only source.
	ID string

	// Extra is whatever else that provider needs to act on the item later, and
	// is equally opaque. Bandcamp puts its band id here, because fetching
	// details or a stream url needs one. YouTube leaves it empty. It is stored
	// against the track as source_ref.
	Extra string
}

// Track is one row a provider wants inserted into a playlist. Every field is
// either display data or a provider-neutral identifier; nothing here is shaped
// by any particular source.
type Track struct {
	// SourceID identifies the track within its provider. It keys the shared
	// analysis cache, so two playlists holding the same track share one
	// analysis, and it is what a duplicate check would compare.
	SourceID string
	// SourceRef carries Ref.Extra forward, so acting on the track later (
	// resolving a stream url) does not need a second lookup.
	SourceRef string

	// AlbumRef and ArtRef are the source's own ids for the release this track
	// belongs to and for its artwork, as text, empty when the source has no
	// such concept. They exist because an id can be better than a URL: the
	// client derives a Bandcamp cover URL at whatever pixel size a given view
	// needs, where a stored URL would force one size on every view. A source
	// that only hands out image URLs leaves ArtRef empty and fills ArtURL.
	AlbumRef string
	ArtRef   string

	Title      string
	Artist     string
	AlbumTitle string
	Duration   float64 // seconds; 0 when the provider cannot determine it
	ArtURL     string  // absolute https url, or empty
	PageURL    string  // human-facing link back to the source

	// Playable false is skipped silently on add, which is how Bandcamp tracks
	// with no preview stream have always been treated: there is no point
	// holding a row that could never be played.
	Playable bool
}

// Caps describes what a client may do with one source's tracks. It is data
// rather than a set of type assertions because the client needs the answer too,
// over HTTP, to decide how to render and play a row.
//
// A provider that sets none of these is still useful: tracks can be added by
// link, listed, reordered, annotated and given a manual tempo or key.
type Caps struct {
	Stream  bool `json:"stream"`  // this server can resolve a playable audio url
	Analyze bool `json:"analyze"` // raw audio is fetchable same-origin for BPM, key, waveform
	Search  bool `json:"search"`  // the source has a catalog search endpoint
	Embed   bool `json:"embed"`   // playback happens in a player the source supplies
}

// CSP is the set of origins a provider's playback needs in the
// Content-Security-Policy. Each provider declares its own and the API layer
// merges them once at startup, so adding an integration does not also mean
// remembering to widen the security headers by hand.
type CSP struct {
	Media   []string // media-src, audio loaded directly
	Script  []string // script-src, a player the source supplies
	Frame   []string // frame-src, an embedded player
	Connect []string // connect-src, XHR or fetch to the source
}

// Provider is the whole contract. Anything richer than this is an optional
// interface, so a source that only knows how to turn a link into rows stays
// small.
type Provider interface {
	// ID is the registry key, and is stored in the database against every
	// track this provider produced. It must never change once rows exist.
	ID() string

	// Name is what a person sees, "Bandcamp".
	Name() string

	// Match reports whether this provider handles the URL. It must be cheap
	// and must not touch the network: the registry calls it on every provider
	// in turn to decide who owns a pasted link.
	Match(rawURL string) bool

	// Resolve turns a URL this provider matched into a Ref, which may require
	// a request to the source.
	Resolve(ctx context.Context, rawURL string) (Ref, error)

	// Expand turns a Ref into the rows to insert. An album yields many, a
	// single track yields one.
	Expand(ctx context.Context, ref Ref) ([]Track, error)

	Caps() Caps
	CSP() CSP
}

// Streamer is implemented by providers whose audio this server may hand to a
// browser. Bandcamp resolves a signed, short-lived CDN url per play.
type Streamer interface {
	StreamURL(ctx context.Context, ref Ref) (string, error)
}
