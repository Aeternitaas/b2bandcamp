package api

import (
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/bandcamp"
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

	streamURL, err := s.bc.StreamURL(r.Context(), trackID, bandID)
	if err != nil {
		if errors.Is(err, bandcamp.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "this track is no longer streamable")
			return
		}
		fail(w, err)
		return
	}

	// Short cache so a seek or replay does not re-resolve, but well inside the
	// lifetime of the signature on the URL.
	w.Header().Set("Cache-Control", "private, max-age=60")
	http.Redirect(w, r, streamURL, http.StatusFound)
}

// handleBCAudio relays the audio bytes instead of redirecting to them.
//
// Web Audio cannot read samples from a cross-origin response that carries no
// CORS headers, and Bandcamp's CDN sends none — an <audio> element plays such a
// stream fine, but an AnalyserNode attached to it only ever sees silence. The
// waveform, BPM and key features therefore need the audio to arrive same-origin,
// which is what this endpoint provides. Normal playback still uses the redirect
// above, so this cost is only paid when analysis is actually requested.
func (s *Server) handleBCAudio(w http.ResponseWriter, r *http.Request) {
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

	upstream, err := s.bc.StreamURL(r.Context(), trackID, bandID)
	if err != nil {
		if errors.Is(err, bandcamp.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "this track is no longer streamable")
			return
		}
		fail(w, err)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		fail(w, err)
		return
	}
	// Forward Range so seeking still works through the proxy.
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}

	resp, err := audioClient.Do(req)
	if err != nil {
		log.Printf("audio proxy: %v", err)
		writeErr(w, http.StatusBadGateway, "could not reach Bandcamp")
		return
	}
	defer resp.Body.Close()

	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.WriteHeader(resp.StatusCode)

	if _, err := io.Copy(w, resp.Body); err != nil {
		// Normal when the listener seeks or skips mid-download.
		log.Printf("audio proxy: copy interrupted: %v", err)
	}
}

// audioClient has no overall timeout: a full track can take a while to relay,
// and the request context already bounds it to the client's connection.
var audioClient = &http.Client{}
