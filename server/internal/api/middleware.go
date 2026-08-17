package api

import (
	"context"
	"crypto/subtle"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/auth"
	"github.com/aeternitaas/b2bandcamp/server/internal/store"
)

type ctxKey int

const userCtxKey ctxKey = iota

func (s *Server) withMiddleware(h http.Handler) http.Handler {
	return s.logRequests(s.securityHeaders(s.withCSRF(s.withUser(h))))
}

// withUser attaches the signed-in user (if any) to the request context. It never
// rejects: endpoints decide for themselves whether anonymous access is allowed,
// because public playlists are editable without an account.
func (s *Server) withUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(s.cfg.CookieName)
		if err != nil || c.Value == "" {
			next.ServeHTTP(w, r)
			return
		}

		u, err := s.st.UserBySession(r.Context(), auth.HashToken(c.Value))
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) {
				log.Printf("session lookup: %v", err)
			}
			// Stale or revoked session: clear the cookie so the client stops sending it.
			s.clearSessionCookie(w)
			next.ServeHTTP(w, r)
			return
		}

		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userCtxKey, u)))
	})
}

func userFrom(ctx context.Context) *store.User {
	u, _ := ctx.Value(userCtxKey).(*store.User)
	return u
}

// requireUser is the guard for endpoints that need an account.
func (s *Server) requireUser(w http.ResponseWriter, r *http.Request) *store.User {
	u := userFrom(r.Context())
	if u == nil {
		writeErr(w, http.StatusUnauthorized, "sign in required")
		return nil
	}
	return u
}

// withCSRF implements the double-submit cookie pattern: a random token is issued
// in a JS-readable cookie, and every state-changing request must echo it in a
// header. Combined with SameSite=Lax session cookies this blocks cross-site
// writes even for the anonymous public-playlist flows.
func (s *Server) withCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(s.cfg.CSRFCookie)
		token := ""
		if err == nil {
			token = cookie.Value
		}
		if token == "" {
			token, err = auth.NewToken()
			if err != nil {
				fail(w, err)
				return
			}
			http.SetCookie(w, &http.Cookie{
				Name:     s.cfg.CSRFCookie,
				Value:    token,
				Path:     "/",
				MaxAge:   int((30 * 24 * time.Hour).Seconds()),
				HttpOnly: false, // the SPA must read this to echo it back
				Secure:   s.cfg.CookieSecure,
				SameSite: http.SameSiteLaxMode,
			})
		}

		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			sent := r.Header.Get("X-CSRF-Token")
			if sent == "" || subtle.ConstantTimeCompare([]byte(sent), []byte(token)) != 1 {
				writeErr(w, http.StatusForbidden, "invalid csrf token")
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		// Art is served from Bandcamp's CDN (and covers may be any https image),
		// while audio is fetched from /api/bc/stream and redirected to bcbits.
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"img-src 'self' data: https:; "+
				"media-src 'self' https://*.bcbits.com https://bandcamp.com blob:; "+
				"script-src 'self'; style-src 'self' 'unsafe-inline'; "+
				"connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}
