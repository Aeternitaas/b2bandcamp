package youtube

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubAPI stands in for the Data API so the keyed path is testable without
// credentials. It records what it was asked for, since batching and ordering
// are the parts most likely to go wrong.
type stubAPI struct {
	videoCalls    []string // the id= parameter of each videos.list call
	playlistPages int
}

func (s *stubAPI) handler(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/videos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("key") == "" {
			t.Error("videos.list called without a key")
		}
		ids := strings.Split(r.URL.Query().Get("id"), ",")
		s.videoCalls = append(s.videoCalls, r.URL.Query().Get("id"))

		type item struct {
			ID      string `json:"id"`
			Snippet struct {
				Title        string `json:"title"`
				ChannelTitle string `json:"channelTitle"`
				Thumbnails   map[string]struct {
					URL string `json:"url"`
				} `json:"thumbnails"`
			} `json:"snippet"`
			ContentDetails struct {
				Duration string `json:"duration"`
			} `json:"contentDetails"`
			Status struct {
				Embeddable bool `json:"embeddable"`
			} `json:"status"`
		}

		var items []item
		// Deliberately reversed: the API does not promise request order, and
		// the provider has to restore it.
		for i := len(ids) - 1; i >= 0; i-- {
			id := ids[i]
			if id == "missingvid0" {
				continue // an id the API declines to return at all
			}
			var it item
			it.ID = id
			it.Snippet.Title = "title-" + id
			it.Snippet.ChannelTitle = "channel-" + id
			it.Snippet.Thumbnails = map[string]struct {
				URL string `json:"url"`
			}{"high": {URL: "https://i.ytimg.com/vi/" + id + "/hq.jpg"}}
			it.ContentDetails.Duration = "PT3M33S"
			it.Status.Embeddable = id != "noembedvid0"
			items = append(items, it)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
	})

	mux.HandleFunc("/playlistItems", func(w http.ResponseWriter, r *http.Request) {
		s.playlistPages++
		type entry struct {
			ContentDetails struct {
				VideoID string `json:"videoId"`
			} `json:"contentDetails"`
		}
		mk := func(id string) entry {
			var e entry
			e.ContentDetails.VideoID = id
			return e
		}
		resp := map[string]any{}
		if r.URL.Query().Get("pageToken") == "" {
			resp["items"] = []entry{mk("aaaaaaaaaaa"), mk("bbbbbbbbbbb")}
			resp["nextPageToken"] = "page2"
		} else {
			resp["items"] = []entry{mk("ccccccccccc")}
		}
		_ = json.NewEncoder(w).Encode(resp)
	})

	return mux
}

func newStubProvider(t *testing.T) (*Provider, *stubAPI) {
	t.Helper()
	stub := &stubAPI{}
	srv := httptest.NewServer(stub.handler(t))
	t.Cleanup(srv.Close)

	p := New("test-key")
	p.base = srv.URL
	return p, stub
}

func TestDataAPIPreservesRequestOrder(t *testing.T) {
	p, _ := newStubProvider(t)
	ids := []string{"aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"}

	got, err := p.viaDataAPI(context.Background(), ids)
	if err != nil {
		t.Fatalf("viaDataAPI: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d tracks, want 3", len(got))
	}
	// The stub answers in reverse; the order the caller asked for is the order
	// tracks land in the playlist, so it has to be restored.
	for i, want := range ids {
		if got[i].SourceID != want {
			t.Errorf("position %d: got %q, want %q", i, got[i].SourceID, want)
		}
	}
	if got[0].Duration != 213 {
		t.Errorf("duration = %v, want 213 from PT3M33S", got[0].Duration)
	}
	if got[0].Title != "title-aaaaaaaaaaa" || got[0].Artist != "channel-aaaaaaaaaaa" {
		t.Errorf("metadata not mapped: %+v", got[0])
	}
	if got[0].PageURL != watchURL("aaaaaaaaaaa") {
		t.Errorf("page url = %q", got[0].PageURL)
	}
}

func TestDataAPIMarksNonEmbeddableUnplayable(t *testing.T) {
	p, _ := newStubProvider(t)
	got, err := p.viaDataAPI(context.Background(), []string{"noembedvid0", "aaaaaaaaaaa"})
	if err != nil {
		t.Fatalf("viaDataAPI: %v", err)
	}
	if got[0].Playable {
		t.Error("a video the uploader blocked from embedding must not be Playable")
	}
	if !got[1].Playable {
		t.Error("a normal video must be Playable")
	}
}

func TestDataAPISkipsIDsTheAPIOmits(t *testing.T) {
	p, _ := newStubProvider(t)
	got, err := p.viaDataAPI(context.Background(), []string{"missingvid0", "aaaaaaaaaaa"})
	if err != nil {
		t.Fatalf("viaDataAPI: %v", err)
	}
	if len(got) != 1 || got[0].SourceID != "aaaaaaaaaaa" {
		t.Errorf("a deleted or private video should simply be absent, got %+v", got)
	}
}

// Batching is what keeps quota use to one unit per 50 videos.
func TestDataAPIBatchesFifty(t *testing.T) {
	p, stub := newStubProvider(t)
	ids := make([]string, 120)
	for i := range ids {
		ids[i] = string(rune('a'+i/26)) + "aaaaaaaaa" + string(rune('a'+i%26))
	}
	if _, err := p.viaDataAPI(context.Background(), ids); err != nil {
		t.Fatalf("viaDataAPI: %v", err)
	}
	if len(stub.videoCalls) != 3 {
		t.Errorf("120 ids made %d calls, want 3 batches of at most 50", len(stub.videoCalls))
	}
	for _, call := range stub.videoCalls {
		if n := len(strings.Split(call, ",")); n > maxIDsPerCall {
			t.Errorf("a batch carried %d ids, over the %d limit", n, maxIDsPerCall)
		}
	}
}

func TestPlaylistExpansionFollowsPages(t *testing.T) {
	p, stub := newStubProvider(t)
	ids, err := p.playlistVideoIDs(context.Background(), "PLtest123")
	if err != nil {
		t.Fatalf("playlistVideoIDs: %v", err)
	}
	want := []string{"aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"}
	if len(ids) != len(want) {
		t.Fatalf("got %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Errorf("position %d: got %q, want %q", i, ids[i], want[i])
		}
	}
	if stub.playlistPages != 2 {
		t.Errorf("followed %d pages, want 2", stub.playlistPages)
	}
}

// An API error must surface, not be reported as an empty playlist.
func TestDataAPISurfacesAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"code": 403, "message": "quotaExceeded"},
		})
	}))
	t.Cleanup(srv.Close)

	p := New("test-key")
	p.base = srv.URL
	_, err := p.viaDataAPI(context.Background(), []string{"aaaaaaaaaaa"})
	if err == nil {
		t.Fatal("a quota error must not look like success")
	}
	if !strings.Contains(err.Error(), "quotaExceeded") {
		t.Errorf("error should name the cause, got %v", err)
	}
}

// The key travels in the query string, so it must never reach an error message.
func TestErrorsDoNotLeakTheAPIKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	p := New("super-secret-key")
	p.base = srv.URL
	_, err := p.viaDataAPI(context.Background(), []string{"aaaaaaaaaaa"})
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "super-secret-key") {
		t.Errorf("the api key leaked into an error: %v", err)
	}
}
