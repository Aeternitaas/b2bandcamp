package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aeternitaas/b2bandcamp/server/internal/api"
	"github.com/aeternitaas/b2bandcamp/server/internal/bandcamp"
	"github.com/aeternitaas/b2bandcamp/server/internal/config"
	"github.com/aeternitaas/b2bandcamp/server/internal/source"
	"github.com/aeternitaas/b2bandcamp/server/internal/youtube"
)

// TestPageCarriesSecurityHeaders guards the wiring in routes. For a long time
// only /api/ responses carried these headers. The browser reads the policy from
// the page response, so the app ran with no Content-Security-Policy and could
// be framed by any site. Every assertion here is about the page, not the API.
func TestPageCarriesSecurityHeaders(t *testing.T) {
	web := t.TempDir()
	mustWrite(t, filepath.Join(web, "index.html"), "<!doctype html><title>t</title>")
	mustWrite(t, filepath.Join(web, "assets", "app.js"), "export {}")

	// No extractor, so YouTube falls back to the embedded player. That is the
	// mode where the policy must name YouTube's origins.
	reg := source.NewRegistry()
	reg.Register(bandcamp.NewProvider(bandcamp.New()))
	yt := youtube.New("", youtube.WithExtractor("/nonexistent/yt-dlp"))
	reg.Register(yt)

	cfg := &config.Config{CookieName: "session", CSRFCookie: "csrf"}
	// No store: an unauthenticated request never reaches it.
	h := routes(api.NewServer(cfg, nil, bandcamp.New(), yt, reg), web)

	want := map[string]string{
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
		"X-Content-Type-Options": "nosniff",
	}
	cspMust := []string{
		"default-src 'self'",
		"frame-ancestors 'none'",
		"script-src 'self' https://www.youtube.com",
		"frame-src https://www.youtube-nocookie.com",
	}

	var pageCSP string
	for _, path := range []string{
		"/",             // the page itself
		"/playlists/12", // a client route, which also serves the page
		"/assets/app.js",
		"/api/health",
	} {
		t.Run(path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status %d", rec.Code)
			}

			for name, value := range want {
				if got := rec.Header().Get(name); got != value {
					t.Errorf("%s = %q, want %q", name, got, value)
				}
			}

			csp := rec.Header().Get("Content-Security-Policy")
			if csp == "" {
				t.Fatal("no Content-Security-Policy on this response")
			}
			for _, part := range cspMust {
				if !strings.Contains(csp, part) {
					t.Errorf("policy lacks %q:\n%s", part, csp)
				}
			}

			// The page and the API must send one policy. Two policies that
			// drift apart would make the API tests pass while the page broke.
			if path == "/" {
				pageCSP = csp
			} else if pageCSP != "" && csp != pageCSP {
				t.Errorf("policy differs from the page's:\n got %s\nwant %s", csp, pageCSP)
			}
		})
	}
}

func mustWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
