package api

import (
	"net/http"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

// sourceInfo is one integration as a client sees it.
type sourceInfo struct {
	ID   string      `json:"id"`
	Name string      `json:"name"`
	Caps source.Caps `json:"caps"`
}

// handleListSources reports which integrations this server was built with and
// what each can do, so a client decides how to render and play a row from what
// the server says rather than from a hard-coded list. A row's "source" field
// names one of these ids.
//
// Unauthenticated on purpose: it describes the build, not any user's data, and
// the client needs it to render a public share link too.
func (s *Server) handleListSources(w http.ResponseWriter, r *http.Request) {
	_ = r
	providers := s.sources.All()
	out := make([]sourceInfo, 0, len(providers))
	for _, p := range providers {
		out = append(out, sourceInfo{ID: p.ID(), Name: p.Name(), Caps: p.Caps()})
	}
	// Cheap and effectively static, but not immutable: an operator can enable a
	// source by setting a key and restarting, so this must not be cached for
	// long.
	w.Header().Set("Cache-Control", "public, max-age=60")
	writeJSON(w, http.StatusOK, map[string]any{"sources": out})
}
