package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/aeternitaas/b2bandcamp/server/internal/store"
)

const (
	maxPlaylistTracks = 2000
	maxAddPerRequest  = 300
)

type playlistResponse struct {
	*store.Playlist
	Tracks []*store.Track `json:"tracks,omitempty"`
}

func (s *Server) handleListPlaylists(w http.ResponseWriter, r *http.Request) {
	u := s.requireUser(w, r)
	if u == nil {
		return
	}
	list, err := s.st.ListPlaylistsForUser(r.Context(), u.ID)
	if err != nil {
		fail(w, err)
		return
	}
	if list == nil {
		list = []*store.Playlist{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"playlists": list})
}

func (s *Server) handleCreatePlaylist(w http.ResponseWriter, r *http.Request) {
	u := s.requireUser(w, r)
	if u == nil {
		return
	}

	var req struct {
		Title       string `json:"title"`
		Description string `json:"description"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	title := trimTo(req.Title, 200)
	if title == "" {
		title = "Untitled playlist"
	}

	p, err := s.st.CreatePlaylist(r.Context(), u.ID, title, trimTo(req.Description, 2000))
	if err != nil {
		fail(w, err)
		return
	}
	p.Role = "owner"
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) handleGetPlaylist(w http.ResponseWriter, r *http.Request) {
	p, pr, ok := s.requireView(w, r)
	if !ok {
		return
	}
	tracks, err := s.st.Tracks(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}
	p.Role = pr.role
	writeJSON(w, http.StatusOK, playlistResponse{Playlist: p, Tracks: tracks})
}

func (s *Server) handleUpdatePlaylist(w http.ResponseWriter, r *http.Request) {
	// Title, description, cover and the wishlist source are collaborative
	// edits; visibility is not, only the owner controls who gets in.
	p, pr, ok := s.requireEdit(w, r)
	if !ok {
		return
	}

	var req struct {
		Title       *string `json:"title"`
		Description *string `json:"description"`
		CoverURL    *string `json:"cover_url"`
		Visibility  *string `json:"visibility"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	up := store.PlaylistUpdate{}
	if req.Title != nil {
		t := trimTo(*req.Title, 200)
		if t == "" {
			writeErr(w, http.StatusBadRequest, "title cannot be empty")
			return
		}
		up.Title = &t
	}
	if req.Description != nil {
		d := trimTo(*req.Description, 2000)
		up.Description = &d
	}
	if req.CoverURL != nil {
		c := trimTo(*req.CoverURL, 500)
		if c != "" && !isSafeImageURL(c) {
			writeErr(w, http.StatusBadRequest, "cover art must be an https image url")
			return
		}
		up.CoverURL = &c
	}
	if req.Visibility != nil {
		if !pr.owner {
			writeErr(w, http.StatusForbidden, "only the owner can change who can see this playlist")
			return
		}
		v := store.Visibility(*req.Visibility)
		if !v.Valid() {
			writeErr(w, http.StatusBadRequest, "visibility must be private, shared or public")
			return
		}
		up.Visibility = &v
	}
	if err := s.st.UpdatePlaylist(r.Context(), p.ID, up); err != nil {
		fail(w, err)
		return
	}

	updated, err := s.st.PlaylistByID(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}
	updated.Role = pr.role
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeletePlaylist(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireOwner(w, r)
	if !ok {
		return
	}
	if err := s.st.DeletePlaylist(r.Context(), p.ID); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleReorderPlaylists(w http.ResponseWriter, r *http.Request) {
	u := s.requireUser(w, r)
	if u == nil {
		return
	}

	var req struct {
		IDs []int64 `json:"ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.IDs) > 1000 {
		writeErr(w, http.StatusBadRequest, "too many playlists")
		return
	}

	if err := s.st.ReorderPlaylists(r.Context(), u.ID, req.IDs); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---------- tracks ----------

// trackRef identifies something on Bandcamp to add: a whole album ("a", which
// expands to every streamable track) or a single track ("t").
type trackRef struct {
	Type   string `json:"type"`
	ID     int64  `json:"id"`
	BandID int64  `json:"band_id"`
}

func (s *Server) handleAddTracks(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireEdit(w, r)
	if !ok {
		return
	}

	var req struct {
		URL   string     `json:"url"`
		Items []trackRef `json:"items"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	// A pasted URL is just another way of naming a ref.
	if u := strings.TrimSpace(req.URL); u != "" {
		typ, id, bandID, err := s.bc.Resolve(r.Context(), u)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		req.Items = append(req.Items, trackRef{Type: typ, ID: id, BandID: bandID})
	}

	if len(req.Items) == 0 {
		writeErr(w, http.StatusBadRequest, "nothing to add")
		return
	}
	if len(req.Items) > maxAddPerRequest {
		writeErr(w, http.StatusBadRequest, "too many items in one request")
		return
	}

	var toAdd []*store.Track
	for _, ref := range req.Items {
		if ref.Type != "a" && ref.Type != "t" {
			writeErr(w, http.StatusBadRequest, "item type must be 'a' or 't'")
			return
		}
		if ref.ID <= 0 || ref.BandID <= 0 {
			writeErr(w, http.StatusBadRequest, "item id and band_id are required")
			return
		}

		detail, err := s.bc.Details(r.Context(), ref.Type, ref.ID, ref.BandID)
		if err != nil {
			fail(w, err)
			return
		}
		for _, t := range detail.Tracks {
			if !t.Streamable {
				continue // no preview stream, so it could never be played back
			}
			toAdd = append(toAdd, &store.Track{
				TrackID:    t.TrackID,
				AlbumID:    t.AlbumID,
				BandID:     &t.BandID,
				Title:      t.Title,
				Artist:     t.Artist,
				AlbumTitle: t.AlbumTitle,
				Duration:   t.Duration,
				ArtID:      t.ArtID,
				TrackURL:   t.TrackURL,
			})
		}
	}

	if len(toAdd) == 0 {
		writeErr(w, http.StatusBadRequest, "nothing streamable to add")
		return
	}
	if p.TrackCount+len(toAdd) > maxPlaylistTracks {
		writeErr(w, http.StatusBadRequest, "this playlist is full")
		return
	}

	// Anonymous edits on public playlists record a NULL author.
	var addedBy *int64
	if u := userFrom(r.Context()); u != nil {
		addedBy = &u.ID
	}

	n, err := s.st.AddTracks(r.Context(), p.ID, addedBy, toAdd)
	if err != nil {
		fail(w, err)
		return
	}

	tracks, err := s.st.Tracks(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}
	s.hub.broadcast(p.ID)
	writeJSON(w, http.StatusOK, map[string]any{"added": n, "tracks": tracks})
}

func (s *Server) handleDeleteTrack(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireEdit(w, r)
	if !ok {
		return
	}
	trackRowID, valid := pathInt(r, "trackId")
	if !valid {
		writeErr(w, http.StatusBadRequest, "invalid track id")
		return
	}
	if err := s.st.DeleteTrack(r.Context(), p.ID, trackRowID); err != nil {
		fail(w, err)
		return
	}
	s.hub.broadcast(p.ID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleUpdateTrack applies hand-entered corrections to one playlist row: a
// tempo or key override, or reassigning who gets credit for adding it.
func (s *Server) handleUpdateTrack(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireEdit(w, r)
	if !ok {
		return
	}
	trackRowID, valid := pathInt(r, "trackId")
	if !valid {
		writeErr(w, http.StatusBadRequest, "invalid track id")
		return
	}

	// Decoded field by field so "absent" and "null" stay distinguishable: null
	// clears that override, absent leaves it alone. A struct of pointers cannot
	// express the difference, so updating the tempo would wipe the key.
	var raw map[string]json.RawMessage
	if !decodeJSON(w, r, &raw) {
		return
	}
	for field := range raw {
		if field != "bpm" && field != "key_override" && field != "added_by" && field != "note" {
			writeErr(w, http.StatusBadRequest, "unknown field "+field)
			return
		}
	}

	if value, present := raw["bpm"]; present {
		var bpm *float64
		if err := json.Unmarshal(value, &bpm); err != nil {
			writeErr(w, http.StatusBadRequest, "bpm must be a number or null")
			return
		}
		// Reject nonsense outright; a bad value is worse than none, because it
		// silently misleads anyone beat-matching against it.
		if bpm != nil && (*bpm <= 0 || *bpm > 400) {
			writeErr(w, http.StatusBadRequest, "bpm must be between 1 and 400")
			return
		}
		if err := s.st.SetTrackBPM(r.Context(), p.ID, trackRowID, bpm); err != nil {
			fail(w, err)
			return
		}
	}

	if value, present := raw["key_override"]; present {
		var key *string
		if err := json.Unmarshal(value, &key); err != nil {
			writeErr(w, http.StatusBadRequest, "key_override must be a string or null")
			return
		}
		code := ""
		if key != nil && *key != "" {
			if code = normalizeCamelot(*key); code == "" {
				writeErr(w, http.StatusBadRequest, "key must be a Camelot code such as 8A or 12B")
				return
			}
		}
		if err := s.st.SetTrackKey(r.Context(), p.ID, trackRowID, code); err != nil {
			fail(w, err)
			return
		}
	}

	if value, present := raw["note"]; present {
		var note *string
		if err := json.Unmarshal(value, &note); err != nil {
			writeErr(w, http.StatusBadRequest, "note must be a string or null")
			return
		}
		text := ""
		if note != nil {
			text = trimTo(*note, 280)
		}
		if err := s.st.SetTrackNote(r.Context(), p.ID, trackRowID, text); err != nil {
			fail(w, err)
			return
		}
	}

	if value, present := raw["added_by"]; present {
		var userID *int64
		if err := json.Unmarshal(value, &userID); err != nil {
			writeErr(w, http.StatusBadRequest, "added_by must be a user id or null")
			return
		}
		// Reassignment is only ever to the owner or an invited collaborator,
		// never an arbitrary account, so attribution can't be used to credit
		// (or blame) someone with no relationship to this playlist.
		if userID != nil {
			allowed := *userID == p.OwnerID
			if !allowed {
				var err error
				allowed, err = s.st.IsCollaborator(r.Context(), p.ID, *userID)
				if err != nil {
					fail(w, err)
					return
				}
			}
			if !allowed {
				writeErr(w, http.StatusBadRequest, "added_by must be the playlist owner or an invited collaborator")
				return
			}
		}
		if err := s.st.SetTrackAddedBy(r.Context(), p.ID, trackRowID, userID); err != nil {
			fail(w, err)
			return
		}
	}

	s.hub.broadcast(p.ID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleDeleteTracks removes a selected group of tracks in one request.
func (s *Server) handleDeleteTracks(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireEdit(w, r)
	if !ok {
		return
	}

	var req struct {
		IDs []int64 `json:"ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "no tracks selected")
		return
	}
	if len(req.IDs) > maxPlaylistTracks {
		writeErr(w, http.StatusBadRequest, "too many tracks")
		return
	}

	removed, err := s.st.DeleteTracks(r.Context(), p.ID, req.IDs)
	if err != nil {
		fail(w, err)
		return
	}

	tracks, err := s.st.Tracks(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}
	s.hub.broadcast(p.ID)
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed, "tracks": tracks})
}

func (s *Server) handleReorderTracks(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireEdit(w, r)
	if !ok {
		return
	}

	var req struct {
		IDs []int64 `json:"ids"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.IDs) > maxPlaylistTracks {
		writeErr(w, http.StatusBadRequest, "too many tracks")
		return
	}

	if err := s.st.ReorderTracks(r.Context(), p.ID, req.IDs); err != nil {
		fail(w, err)
		return
	}

	tracks, err := s.st.Tracks(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}
	s.hub.broadcast(p.ID)
	writeJSON(w, http.StatusOK, map[string]any{"tracks": tracks})
}

var camelotRe = regexp.MustCompile(`^(1[0-2]|[1-9])[AB]$`)

// normalizeCamelot upper-cases and validates a Camelot wheel code, returning
// "" when it is not one. The wheel runs 1-12 with an A (minor) or B (major)
// side, so anything else would sort and match nonsensically.
func normalizeCamelot(input string) string {
	code := strings.ToUpper(strings.TrimSpace(input))
	if code == "" || !camelotRe.MatchString(code) {
		return ""
	}
	return code
}

// isSafeImageURL keeps cover art pointed at https so a playlist cannot be used
// to smuggle javascript: or data: URLs into another viewer's browser.
func isSafeImageURL(s string) bool {
	return strings.HasPrefix(strings.ToLower(s), "https://")
}
