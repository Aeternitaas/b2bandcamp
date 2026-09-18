package youtube

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseChannelURL(t *testing.T) {
	const id = "UCuAXFkgsw1L7xaCfnd5JJOw" // 24 chars, "UC" + 22

	cases := []struct {
		in          string
		param, want string
		ok          bool
	}{
		{"https://www.youtube.com/channel/" + id, "id", id, true},
		{"https://youtube.com/@rickastley", "forHandle", "@rickastley", true},
		{"youtube.com/@rickastley", "forHandle", "@rickastley", true},
		{"https://www.youtube.com/user/RickAstleyVEVO", "forUsername", "RickAstleyVEVO", true},
		{"https://www.youtube.com/c/RickAstley", "forUsername", "RickAstley", true},
		// A video link is not a channel link, and must not be read as one.
		{"https://youtu.be/dQw4w9WgXcQ", "", "", false},
		{"https://example.test/@someone", "", "", false},
		// A bare handle is resolved by the caller, not here.
		{"@rickastley", "", "", false},
		// A channel path that is not a channel id must not be passed to the API
		// as if it were one.
		{"https://www.youtube.com/channel/../../etc", "", "", false},
	}

	for _, c := range cases {
		param, value, ok := parseChannelURL(c.in)
		if ok != c.ok || param != c.param || value != c.want {
			t.Errorf("parseChannelURL(%q) = (%q, %q, %v), want (%q, %q, %v)",
				c.in, param, value, ok, c.param, c.want, c.ok)
		}
	}
}

func TestUploadsPlaylistID(t *testing.T) {
	if got := uploadsPlaylistID("UCuAXFkgsw1L7xaCfnd5JJOw"); got != "UUuAXFkgsw1L7xaCfnd5JJOw" {
		t.Errorf("uploads playlist = %q", got)
	}
	// Anything that is not a channel id has no derivable uploads playlist, and
	// guessing one would send a malformed id to the API.
	if got := uploadsPlaylistID("PLabc"); got != "" {
		t.Errorf("uploads playlist for a non-channel id = %q, want empty", got)
	}
}

// Search mixes three kinds of result in one list and has to read each one's id
// out of a different field, so this checks all three at once.
func TestSearchMapsEveryKind(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/search", func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("type"); got != "video,playlist,channel" {
			t.Errorf("type = %q, want all three", got)
		}
		_, _ = w.Write([]byte(`{"items":[
			{"id":{"videoId":"dQw4w9WgXcQ"},
			 "snippet":{"title":"Rick Astley - Never Gonna Give You Up &amp; More",
			            "channelTitle":"Rick Astley","channelId":"UC1","thumbnails":{"high":{"url":"https://i.ytimg.test/v.jpg"}}}},
			{"id":{"playlistId":"PL123"},
			 "snippet":{"title":"Best of &#39;80s","channelTitle":"Someone","channelId":"UC2","thumbnails":{}}},
			{"id":{"channelId":"UC3"},
			 "snippet":{"title":"A Channel","channelTitle":"A Channel","channelId":"UC3","thumbnails":{}}}
		]}`))
	})
	// fillDurations follows every search over the video ids it found.
	mux.HandleFunc("/videos", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []map[string]any{{
			"id":             "dQw4w9WgXcQ",
			"snippet":        map[string]any{"title": "Rick Astley - Never Gonna Give You Up", "channelTitle": "Rick Astley"},
			"contentDetails": map[string]any{"duration": "PT3M33S"},
			"status":         map[string]any{"embeddable": true},
		}}})
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	p := New("test-key")
	p.base = srv.URL

	results, err := p.Search(context.Background(), "rick astley", "")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("got %d results, want 3", len(results))
	}

	video := results[0]
	if video.Kind != KindVideo || video.ID != "dQw4w9WgXcQ" {
		t.Errorf("video result = %+v", video)
	}
	// search.list escapes titles where videos.list does not, and the split into
	// artist and track must happen on the decoded text.
	if video.Artist != "Rick Astley" || video.Title != "Never Gonna Give You Up & More" {
		t.Errorf("artist/title = %q / %q", video.Artist, video.Title)
	}
	if video.Duration != 213 {
		t.Errorf("duration = %v, want 213", video.Duration)
	}

	if results[1].Kind != KindPlaylist || results[1].Title != "Best of '80s" {
		t.Errorf("playlist result = %+v", results[1])
	}
	if results[2].Kind != "c" || results[2].ID != "UC3" {
		t.Errorf("channel result = %+v", results[2])
	}

	// The second identical query must be answered from the cache, because one
	// search costs a hundredth of the daily quota.
	srv.Close()
	again, err := p.Search(context.Background(), "RICK ASTLEY", "")
	if err != nil || len(again) != 3 {
		t.Errorf("a repeated query must come from the cache, got %d results, %v", len(again), err)
	}
}

// Without a key every catalog call must say what to set rather than failing
// somewhere deeper with something unrelated.
func TestCatalogNeedsAKey(t *testing.T) {
	p := New("")

	if _, err := p.Search(context.Background(), "anything", ""); err == nil {
		t.Error("search without a key must be refused")
	}
	if _, err := p.LookupChannel(context.Background(), "@someone"); err == nil {
		t.Error("channel lookup without a key must be refused")
	}
	if _, _, err := p.Playlists(context.Background(), "UCuAXFkgsw1L7xaCfnd5JJOw", ""); err == nil {
		t.Error("playlist listing without a key must be refused")
	}
}
