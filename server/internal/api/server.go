package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/aeternitaas/b2bandcamp/server/internal/bandcamp"
	"github.com/aeternitaas/b2bandcamp/server/internal/config"
	"github.com/aeternitaas/b2bandcamp/server/internal/source"
	"github.com/aeternitaas/b2bandcamp/server/internal/store"
	"github.com/aeternitaas/b2bandcamp/server/internal/youtube"
)

type Server struct {
	cfg *config.Config
	st  *store.Store
	// bc backs the Bandcamp-only endpoints, catalog search, wishlist and fan
	// lookup, the audio relay. Those are what being the first-class source
	// means, and routing them through the neutral contract would produce an
	// interface with exactly one implementation.
	bc *bandcamp.Client
	// yt backs the YouTube-only endpoints, for the same reason bc does: catalog
	// search, browsing an account, and getting at the audio are things one
	// source does, not things every source must.
	yt      *youtube.Provider
	sources *source.Registry
	hub     *playlistHub
	// csp is assembled from the registered sources once, at startup, so the
	// request path only ever writes a constant.
	csp string
}

func NewServer(cfg *config.Config, st *store.Store, bc *bandcamp.Client, yt *youtube.Provider, sources *source.Registry) *Server {
	return &Server{
		cfg: cfg, st: st, bc: bc, yt: yt, sources: sources,
		hub: newPlaylistHub(),
		csp: buildCSP(sources.MergedCSP()),
	}
}

// Routes builds the API mux. Static file serving is layered on top in main.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// auth
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/auth/me", s.handleMe)
	mux.HandleFunc("POST /api/auth/tokens", s.handleCreateAPIToken)
	mux.HandleFunc("PATCH /api/account", s.handleUpdateAccount)
	mux.HandleFunc("GET /api/account/tokens", s.handleListAPITokens)
	mux.HandleFunc("DELETE /api/account/tokens/{id}", s.handleDeleteAPIToken)
	mux.HandleFunc("POST /api/account/bandcamp", s.handleLinkBandcamp)
	mux.HandleFunc("DELETE /api/account/bandcamp", s.handleUnlinkBandcamp)
	mux.HandleFunc("PUT /api/account/avatar", s.handleSetAvatar)
	mux.HandleFunc("GET /api/account/shares", s.handleListShares)

	// playlists
	mux.HandleFunc("GET /api/playlists", s.handleListPlaylists)
	mux.HandleFunc("POST /api/playlists", s.handleCreatePlaylist)
	mux.HandleFunc("POST /api/playlists/reorder", s.handleReorderPlaylists)
	mux.HandleFunc("GET /api/playlists/{id}", s.handleGetPlaylist)
	mux.HandleFunc("PATCH /api/playlists/{id}", s.handleUpdatePlaylist)
	mux.HandleFunc("DELETE /api/playlists/{id}", s.handleDeletePlaylist)

	// tracks
	mux.HandleFunc("POST /api/playlists/{id}/tracks", s.handleAddTracks)
	mux.HandleFunc("POST /api/playlists/{id}/tracks/reorder", s.handleReorderTracks)
	mux.HandleFunc("POST /api/playlists/{id}/tracks/delete", s.handleDeleteTracks)
	mux.HandleFunc("PATCH /api/playlists/{id}/tracks/{trackId}", s.handleUpdateTrack)
	mux.HandleFunc("DELETE /api/playlists/{id}/tracks/{trackId}", s.handleDeleteTrack)
	mux.HandleFunc("GET /api/playlists/{id}/events", s.handleTrackEvents)

	// sharing + collaborators
	mux.HandleFunc("GET /api/playlists/{id}/share", s.handleGetShareLink)
	mux.HandleFunc("POST /api/playlists/{id}/share", s.handleCreateShareLink)
	mux.HandleFunc("DELETE /api/playlists/{id}/share", s.handleRevokeShareLink)
	mux.HandleFunc("GET /api/playlists/{id}/collaborators", s.handleListCollaborators)
	mux.HandleFunc("POST /api/playlists/{id}/collaborators", s.handleAddCollaborator)
	mux.HandleFunc("DELETE /api/playlists/{id}/collaborators/{userId}", s.handleRemoveCollaborator)
	mux.HandleFunc("GET /api/share/{token}", s.handleResolveShare)
	mux.HandleFunc("GET /api/users/search", s.handleSearchUsers)
	mux.HandleFunc("GET /api/users/{username}/profile", s.handleUserProfile)

	// integrations
	mux.HandleFunc("GET /api/sources", s.handleListSources)

	// bandcamp
	mux.HandleFunc("GET /api/bc/search", s.handleBCSearch)
	mux.HandleFunc("POST /api/bc/resolve", s.handleBCResolve)
	mux.HandleFunc("GET /api/bc/details", s.handleBCDetails)
	mux.HandleFunc("GET /api/bc/fan", s.handleBCFan)
	mux.HandleFunc("GET /api/bc/wishlist", s.handleBCWishlist)
	mux.HandleFunc("GET /api/bc/stream/{trackId}", s.handleBCStream)
	mux.HandleFunc("GET /api/bc/audio/{trackId}", s.handleBCAudio)

	// youtube
	mux.HandleFunc("GET /api/yt/search", s.handleYTSearch)
	mux.HandleFunc("GET /api/yt/lookup", s.handleYTLookup)
	mux.HandleFunc("GET /api/yt/channel", s.handleYTChannel)
	mux.HandleFunc("GET /api/yt/playlists", s.handleYTPlaylists)
	mux.HandleFunc("GET /api/yt/playlist", s.handleYTPlaylist)
	mux.HandleFunc("GET /api/yt/stream/{videoId}", s.handleYTStream)
	mux.HandleFunc("GET /api/yt/audio/{videoId}", s.handleYTAudio)

	// cached audio analysis. The {trackId} pair are the original routes, from
	// when Bandcamp was the only source; they still resolve, as that source.
	mux.HandleFunc("GET /api/analysis/version", s.handleAnalysisVersion)
	mux.HandleFunc("GET /api/analysis/{source}/{sourceId}", s.handleGetAnalysis)
	mux.HandleFunc("PUT /api/analysis/{source}/{sourceId}", s.handleSaveAnalysis)
	mux.HandleFunc("GET /api/analysis/{trackId}", s.handleGetAnalysis)
	mux.HandleFunc("PUT /api/analysis/{trackId}", s.handleSaveAnalysis)

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	return s.withMiddleware(mux)
}

// ---------- response helpers ----------

type apiError struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, apiError{Error: msg})
}

// fail maps internal errors to a response, logging the detail but returning a
// generic message so database errors never reach the client.
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, bandcamp.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not found")
	default:
		log.Printf("internal error: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

func pathInt(r *http.Request, name string) (int64, bool) {
	v, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil || v <= 0 {
		return 0, false
	}
	return v, true
}

func trimTo(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
