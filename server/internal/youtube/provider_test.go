package youtube

import (
	"context"
	"testing"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

func TestParseURL(t *testing.T) {
	const id = "dQw4w9WgXcQ"

	video := []string{
		"https://www.youtube.com/watch?v=" + id,
		"https://youtube.com/watch?v=" + id,
		"http://www.youtube.com/watch?v=" + id,
		"youtube.com/watch?v=" + id, // scheme optional, as for Bandcamp links
		"https://youtu.be/" + id,
		"https://youtu.be/" + id + "?t=42",
		"https://www.youtube.com/shorts/" + id,
		"https://www.youtube.com/embed/" + id,
		"https://www.youtube.com/live/" + id,
		"https://m.youtube.com/watch?v=" + id,
		"https://music.youtube.com/watch?v=" + id,
		// A video watched inside a playlist is still that video.
		"https://www.youtube.com/watch?v=" + id + "&list=PLabcdef123",
	}
	for _, u := range video {
		kind, got, ok := parseURL(u)
		if !ok || kind != KindVideo || got != id {
			t.Errorf("parseURL(%q) = (%q, %q, %v), want (%q, %q, true)", u, kind, got, ok, KindVideo, id)
		}
	}

	kind, got, ok := parseURL("https://www.youtube.com/playlist?list=PLabcdef123")
	if !ok || kind != KindPlaylist || got != "PLabcdef123" {
		t.Errorf("playlist url = (%q, %q, %v), want (p, PLabcdef123, true)", kind, got, ok)
	}

	rejected := []string{
		"",
		"https://aphextwin.bandcamp.com/album/syro",
		"https://example.test/watch?v=" + id,
		"https://www.youtube.com/watch?v=tooshort",
		"https://www.youtube.com/watch?v=waytoolongforanid",
		"https://www.youtube.com/watch?v=bad!chars++",
		"https://www.youtube.com/",
		"https://www.youtube.com/@somechannel",
		"https://notyoutube.com/watch?v=" + id,
		// A lookalike host must not be claimed.
		"https://youtube.com.evil.test/watch?v=" + id,
	}
	for _, u := range rejected {
		if _, _, ok := parseURL(u); ok {
			t.Errorf("parseURL(%q) accepted a url it should not", u)
		}
	}
}

func TestParseISODuration(t *testing.T) {
	cases := map[string]float64{
		"PT3M33S":   213,
		"PT1H2M3S":  3723,
		"PT45S":     45,
		"PT10M":     600,
		"PT1H":      3600,
		"P0D":       0, // a live stream
		"":          0,
		"garbage":   0,
		"PT1H30M2S": 5402,
	}
	for in, want := range cases {
		if got := parseISODuration(in); got != want {
			t.Errorf("parseISODuration(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestMatchAndCaps(t *testing.T) {
	p := New("")

	if !p.Match("https://youtu.be/dQw4w9WgXcQ") {
		t.Error("a youtu.be link must match")
	}
	if p.Match("https://aphextwin.bandcamp.com/album/syro") {
		t.Error("a Bandcamp link must not be claimed by YouTube")
	}

	caps := p.Caps()
	if caps.Stream {
		t.Error("this server must never claim it can stream YouTube audio")
	}
	if caps.Analyze {
		t.Error("analysis needs same-origin samples, which YouTube never provides")
	}
	if !caps.Embed {
		t.Error("playback is the embedded player, so Embed must be set")
	}

	// The optional streaming interface must not be satisfied: implementing it
	// would invite a caller to try to relay the audio.
	if _, isStreamer := any(p).(source.Streamer); isStreamer {
		t.Error("Provider must not implement source.Streamer")
	}
}

// Resolve is pure, so it is fully testable with no key and no network.
func TestResolveNeedsNoNetwork(t *testing.T) {
	p := New("")
	ref, err := p.Resolve(context.Background(), "https://youtu.be/dQw4w9WgXcQ")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if ref.Source != SourceID || ref.Kind != KindVideo || ref.ID != "dQw4w9WgXcQ" {
		t.Errorf("ref = %+v", ref)
	}
	if ref.Extra != "" {
		t.Errorf("YouTube needs no extra handle, got %q", ref.Extra)
	}

	if _, err := p.Resolve(context.Background(), "https://example.test/x"); err == nil {
		t.Error("a foreign url must be rejected")
	}
}

// Without a key a playlist link cannot be expanded, and saying so plainly beats
// adding nothing and reporting success.
func TestPlaylistWithoutKeyIsRefused(t *testing.T) {
	_, err := New("").Resolve(context.Background(), "https://www.youtube.com/playlist?list=PLabc123")
	if err == nil {
		t.Fatal("expanding a playlist without a key must fail")
	}

	// With a key it gets as far as the network instead of refusing up front.
	ref, err := New("fake-key").Resolve(context.Background(), "https://www.youtube.com/playlist?list=PLabc123")
	if err != nil {
		t.Fatalf("with a key, Resolve should succeed: %v", err)
	}
	if ref.Kind != KindPlaylist {
		t.Errorf("kind = %q, want %q", ref.Kind, KindPlaylist)
	}
}

func TestBestThumbnailPrefersLargest(t *testing.T) {
	type thumb = struct {
		URL string `json:"url"`
	}
	got := bestThumbnail(map[string]thumb{
		"default": {URL: "small.jpg"},
		"high":    {URL: "high.jpg"},
		"maxres":  {URL: "max.jpg"},
	})
	if got != "max.jpg" {
		t.Errorf("got %q, want the largest available", got)
	}

	if got := bestThumbnail(map[string]thumb{"default": {URL: "only.jpg"}}); got != "only.jpg" {
		t.Errorf("got %q, want the only one present", got)
	}
	if got := bestThumbnail(map[string]thumb{}); got != "" {
		t.Errorf("got %q, want empty when there are none", got)
	}
}
