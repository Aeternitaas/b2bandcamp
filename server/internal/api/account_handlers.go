package api

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/auth"
	"github.com/go-sql-driver/mysql"
)

var accountLimiter = newLimiter(10, 15*time.Minute)

// handleUpdateAccount changes the signed-in user's email and/or password.
//
// Both changes require the current password. That is what stops someone who
// finds an unlocked session from silently taking the account over by swapping
// the recovery address or the password out from under the owner.
func (s *Server) handleUpdateAccount(w http.ResponseWriter, r *http.Request) {
	u := s.requireUser(w, r)
	if u == nil {
		return
	}
	if !accountLimiter.allow(s.clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "too many attempts, try again later")
		return
	}

	var req struct {
		CurrentPassword string `json:"current_password"`
		Email           string `json:"email"`
		NewPassword     string `json:"new_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	email := strings.TrimSpace(strings.ToLower(req.Email))
	changingEmail := email != "" && email != strings.ToLower(u.Email)
	changingPassword := req.NewPassword != ""

	if !changingEmail && !changingPassword {
		writeErr(w, http.StatusBadRequest, "nothing to change")
		return
	}

	// Verify the current password before touching anything.
	hash, err := s.st.PasswordHashByID(r.Context(), u.ID)
	if err != nil {
		fail(w, err)
		return
	}
	ok, err := auth.VerifyPassword(req.CurrentPassword, hash)
	if err != nil {
		fail(w, err)
		return
	}
	if !ok {
		writeErr(w, http.StatusForbidden, "current password is incorrect")
		return
	}

	if changingEmail {
		if _, err := mail.ParseAddress(email); err != nil {
			writeErr(w, http.StatusBadRequest, "enter a valid email address")
			return
		}
		if err := s.st.UpdateUserEmail(r.Context(), u.ID, email); err != nil {
			var me *mysql.MySQLError
			if errors.As(err, &me) && me.Number == 1062 {
				writeErr(w, http.StatusConflict, "that email is already in use")
				return
			}
			fail(w, err)
			return
		}
	}

	if changingPassword {
		if n := len(req.NewPassword); n < minPasswordLen || n > maxPasswordLen {
			writeErr(w, http.StatusBadRequest, "new password must be at least 10 characters")
			return
		}
		newHash, err := auth.HashPassword(req.NewPassword)
		if err != nil {
			fail(w, err)
			return
		}
		if err := s.st.UpdateUserPassword(r.Context(), u.ID, newHash); err != nil {
			fail(w, err)
			return
		}

		// Keep this session alive, drop every other one.
		if c, err := r.Cookie(s.cfg.CookieName); err == nil && c.Value != "" {
			if err := s.st.DeleteOtherSessions(r.Context(), u.ID, auth.HashToken(c.Value)); err != nil {
				fail(w, err)
				return
			}
		}
	}

	updated, err := s.st.UserByID(r.Context(), u.ID)
	if err != nil {
		fail(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"user":                 updated,
		"other_sessions_ended": changingPassword,
	})
}

// handleLinkBandcamp associates a Bandcamp profile with the account, optionally
// adopting that profile's picture as the avatar.
//
// This is a claim, not a proof — nothing here verifies the person actually owns
// the Bandcamp profile, and it grants no privileges. It exists so contributions
// can be attributed with a recognisable face.
func (s *Server) handleLinkBandcamp(w http.ResponseWriter, r *http.Request) {
	u := s.requireUser(w, r)
	if u == nil {
		return
	}
	if !s.throttle(w, r) {
		return
	}

	var req struct {
		Username  string `json:"username"`
		UseAvatar bool   `json:"use_avatar"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	name := strings.TrimSpace(req.Username)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "enter a Bandcamp username")
		return
	}

	fan, err := s.bc.Fan(r.Context(), name)
	if err != nil {
		writeErr(w, http.StatusNotFound, "no Bandcamp user found with that name")
		return
	}

	if err := s.st.SetBandcampLink(r.Context(), u.ID, fan.Username, &fan.FanID); err != nil {
		fail(w, err)
		return
	}

	// Only touch the avatar when asked, and only when that profile has one.
	if req.UseAvatar {
		if fan.ImageURL == "" {
			writeErr(w, http.StatusBadRequest, "that Bandcamp profile has no picture set")
			return
		}
		if err := s.st.SetAvatarURL(r.Context(), u.ID, fan.ImageURL); err != nil {
			fail(w, err)
			return
		}
	}

	s.writeCurrentUser(w, r, u.ID, map[string]any{"bandcamp": fan})
}

// handleUnlinkBandcamp removes the link, and any avatar that came from it.
func (s *Server) handleUnlinkBandcamp(w http.ResponseWriter, r *http.Request) {
	u := s.requireUser(w, r)
	if u == nil {
		return
	}

	if err := s.st.SetBandcampLink(r.Context(), u.ID, "", nil); err != nil {
		fail(w, err)
		return
	}
	// The avatar was sourced from Bandcamp's CDN, so it goes with the link.
	if strings.Contains(u.AvatarURL, "bcbits.com") {
		if err := s.st.SetAvatarURL(r.Context(), u.ID, ""); err != nil {
			fail(w, err)
			return
		}
	}

	s.writeCurrentUser(w, r, u.ID, nil)
}

// handleSetAvatar sets or clears the account's picture directly.
func (s *Server) handleSetAvatar(w http.ResponseWriter, r *http.Request) {
	u := s.requireUser(w, r)
	if u == nil {
		return
	}

	var req struct {
		AvatarURL string `json:"avatar_url"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	url := trimTo(req.AvatarURL, 500)
	if url != "" && !isSafeImageURL(url) {
		writeErr(w, http.StatusBadRequest, "avatar must be an https image url")
		return
	}
	if err := s.st.SetAvatarURL(r.Context(), u.ID, url); err != nil {
		fail(w, err)
		return
	}

	s.writeCurrentUser(w, r, u.ID, nil)
}

// writeCurrentUser re-reads and returns the account, merging in any extras.
func (s *Server) writeCurrentUser(w http.ResponseWriter, r *http.Request, id int64, extra map[string]any) {
	updated, err := s.st.UserByID(r.Context(), id)
	if err != nil {
		fail(w, err)
		return
	}
	body := map[string]any{"user": updated}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, http.StatusOK, body)
}
