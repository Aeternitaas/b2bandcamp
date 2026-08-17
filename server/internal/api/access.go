package api

import (
	"net/http"

	"github.com/aeternitaas/b2bandcamp/server/internal/auth"
	"github.com/aeternitaas/b2bandcamp/server/internal/store"
)

// perms is the result of evaluating one caller against one playlist.
type perms struct {
	view  bool
	edit  bool
	owner bool
	role  string // owner | collaborator | guest | viewer | none
}

// access resolves what the caller may do with a playlist.
//
// Authority comes from one of two places: a session cookie (owner or invited
// collaborator) or a share token supplied in the X-Share-Token header. The
// visibility setting decides how far a share token goes:
//
//	private — the token is inert; only the owner and invited collaborators.
//	shared  — the token admits anyone, but editing requires signing in, so the
//	          owner can see and revoke individual collaborators.
//	public  — anyone may view without a token (these are listed on the owner's
//	          profile); the token additionally grants editing, no account needed.
func (s *Server) access(r *http.Request, playlistID int64) (*store.Playlist, perms, error) {
	ctx := r.Context()

	p, err := s.st.PlaylistByID(ctx, playlistID)
	if err != nil {
		return nil, perms{}, err
	}

	u := userFrom(ctx)
	if u != nil {
		if p.OwnerID == u.ID {
			return p, perms{view: true, edit: true, owner: true, role: "owner"}, nil
		}
		ok, err := s.st.IsCollaborator(ctx, p.ID, u.ID)
		if err != nil {
			return nil, perms{}, err
		}
		if ok {
			return p, perms{view: true, edit: true, role: "collaborator"}, nil
		}
	}

	// A public playlist is listed on its owner's profile, so viewing it must not
	// require holding the link. Editing still does.
	publicView := p.Visibility == store.VisibilityPublic

	token := r.Header.Get("X-Share-Token")
	if token == "" || p.Visibility == store.VisibilityPrivate {
		if publicView {
			return p, perms{view: true, role: "viewer"}, nil
		}
		return p, perms{role: "none"}, nil
	}

	// The unique index on share_token_hash does the comparison for us, against
	// the hash rather than the raw token.
	shared, err := s.st.PlaylistByShareHash(ctx, auth.HashToken(token))
	if err != nil || shared.ID != p.ID {
		if publicView {
			return p, perms{view: true, role: "viewer"}, nil
		}
		return p, perms{role: "none"}, nil
	}

	switch p.Visibility {
	case store.VisibilityPublic:
		return p, perms{view: true, edit: true, role: "guest"}, nil
	case store.VisibilityShared:
		if u != nil {
			// Opening a share link while signed in is what "being invited" means.
			if err := s.st.AddCollaborator(ctx, p.ID, u.ID); err != nil {
				return nil, perms{}, err
			}
			return p, perms{view: true, edit: true, role: "collaborator"}, nil
		}
		return p, perms{view: true, role: "viewer"}, nil
	}

	return p, perms{role: "none"}, nil
}

// requireView / requireEdit / requireOwner load the playlist and enforce a
// permission level, writing the error response themselves when denied.

func (s *Server) requireView(w http.ResponseWriter, r *http.Request) (*store.Playlist, perms, bool) {
	return s.requireLevel(w, r, "view")
}

func (s *Server) requireEdit(w http.ResponseWriter, r *http.Request) (*store.Playlist, perms, bool) {
	return s.requireLevel(w, r, "edit")
}

func (s *Server) requireOwner(w http.ResponseWriter, r *http.Request) (*store.Playlist, perms, bool) {
	return s.requireLevel(w, r, "owner")
}

func (s *Server) requireLevel(w http.ResponseWriter, r *http.Request, level string) (*store.Playlist, perms, bool) {
	id, ok := pathInt(r, "id")
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid playlist id")
		return nil, perms{}, false
	}

	p, pr, err := s.access(r, id)
	if err != nil {
		fail(w, err)
		return nil, perms{}, false
	}

	granted := pr.view
	switch level {
	case "edit":
		granted = pr.edit
	case "owner":
		granted = pr.owner
	}
	if granted {
		return p, pr, true
	}

	// Anonymous callers get 401 so the client knows signing in might help;
	// signed-in callers get 404 rather than 403, so playlist ids they cannot
	// see stay unenumerable.
	if userFrom(r.Context()) == nil {
		writeErr(w, http.StatusUnauthorized, "sign in required")
	} else if pr.view {
		writeErr(w, http.StatusForbidden, "you do not have permission to edit this playlist")
	} else {
		writeErr(w, http.StatusNotFound, "not found")
	}
	return nil, perms{}, false
}
