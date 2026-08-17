package bandcamp

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// These tests talk to Bandcamp over the network. They are the only way to catch
// the thing most likely to break this app: Bandcamp changing a response shape or
// moving data out of a page. Run with -short to skip them.
//
//	go test ./internal/bandcamp -v
//	go test ./... -short
func skipIfShort(t *testing.T) context.Context {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping network test in short mode")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestSearch(t *testing.T) {
	ctx := skipIfShort(t)

	results, err := New().Search(ctx, "aphex twin", "a")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) == 0 {
		t.Fatal("Search returned no results")
	}

	for _, r := range results {
		if r.Type != "a" {
			t.Errorf("filter %q leaked a result of type %q", "a", r.Type)
		}
		if r.ID == 0 || r.Name == "" {
			t.Errorf("incomplete result: %+v", r)
		}
		// band_id is what Details needs; a result without it is unusable.
		if r.BandID == 0 {
			t.Errorf("album result %q has no band id", r.Name)
		}
	}
}

func TestResolveAndDetails(t *testing.T) {
	ctx := skipIfShort(t)
	c := New()

	typ, id, bandID, err := c.Resolve(ctx, "https://aphextwin.bandcamp.com/album/syro")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if typ != "a" {
		t.Errorf("item type = %q, want %q", typ, "a")
	}
	if id == 0 || bandID == 0 {
		t.Fatalf("Resolve gave id=%d band=%d, both must be non-zero", id, bandID)
	}

	album, err := c.Details(ctx, typ, id, bandID)
	if err != nil {
		t.Fatalf("Details: %v", err)
	}
	if album.Title == "" || album.Artist == "" {
		t.Errorf("album missing title/artist: %+v", album)
	}
	if len(album.Tracks) == 0 {
		t.Fatal("album has no tracks")
	}

	for _, tr := range album.Tracks {
		if tr.TrackID == 0 || tr.Title == "" {
			t.Errorf("incomplete track: %+v", tr)
		}
		// Every field the playlist row persists must be populated here, or
		// tracks would be saved unplayable.
		if tr.BandID == 0 {
			t.Errorf("track %q has no band id, so it could never be streamed", tr.Title)
		}
		if tr.Streamable && tr.StreamURL == "" {
			t.Errorf("track %q claims to be streamable but carries no stream url", tr.Title)
		}
	}
}

func TestResolveTrackURL(t *testing.T) {
	ctx := skipIfShort(t)
	c := New()

	typ, id, bandID, err := c.Resolve(ctx,
		"https://aphextwin.bandcamp.com/track/minipops-67-1202-source-field-mix")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if typ != "t" {
		t.Fatalf("item type = %q, want %q", typ, "t")
	}

	track, err := c.Details(ctx, typ, id, bandID)
	if err != nil {
		t.Fatalf("Details: %v", err)
	}
	if len(track.Tracks) != 1 {
		t.Fatalf("track detail returned %d tracks, want 1", len(track.Tracks))
	}
}

// TestStreamURLIsPlayable checks the whole playback path: resolve a track id to
// a signed URL and confirm the CDN actually serves audio for it.
func TestStreamURLIsPlayable(t *testing.T) {
	ctx := skipIfShort(t)
	c := New()

	_, id, bandID, err := c.Resolve(ctx, "https://aphextwin.bandcamp.com/album/syro")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	album, err := c.Details(ctx, "a", id, bandID)
	if err != nil {
		t.Fatalf("Details: %v", err)
	}

	var first *Track
	for _, tr := range album.Tracks {
		if tr.Streamable {
			first = tr
			break
		}
	}
	if first == nil {
		t.Skip("no streamable track on this release")
	}

	url, err := c.StreamURL(ctx, first.TrackID, first.BandID)
	if err != nil {
		t.Fatalf("StreamURL: %v", err)
	}

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Range", "bytes=0-1023")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("fetching stream: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("stream returned %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "audio/") {
		t.Errorf("stream content-type = %q, want audio/*", ct)
	}
}

func TestFanAndWishlist(t *testing.T) {
	ctx := skipIfShort(t)
	c := New()

	fan, err := c.Fan(ctx, "john-john")
	if err != nil {
		t.Fatalf("Fan: %v", err)
	}
	if fan.FanID == 0 || fan.Username == "" {
		t.Fatalf("incomplete fan: %+v", fan)
	}

	page, err := c.Wishlist(ctx, fan.FanID, "", 5)
	if err != nil {
		t.Fatalf("Wishlist: %v", err)
	}
	for _, it := range page.Items {
		if it.TralbumID == 0 || it.BandID == 0 {
			t.Errorf("wishlist item missing ids, cannot be added: %+v", it)
		}
		if it.TralbumType != "a" && it.TralbumType != "t" {
			t.Errorf("unexpected wishlist item type %q", it.TralbumType)
		}
	}
}

// A full profile URL should work anywhere a bare username does.
func TestFanAcceptsProfileURL(t *testing.T) {
	ctx := skipIfShort(t)

	fan, err := New().Fan(ctx, "https://bandcamp.com/john-john")
	if err != nil {
		t.Fatalf("Fan: %v", err)
	}
	if fan.Username != "john-john" {
		t.Errorf("username = %q, want %q", fan.Username, "john-john")
	}
}

// The resolver must refuse non-Bandcamp hosts, otherwise it is an SSRF
// primitive pointed at whatever the caller names.
func TestResolveRejectsForeignHosts(t *testing.T) {
	c := New()
	ctx := context.Background()

	for _, bad := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost:9185/api/health",
		"https://evil.example.com/album/x",
		"https://bandcamp.com.evil.example.com/album/x",
		"file:///etc/passwd",
	} {
		if _, _, _, err := c.Resolve(ctx, bad); err == nil {
			t.Errorf("Resolve(%q) was allowed; it must be rejected", bad)
		}
	}
}
