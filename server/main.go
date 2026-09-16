package main

import (
	"context"
	"errors"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/api"
	"github.com/aeternitaas/b2bandcamp/server/internal/bandcamp"
	"github.com/aeternitaas/b2bandcamp/server/internal/config"
	"github.com/aeternitaas/b2bandcamp/server/internal/source"
	"github.com/aeternitaas/b2bandcamp/server/internal/store"
	"github.com/aeternitaas/b2bandcamp/server/internal/youtube"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[b2bandcamp] ")

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Open the SQL Database
	st, err := store.Open(ctx, cfg.DSN)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer st.Close()
	log.Printf("database ready")

	go purgeSessions(ctx, st)

	// Track sources are registered once, in order: registration order is match
	// order, so Bandcamp claims any link both it and a later provider could
	// handle. Adding an integration means adding a Register call here and
	// nothing else.
	bc := bandcamp.New()
	sources := source.NewRegistry()
	sources.Register(bandcamp.NewProvider(bc))

	// YouTube registers with or without a key: without one it still adds videos
	// by link through the keyless oEmbed endpoint, it just cannot report their
	// duration or expand a playlist link.
	yt := youtube.New(cfg.YouTubeAPIKey)
	sources.Register(yt)
	if yt.HasAPIKey() {
		log.Print("youtube: using the Data API (durations, playlist expansion)")
	} else {
		log.Print("youtube: no YOUTUBE_API_KEY, falling back to oEmbed (no durations)")
	}

	// Create an instance of the apiHandler which serves the bandcamp portion of the application
	apiHandler := api.NewServer(cfg, st, bc, sources).Routes()

	// Allocate and set the new, empty HTTP request multiplexer/router.
	mux := http.NewServeMux()
	mux.Handle("/api/", apiHandler)
	mux.Handle("/", spaHandler(cfg.WebDir))

	// Then, create and serve HTTP API server.
	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("listening on http://0.0.0.0:%s (serving %s)", cfg.Port, cfg.WebDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

func purgeSessions(ctx context.Context, st *store.Store) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if err := st.PurgeExpiredSessions(ctx); err != nil {
			log.Printf("purge sessions: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func init() {
	// Go's MIME table has no entry for .webmanifest, so http.FileServer would
	// sniff it as text/plain and browsers can reject the manifest on that
	// basis, making the app non-installable.
	if err := mime.AddExtensionType(".webmanifest", "application/manifest+json"); err != nil {
		log.Printf("registering webmanifest mime type: %v", err)
	}
}

// spaHandler serves the built React app, falling back to index.html so
// client-side routes like /p/12 and /s/<token> survive a page reload.
func spaHandler(root string) http.Handler {
	fileServer := http.FileServer(http.Dir(root))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(r.URL.Path)
		path := filepath.Join(root, clean)

		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			serveIndex(w, r, root)
			return
		}

		switch {
		case strings.HasPrefix(clean, "/assets/"):
			// Vite fingerprints these filenames, so they are safe to pin.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case clean == "/sw.js", clean == "/manifest.webmanifest":
			// Must never go stale or the app cannot be updated.
			w.Header().Set("Cache-Control", "no-cache")
		default:
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, root string) {
	index := filepath.Join(root, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.Error(w, "web app not built", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, index)
}
