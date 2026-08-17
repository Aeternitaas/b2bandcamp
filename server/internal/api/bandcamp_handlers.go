package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/aeternitaas/b2b_helper/server/internal/bandcamp"
)

var bcLimiter = newLimiter(240, time.Minute)

// throttle keeps one client from turning this server into a Bandcamp scraper.
func (s *Server) throttle(w http.ResponseWriter, r *http.Request) bool {
	if !bcLimiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "slow down")
		return false
	}
	return true
}

func (s *Server) handleBCSearch(w http.ResponseWriter, r *http.Request) {
	if !s.throttle(w, r) {
		return
	}

	q := r.URL.Query().Get("q")
	filter := r.URL.Query().Get("type") // "" | b | a | t | f
	switch filter {
	case "", "b", "a", "t", "f":
	default:
		writeErr(w, http.StatusBadRequest, "type must be one of b, a, t, f")
		return
	}

	results, err := s.bc.Search(r.Context(), q, filter)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// handleBCResolve turns a pasted Bandcamp URL into full album or track detail
// in one round trip, which is what the "paste a link" input needs.
func (s *Server) handleBCResolve(w http.ResponseWriter, r *http.Request) {
	if !s.throttle(w, r) {
		return
	}

	var req struct {
		URL string `json:"url"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	typ, id, bandID, err := s.bc.Resolve(r.Context(), req.URL)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	detail, err := s.bc.Details(r.Context(), typ, id, bandID)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

// handleBCDetails backs album expansion in the wishlist sidebar.
func (s *Server) handleBCDetails(w http.ResponseWriter, r *http.Request) {
	if !s.throttle(w, r) {
		return
	}

	q := r.URL.Query()
	typ := q.Get("type")
	id, err1 := strconv.ParseInt(q.Get("id"), 10, 64)
	bandID, err2 := strconv.ParseInt(q.Get("band_id"), 10, 64)
	if err1 != nil || err2 != nil || id <= 0 || bandID <= 0 {
		writeErr(w, http.StatusBadRequest, "id and band_id are required")
		return
	}

	detail, err := s.bc.Details(r.Context(), typ, id, bandID)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleBCFan(w http.ResponseWriter, r *http.Request) {
	if !s.throttle(w, r) {
		return
	}

	fan, err := s.bc.Fan(r.Context(), r.URL.Query().Get("username"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "no Bandcamp user found with that name")
		return
	}
	writeJSON(w, http.StatusOK, fan)
}

func (s *Server) handleBCWishlist(w http.ResponseWriter, r *http.Request) {
	if !s.throttle(w, r) {
		return
	}

	q := r.URL.Query()
	fanID, err := strconv.ParseInt(q.Get("fan_id"), 10, 64)
	if err != nil || fanID <= 0 {
		writeErr(w, http.StatusBadRequest, "fan_id is required")
		return
	}
	count, _ := strconv.Atoi(q.Get("count"))

	page, err := s.bc.Wishlist(r.Context(), fanID, q.Get("token"), count)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// handleBCStream resolves a fresh signed preview URL and redirects the browser
// to it. Bandcamp expires these URLs, so they are looked up at play time rather
// than stored; redirecting rather than proxying means the audio bytes go
// straight from Bandcamp's CDN to the listener.
func (s *Server) handleBCStream(w http.ResponseWriter, r *http.Request) {
	if !s.throttle(w, r) {
		return
	}

	trackID, ok := pathInt(r, "trackId")
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid track id")
		return
	}
	bandID, err := strconv.ParseInt(r.URL.Query().Get("band_id"), 10, 64)
	if err != nil || bandID <= 0 {
		writeErr(w, http.StatusBadRequest, "band_id is required")
		return
	}

	url, err := s.bc.StreamURL(r.Context(), trackID, bandID)
	if err != nil {
		if err == bandcamp.ErrNotFound {
			writeErr(w, http.StatusNotFound, "this track is no longer streamable")
			return
		}
		fail(w, err)
		return
	}

	// Short cache so a seek or replay does not re-resolve, but well inside the
	// lifetime of the signature on the URL.
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.Redirect(w, r, url, http.StatusFound)
}
