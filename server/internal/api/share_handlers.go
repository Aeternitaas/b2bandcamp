package api

import (
	"errors"
	"net/http"

	"github.com/aeternitaas/b2b_helper/server/internal/auth"
	"github.com/aeternitaas/b2b_helper/server/internal/store"
)

// handleCreateShareLink mints a fresh share token. The raw token is returned
// exactly once, here; only its SHA-256 is stored, so the link cannot be
// recovered from a database dump. Calling this again rotates the link and
// invalidates the previous one.
func (s *Server) handleCreateShareLink(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireOwner(w, r)
	if !ok {
		return
	}

	token, err := auth.NewToken()
	if err != nil {
		fail(w, err)
		return
	}
	hash := auth.HashToken(token)
	if err := s.st.SetShareTokenHash(r.Context(), p.ID, &hash); err != nil {
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
	if err := s.st.SetShareTokenHash(r.Context(), p.ID, nil); err != nil {
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
