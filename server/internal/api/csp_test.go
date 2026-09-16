package api

import (
	"testing"

	"github.com/aeternitaas/b2bandcamp/server/internal/bandcamp"
	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

// bandcampOnlyCSP is the policy this server sent before the header was
// assembled from providers. Registering only Bandcamp must still produce it
// exactly: art and audio break silently, in the browser, if it drifts.
const bandcampOnlyCSP = "default-src 'self'; " +
	"img-src 'self' data: https:; " +
	"media-src 'self' https://*.bcbits.com https://bandcamp.com blob:; " +
	"script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

func TestCSPWithOnlyBandcampIsUnchanged(t *testing.T) {
	reg := source.NewRegistry()
	reg.Register(bandcamp.NewProvider(bandcamp.New()))

	if got := buildCSP(reg.MergedCSP()); got != bandcampOnlyCSP {
		t.Errorf("policy drifted\n got: %s\nwant: %s", got, bandcampOnlyCSP)
	}
}

// TestCSPOmitsEmptyFrameSrc pins the reason the policy above has no frame-src:
// an absent directive falls back to default-src 'self', and emitting it
// explicitly would be a change for no reason.
func TestCSPOmitsEmptyFrameSrc(t *testing.T) {
	got := buildCSP(source.CSP{})
	if contains(got, "frame-src") {
		t.Errorf("frame-src emitted with no origins to put in it: %s", got)
	}
	if !contains(got, "frame-ancestors 'none'") {
		t.Error("frame-ancestors must survive, it is unrelated to frame-src")
	}
}

// TestCSPAddsProviderOrigins is the behaviour the whole change exists for: a
// source that needs an embedded player widens the policy by being registered,
// with no edit to the security headers.
func TestCSPAddsProviderOrigins(t *testing.T) {
	got := buildCSP(source.CSP{
		Media:   []string{"https://*.bcbits.com"},
		Script:  []string{"https://www.youtube.com"},
		Frame:   []string{"https://www.youtube-nocookie.com"},
		Connect: []string{"https://api.example.test"},
	})

	for _, want := range []string{
		"media-src 'self' https://*.bcbits.com blob:;",
		"script-src 'self' https://www.youtube.com;",
		"connect-src 'self' https://api.example.test;",
		"frame-src https://www.youtube-nocookie.com;",
	} {
		if !contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
