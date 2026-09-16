package bandcamp

import (
	"strconv"
	"testing"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

// TestProviderMatch is the one part of the contract that must never touch the
// network: the registry calls Match on every provider to decide who owns a
// pasted link.
func TestProviderMatch(t *testing.T) {
	p := NewProvider(New())

	for _, u := range []string{
		"https://aphextwin.bandcamp.com/album/syro",
		"http://aphextwin.bandcamp.com/track/xmas-evet10",
		"bandcamp.com/something", // scheme is optional, as it is for Resolve
		"https://bandcamp.com/discover",
	} {
		if !p.Match(u) {
			t.Errorf("Match(%q) = false, want true", u)
		}
	}

	// Anything off bandcamp.com must not be claimed, or this provider would be
	// handed links belonging to another integration, and Resolve would become a
	// server-side request forgery primitive.
	for _, u := range []string{
		"https://youtu.be/dQw4w9WgXcQ",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		"https://evil.test/bandcamp.com",
		"https://notbandcamp.com/album/x",
		"",
	} {
		if p.Match(u) {
			t.Errorf("Match(%q) = true, want false", u)
		}
	}
}

func TestProviderCapsAndCSP(t *testing.T) {
	p := NewProvider(New())

	caps := p.Caps()
	if !caps.Stream || !caps.Analyze || !caps.Search {
		t.Errorf("Bandcamp is the first-class source, want stream/analyze/search, got %+v", caps)
	}
	if caps.Embed {
		t.Error("Bandcamp plays through this server, not an embedded player")
	}

	// The merged policy must still carry exactly what the hard-coded header
	// carried, or playback and art break.
	csp := p.CSP()
	want := map[string]bool{"https://*.bcbits.com": true, "https://bandcamp.com": true}
	if len(csp.Media) != len(want) {
		t.Fatalf("media-src origins = %v, want %v", csp.Media, want)
	}
	for _, origin := range csp.Media {
		if !want[origin] {
			t.Errorf("unexpected media-src origin %q", origin)
		}
	}
}

// TestProviderExpandMatchesDetails is the check that the adapter changed
// nothing: every field a playlist row persists must come out of Expand with the
// same value the handler used to read straight off Client.Details.
func TestProviderExpandMatchesDetails(t *testing.T) {
	ctx := skipIfShort(t)
	c := New()
	p := NewProvider(c)

	const albumURL = "https://aphextwin.bandcamp.com/album/syro"

	ref, err := p.Resolve(ctx, albumURL)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if ref.Source != SourceID {
		t.Errorf("ref source = %q, want %q", ref.Source, SourceID)
	}
	if ref.Kind != "a" {
		t.Errorf("ref kind = %q, want %q", ref.Kind, "a")
	}

	// The same call the old handler made, to compare against.
	typ, id, bandID, err := c.Resolve(ctx, albumURL)
	if err != nil {
		t.Fatalf("client Resolve: %v", err)
	}
	if ref.ID != strconv.FormatInt(id, 10) || ref.Extra != strconv.FormatInt(bandID, 10) {
		t.Fatalf("ref carries id=%s band=%s, want id=%d band=%d", ref.ID, ref.Extra, id, bandID)
	}

	detail, err := c.Details(ctx, typ, id, bandID)
	if err != nil {
		t.Fatalf("Details: %v", err)
	}
	tracks, err := p.Expand(ctx, ref)
	if err != nil {
		t.Fatalf("Expand: %v", err)
	}
	if len(tracks) != len(detail.Tracks) {
		t.Fatalf("Expand returned %d tracks, Details has %d", len(tracks), len(detail.Tracks))
	}

	for i, want := range detail.Tracks {
		got := tracks[i]
		if got.SourceID != strconv.FormatInt(want.TrackID, 10) {
			t.Errorf("track %d: source id = %q, want %d", i, got.SourceID, want.TrackID)
		}
		if got.SourceRef != strconv.FormatInt(want.BandID, 10) {
			t.Errorf("track %d: source ref = %q, want %d", i, got.SourceRef, want.BandID)
		}
		if got.AlbumRef != formatOptID(want.AlbumID) {
			t.Errorf("track %d: album ref = %q, want %q", i, got.AlbumRef, formatOptID(want.AlbumID))
		}
		if got.ArtRef != formatOptID(want.ArtID) {
			t.Errorf("track %d: art ref = %q, want %q", i, got.ArtRef, formatOptID(want.ArtID))
		}
		if got.Title != want.Title || got.Artist != want.Artist || got.AlbumTitle != want.AlbumTitle {
			t.Errorf("track %d: titles differ: got %q/%q/%q want %q/%q/%q",
				i, got.Title, got.Artist, got.AlbumTitle, want.Title, want.Artist, want.AlbumTitle)
		}
		if got.Duration != want.Duration {
			t.Errorf("track %d: duration = %v, want %v", i, got.Duration, want.Duration)
		}
		if got.PageURL != want.TrackURL {
			t.Errorf("track %d: page url = %q, want %q", i, got.PageURL, want.TrackURL)
		}
		if got.Playable != want.Streamable {
			t.Errorf("track %d: playable = %v, want streamable %v", i, got.Playable, want.Streamable)
		}
		// Art id and art url must agree: the client picks whichever it prefers,
		// and they must not describe different covers.
		if got.ArtRef != "" && got.ArtURL == "" {
			t.Errorf("track %d: has art id %q but no art url", i, got.ArtRef)
		}
	}
}

// TestProviderStreamURL proves the optional Streamer interface routes to the
// same signed-url call playback already used.
func TestProviderStreamURL(t *testing.T) {
	ctx := skipIfShort(t)
	p := NewProvider(New())

	ref, err := p.Resolve(ctx, "https://aphextwin.bandcamp.com/album/syro")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	tracks, err := p.Expand(ctx, ref)
	if err != nil {
		t.Fatalf("Expand: %v", err)
	}

	var playable *source.Track
	for i := range tracks {
		if tracks[i].Playable {
			playable = &tracks[i]
			break
		}
	}
	if playable == nil {
		t.Skip("no streamable track on this release")
	}

	url, err := p.StreamURL(ctx, source.Ref{
		Source: SourceID, Kind: "t", ID: playable.SourceID, Extra: playable.SourceRef,
	})
	if err != nil {
		t.Fatalf("StreamURL: %v", err)
	}
	if url == "" {
		t.Error("StreamURL returned an empty url for a streamable track")
	}
}

// TestRefIDsRejectsGarbage guards the one place that knows Bandcamp ids are
// integers: a ref from another provider must not be silently accepted.
func TestRefIDsRejectsGarbage(t *testing.T) {
	for _, ref := range []source.Ref{
		{ID: "dQw4w9WgXcQ", Extra: "123"},
		{ID: "123", Extra: ""},
		{ID: "0", Extra: "123"},
		{ID: "-1", Extra: "123"},
	} {
		if _, _, err := refIDs(ref); err == nil {
			t.Errorf("refIDs(%+v) accepted a ref it cannot handle", ref)
		}
	}
}
