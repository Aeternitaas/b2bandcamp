package api

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
	"github.com/aeternitaas/b2bandcamp/server/internal/youtube"
)

// The YouTube endpoints, matching what /api/bc/ does for Bandcamp: catalog
// search, browsing an account, and getting at the audio.
//
// They sit here rather than behind the neutral source contract for the same
// reason Bandcamp's do. The registry covers what every source must do, which is
// turn a link into rows. Searching a catalog and walking somebody's playlists
// are not that, and an interface for them would have one implementation each.

// ytLimiter is separate from the Bandcamp bucket on purpose. One shared bucket
// would let a burst of YouTube browsing use up an allowance that Bandcamp
// playback also draws on, and the two have nothing to do with each other.
var ytLimiter = newLimiter(240, time.Minute)

func (s *Server) throttleYT(w http.ResponseWriter, r *http.Request) bool {
	if !ytLimiter.allow(s.clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "slow down")
		return false
	}
	return true
}

// failYT reports a provider error. An unconfigured instance is the common case
// and is not a server fault, so it answers 400 with the sentence that says what
// to set, rather than a 500 and a log line nobody reads.
func failYT(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, source.ErrUnsupported):
		writeErr(w, http.StatusBadRequest, userMessage(err))
	case errors.Is(err, source.ErrNotFound):
		writeErr(w, http.StatusNotFound, userMessage(err))
	default:
		log.Printf("youtube: %v", err)
		writeErr(w, http.StatusBadGateway, "could not reach YouTube")
	}
}

// userMessage strips the sentinel a provider wrapped for errors.Is to match on.
// Wrapping puts the sentinel's own text at the front, and "source: not found:
// youtube: that video is unavailable" is a log line, not a sentence to show
// somebody. What follows it was written for a person, and is kept as-is.
func userMessage(err error) string {
	msg := err.Error()
	for _, sentinel := range []error{source.ErrNotFound, source.ErrUnsupported} {
		msg = strings.TrimPrefix(msg, sentinel.Error()+": ")
	}
	return msg
}

// handleYTSearch backs the YouTube half of the add-music popup.
func (s *Server) handleYTSearch(w http.ResponseWriter, r *http.Request) {
	if !s.throttleYT(w, r) {
		return
	}

	kind := r.URL.Query().Get("kind") // "" | v | p | c
	switch kind {
	case "", "v", "p", "c":
	default:
		writeErr(w, http.StatusBadRequest, "kind must be one of v, p, c")
		return
	}

	results, err := s.yt.Search(r.Context(), r.URL.Query().Get("q"), kind)
	if err != nil {
		failYT(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// handleYTChannel resolves whatever was typed into the "browse an account"
// field: a handle, a channel link, or a display name.
func (s *Server) handleYTChannel(w http.ResponseWriter, r *http.Request) {
	if !s.throttleYT(w, r) {
		return
	}

	channel, err := s.yt.LookupChannel(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		failYT(w, err)
		return
	}
	writeJSON(w, http.StatusOK, channel)
}

// handleYTPlaylists lists one channel's public playlists.
func (s *Server) handleYTPlaylists(w http.ResponseWriter, r *http.Request) {
	if !s.throttleYT(w, r) {
		return
	}

	q := r.URL.Query()
	results, next, err := s.yt.Playlists(r.Context(), q.Get("channel_id"), q.Get("page_token"))
	if err != nil {
		failYT(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"results":         results,
		"next_page_token": next,
	})
}

// handleYTPlaylist expands one page of a playlist into rows shaped like the
// ones an add produces, so the client can list, preview and add from it with
// the code it already has.
func (s *Server) handleYTPlaylist(w http.ResponseWriter, r *http.Request) {
	if !s.throttleYT(w, r) {
		return
	}

	q := r.URL.Query()
	results, next, err := s.yt.PlaylistTracks(r.Context(), q.Get("id"), q.Get("page_token"))
	if err != nil {
		failYT(w, err)
		return
	}
	// Keyed "results" like the other two: all three return the same rows, and a
	// client that renders one renders all of them.
	writeJSON(w, http.StatusOK, map[string]any{
		"results":         results,
		"next_page_token": next,
	})
}

// handleYTLookup describes a pasted YouTube link and adds nothing.
//
// Adding a link straight from the paste made one paste add a video twice while
// music played, and it asked nobody first. The client now shows this result
// and adds only when a person presses Add.
func (s *Server) handleYTLookup(w http.ResponseWriter, r *http.Request) {
	if !s.throttleYT(w, r) {
		return
	}
	result, err := s.yt.Lookup(r.Context(), r.URL.Query().Get("url"))
	if err != nil {
		failYT(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": result})
}

// handleYTStream relays a video's audio for playback.
//
// It relays rather than redirecting, which is where this differs from
// /api/bc/stream. Bandcamp signs a url the listener's own browser may fetch;
// the url an extractor resolves here is tied to the client that resolved it, so
// handing it to a browser gets a 403 often enough to be useless.
func (s *Server) handleYTStream(w http.ResponseWriter, r *http.Request) {
	if !s.throttleYT(w, r) {
		return
	}

	videoID := r.PathValue("videoId")
	upstream, err := s.yt.StreamURL(r.Context(), source.Ref{
		Source: youtube.SourceID,
		Kind:   youtube.KindVideo,
		ID:     videoID,
	})
	if err != nil {
		failYT(w, err)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, upstream, nil)
	if err != nil {
		fail(w, err)
		return
	}
	// Forward Range so seeking still works through the relay.
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}

	resp, err := audioClient.Do(req)
	if err != nil {
		log.Printf("youtube stream: %v", err)
		writeErr(w, http.StatusBadGateway, "could not reach YouTube")
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
		log.Printf("youtube stream: copy interrupted: %v", err)
	}
}

// handleYTAudio serves the whole audio file, same-origin, for analysis.
//
// The file is downloaded to a temporary directory, served, and deleted before
// this returns: nothing is cached on disk between requests. That costs a
// download per analysis, which is the right trade, because analysis happens
// once per track for every user of the instance and is then cached in the
// database by tempo and key, where audio kept on disk would accumulate for a
// feature that has already finished with it.
//
// Analysis needs the file rather than the relay above for two reasons: Web
// Audio decodes a whole buffer rather than reading progressively, and a relayed
// signed url is throttled hard enough that fetching a whole track through it
// frequently stalls.
func (s *Server) handleYTAudio(w http.ResponseWriter, r *http.Request) {
	if !s.throttleYT(w, r) {
		return
	}

	path, cleanup, err := s.yt.Download(r.Context(), r.PathValue("videoId"))
	defer cleanup()
	if err != nil {
		failYT(w, err)
		return
	}

	file, err := os.Open(path)
	if err != nil {
		fail(w, err)
		return
	}
	defer file.Close()

	// ServeContent handles Range and the headers that go with it. The name is
	// only used to pick a Content-Type, which is why the extension the
	// extractor chose is worth keeping on the temporary file.
	//
	// The zero modtime suppresses Last-Modified and any conditional handling:
	// this file was made for this request and will not exist for the next one,
	// so there is nothing for a client to revalidate against.
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, path, time.Time{}, file)
}
