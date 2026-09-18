package youtube

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

// lookupStub answers videos.list and playlists.list with one known item each.
// Any other id comes back empty, which is how the Data API reports a private or
// removed item.
func lookupStub(t *testing.T) *Provider {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/videos", func(w http.ResponseWriter, r *http.Request) {
		items := []map[string]any{}
		if r.URL.Query().Get("id") == "aaaaaaaaaaa" {
			items = append(items, map[string]any{
				"id": "aaaaaaaaaaa",
				// An art track, so the lookup must name the artist the way an
				// add does.
				"snippet": map[string]any{
					"title":        "Tsunami",
					"channelTitle": "Muadeep - Topic",
					"thumbnails":   map[string]any{"high": map[string]any{"url": "https://i.ytimg.com/vi/aaaaaaaaaaa/hq.jpg"}},
				},
				"contentDetails": map[string]any{"duration": "PT3M33S"},
				"status":         map[string]any{"embeddable": true},
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
	})
	mux.HandleFunc("/playlists", func(w http.ResponseWriter, r *http.Request) {
		items := []map[string]any{}
		if r.URL.Query().Get("id") == "PLgood123" {
			items = append(items, map[string]any{
				"id": "PLgood123",
				"snippet": map[string]any{
					"title":        "Warm-up &amp; peak",
					"channelTitle": "Some DJ",
					"channelId":    "UCabcdefghijklmnopqrstuv",
				},
				"contentDetails": map[string]any{"itemCount": 42},
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	p := New("test-key", WithExtractor("/nonexistent/yt-dlp"))
	p.base = srv.URL
	return p
}

func TestLookupVideo(t *testing.T) {
	r, err := lookupStub(t).Lookup(context.Background(), "https://youtu.be/aaaaaaaaaaa?si=share")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if r.Kind != KindVideo || r.ID != "aaaaaaaaaaa" {
		t.Errorf("kind/id = %q/%q", r.Kind, r.ID)
	}
	// The preview must name the track exactly as the added row will.
	if r.Artist != "Muadeep" || r.Title != "Tsunami" {
		t.Errorf("artist/title = %q/%q, want Muadeep/Tsunami", r.Artist, r.Title)
	}
	if r.Duration != 213 || !r.Playable {
		t.Errorf("duration/playable = %v/%v", r.Duration, r.Playable)
	}
	// The client adds by this url, so it must be the tidy watch link.
	if r.URL != watchURL("aaaaaaaaaaa") {
		t.Errorf("url = %q", r.URL)
	}
}

func TestLookupPlaylist(t *testing.T) {
	r, err := lookupStub(t).Lookup(context.Background(), "https://www.youtube.com/playlist?list=PLgood123")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if r.Kind != KindPlaylist || r.ID != "PLgood123" {
		t.Errorf("kind/id = %q/%q", r.Kind, r.ID)
	}
	if r.Title != "Warm-up & peak" || r.ItemCount != 42 || r.Artist != "Some DJ" {
		t.Errorf("got %+v", r)
	}
}

func TestLookupMissingItems(t *testing.T) {
	p := lookupStub(t)
	for _, link := range []string{
		"https://youtu.be/bbbbbbbbbbb",
		"https://www.youtube.com/playlist?list=PLgone999",
	} {
		_, err := p.Lookup(context.Background(), link)
		if !errors.Is(err, source.ErrNotFound) {
			t.Errorf("%s: err = %v, want ErrNotFound", link, err)
			continue
		}
		// The client shows this text, so it must read as a sentence.
		if !strings.Contains(err.Error(), "private") {
			t.Errorf("%s: message does not explain the failure: %v", link, err)
		}
	}
}

func TestLookupRefusals(t *testing.T) {
	// No request may leave for these, so any request fails the test.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request to %s", r.URL.Path)
	}))
	t.Cleanup(srv.Close)

	noKey := New("", WithExtractor("/nonexistent/yt-dlp"))
	noKey.base = srv.URL
	if _, err := noKey.Lookup(context.Background(), "https://www.youtube.com/playlist?list=PLgood123"); !errors.Is(err, source.ErrUnsupported) {
		t.Errorf("playlist without a key: err = %v, want ErrUnsupported", err)
	}

	for _, input := range []string{"", "not a link", "https://aphextwin.bandcamp.com/album/syro"} {
		if _, err := noKey.Lookup(context.Background(), input); !errors.Is(err, source.ErrUnsupported) {
			t.Errorf("Lookup(%q): err = %v, want ErrUnsupported", input, err)
		}
	}
}
