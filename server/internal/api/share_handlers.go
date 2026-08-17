package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/aeternitaas/b2bandcamp/server/internal/auth"
	"github.com/aeternitaas/b2bandcamp/server/internal/store"
	"github.com/go-sql-driver/mysql"
)

// handleGetShareLink returns the playlist's existing invite link, so an owner
// who lost it can look it up rather than rotating everyone off the old one.
func (s *Server) handleGetShareLink(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireOwner(w, r)
	if !ok {
		return
	}

	token, err := s.st.ShareToken(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}
	if token == "" {
		writeJSON(w, http.StatusOK, map[string]any{"token": "", "path": ""})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"path":       "/s/" + token,
		"visibility": p.Visibility,
	})
}

// handleCreateShareLink mints a fresh share token, replacing any existing one.
// The token is stored so the owner can retrieve it later; the SHA-256 hash is
// what lookups match against.
func (s *Server) handleCreateShareLink(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireOwner(w, r)
	if !ok {
		return
	}

	// Short tokens live in a small enough space that a collision with the
	// unique index, while very unlikely, is possible — so retry rather than
	// surfacing a duplicate-key error to the user.
	var (
		token string
		err   error
	)
	for attempt := 0; ; attempt++ {
		token, err = auth.NewShareToken()
		if err != nil {
			fail(w, err)
			return
		}
		hash := auth.HashToken(token)
		err = s.st.SetShareToken(r.Context(), p.ID, &token, &hash)
		if err == nil {
			break
		}

		var me *mysql.MySQLError
		if errors.As(err, &me) && me.Number == 1062 && attempt < 5 {
			continue
		}
		fail(w, err)
		return
	}

	// A share link on a private playlist would do nothing, so promote to shared.
	if p.Visibility == store.VisibilityPrivate {
		v := store.VisibilityShared
		if err := s.st.UpdatePlaylist(r.Context(), p.ID, store.PlaylistUpdate{Visibility: &v}); err != nil {
			fail(w, err)
			return
		}
		p.Visibility = v
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"path":       "/s/" + token,
		"visibility": p.Visibility,
	})
}

func (s *Server) handleRevokeShareLink(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireOwner(w, r)
	if !ok {
		return
	}
	if err := s.st.SetShareToken(r.Context(), p.ID, nil, nil); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleResolveShare turns a share token into a playlist. For "shared"
// playlists this is also the moment a signed-in visitor becomes a collaborator.
func (s *Server) handleResolveShare(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if token == "" {
		writeErr(w, http.StatusBadRequest, "missing share token")
		return
	}

	p, err := s.st.PlaylistByShareHash(r.Context(), auth.HashToken(token))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "this share link is no longer valid")
			return
		}
		fail(w, err)
		return
	}

	u := userFrom(r.Context())
	role := "viewer"
	canEdit := false

	switch {
	case u != nil && u.ID == p.OwnerID:
		role, canEdit = "owner", true
	case p.Visibility == store.VisibilityPublic:
		role, canEdit = "guest", true
		if u != nil {
			role = "collaborator"
		}
	case p.Visibility == store.VisibilityShared && u != nil:
		if err := s.st.AddCollaborator(r.Context(), p.ID, u.ID); err != nil {
			fail(w, err)
			return
		}
		role, canEdit = "collaborator", true
	}

	tracks, err := s.st.Tracks(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}

	p.Role = role
	writeJSON(w, http.StatusOK, map[string]any{
		"playlist": p,
		"tracks":   tracks,
		"can_edit": canEdit,
		"role":     role,
	})
}

func (s *Server) handleListCollaborators(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireView(w, r)
	if !ok {
		return
	}
	list, err := s.st.Collaborators(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"collaborators": list})
}

// handleAddCollaborator invites an existing account by username. This is the
// direct alternative to handing someone a share link: the owner greenlights a
// specific user, who then sees the playlist in their own list.
func (s *Server) handleAddCollaborator(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireOwner(w, r)
	if !ok {
		return
	}

	var req struct {
		Username string `json:"username"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	login := strings.TrimSpace(req.Username)
	if login == "" {
		writeErr(w, http.StatusBadRequest, "enter a username or email to invite")
		return
	}

	// Accepts either identifier: the owner is deliberately granting access, so
	// resolving by email is appropriate here even though the autocomplete
	// endpoint only ever matches usernames.
	u, _, err := s.st.UserByLogin(r.Context(), login)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "no b2bandcamp user with that username or email")
			return
		}
		fail(w, err)
		return
	}
	if u.ID == p.OwnerID {
		writeErr(w, http.StatusBadRequest, "you already own this playlist")
		return
	}

	if err := s.st.AddCollaborator(r.Context(), p.ID, u.ID); err != nil {
		fail(w, err)
		return
	}

	// Inviting someone implies the playlist is no longer private; otherwise the
	// invitee would be granted access they cannot reach.
	if p.Visibility == store.VisibilityPrivate {
		v := store.VisibilityShared
		if err := s.st.UpdatePlaylist(r.Context(), p.ID, store.PlaylistUpdate{Visibility: &v}); err != nil {
			fail(w, err)
			return
		}
	}

	list, err := s.st.Collaborators(r.Context(), p.ID)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"collaborators": list})
}

// handleSearchUsers backs the invite field's autocomplete.
func (s *Server) handleSearchUsers(w http.ResponseWriter, r *http.Request) {
	if s.requireUser(w, r) == nil {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"users": []any{}})
		return
	}

	users, err := s.st.SearchUsers(r.Context(), q, 8)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

// handleListShares returns every live share link the signed-in user owns, so
// they can be reviewed and revoked from one place rather than playlist by
// playlist.
func (s *Server) handleListShares(w http.ResponseWriter, r *http.Request) {
	u := s.requireUser(w, r)
	if u == nil {
		return
	}

	links, err := s.st.SharesByOwner(r.Context(), u.ID)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"shares": links})
}

// handleUserProfile lists a user's public playlists. No authentication is
// required: public is exactly the visibility that means "anyone may see this".
func (s *Server) handleUserProfile(w http.ResponseWriter, r *http.Request) {
	username := strings.TrimSpace(r.PathValue("username"))
	if username == "" {
		writeErr(w, http.StatusBadRequest, "missing username")
		return
	}

	u, err := s.st.UserByUsername(r.Context(), username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "no such user")
			return
		}
		fail(w, err)
		return
	}

	// Owners see every playlist they own on their own profile, so visibility can
	// be changed from here. Everyone else sees only the public ones.
	viewer := userFrom(r.Context())
	isSelf := viewer != nil && viewer.ID == u.ID

	var list []*store.Playlist
	if isSelf {
		owned, err := s.st.ListPlaylistsForUser(r.Context(), u.ID)
		if err != nil {
			fail(w, err)
			return
		}
		list = []*store.Playlist{}
		for _, p := range owned {
			if p.OwnerID == u.ID {
				list = append(list, p)
			}
		}
	} else {
		list, err = s.st.PublicPlaylistsByOwner(r.Context(), u.Username)
		if err != nil {
			fail(w, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		// Email is deliberately omitted — profiles are public.
		"user":      map[string]any{"username": u.Username, "created_at": u.CreatedAt},
		"playlists": list,
		"is_self":   isSelf,
	})
}

func (s *Server) handleRemoveCollaborator(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireOwner(w, r)
	if !ok {
		return
	}
	userID, valid := pathInt(r, "userId")
	if !valid {
		writeErr(w, http.StatusBadRequest, "invalid user id")
		return
	}
	if err := s.st.RemoveCollaborator(r.Context(), p.ID, userID); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
