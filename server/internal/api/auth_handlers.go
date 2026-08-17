package api

import (
	"errors"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/auth"
	"github.com/aeternitaas/b2bandcamp/server/internal/store"
	"github.com/go-sql-driver/mysql"
)

const (
	minPasswordLen = 10
	maxPasswordLen = 200
)

var (
	usernameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{3,32}$`)

	loginLimiter    = newLimiter(10, 15*time.Minute)
	registerLimiter = newLimiter(5, time.Hour)
)

func (s *Server) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cfg.CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
		HttpOnly: true, // not reachable from JS, so XSS cannot exfiltrate it
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     s.cfg.CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID int64) error {
	token, err := auth.NewToken()
	if err != nil {
		return err
	}
	if err := s.st.CreateSession(r.Context(), auth.HashToken(token), userID,
		r.UserAgent(), s.cfg.SessionTTL); err != nil {
		return err
	}
	s.setSessionCookie(w, token)
	return nil
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.AllowRegister {
		writeErr(w, http.StatusForbidden, "registration is disabled on this instance")
		return
	}
	if !registerLimiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "too many sign-up attempts, try again later")
		return
	}

	var req struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))

	if !usernameRe.MatchString(req.Username) {
		writeErr(w, http.StatusBadRequest, "username must be 3-32 characters (letters, numbers, . _ -)")
		return
	}
	if _, err := mail.ParseAddress(req.Email); err != nil {
		writeErr(w, http.StatusBadRequest, "enter a valid email address")
		return
	}
	if n := len(req.Password); n < minPasswordLen || n > maxPasswordLen {
		writeErr(w, http.StatusBadRequest, "password must be at least 10 characters")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		fail(w, err)
		return
	}

	u, err := s.st.CreateUser(r.Context(), req.Username, req.Email, hash)
	if err != nil {
		var me *mysql.MySQLError
		if errors.As(err, &me) && me.Number == 1062 {
			writeErr(w, http.StatusConflict, "that username or email is already taken")
			return
		}
		fail(w, err)
		return
	}

	if err := s.startSession(w, r, u.ID); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Login = strings.TrimSpace(req.Login)

	if !loginLimiter.allow(clientIP(r)) {
		writeErr(w, http.StatusTooManyRequests, "too many sign-in attempts, try again later")
		return
	}

	u, hash, err := s.st.UserByLogin(r.Context(), req.Login)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Spend comparable time so response latency does not leak whether
			// the account exists.
			auth.DummyVerify(req.Password)
			writeErr(w, http.StatusUnauthorized, "incorrect username or password")
			return
		}
		fail(w, err)
		return
	}

	ok, err := auth.VerifyPassword(req.Password, hash)
	if err != nil {
		fail(w, err)
		return
	}
	if !ok {
		writeErr(w, http.StatusUnauthorized, "incorrect username or password")
		return
	}

	if err := s.startSession(w, r, u.ID); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(s.cfg.CookieName); err == nil && c.Value != "" {
		if err := s.st.DeleteSession(r.Context(), auth.HashToken(c.Value)); err != nil {
			fail(w, err)
			return
		}
	}
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	if u == nil {
		writeJSON(w, http.StatusOK, map[string]any{"user": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}
