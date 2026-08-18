package api

import (
	"context"
	"crypto/subtle"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/auth"
	"github.com/aeternitaas/b2bandcamp/server/internal/store"
)

type ctxKey int

const (
	userCtxKey ctxKey = iota
	bearerAuthCtxKey
)

func (s *Server) withMiddleware(h http.Handler) http.Handler {
	// withUser runs before withCSRF so a bearer-authenticated request can be
	// exempted from the CSRF check (see withCSRF) — that decision needs to
	// know how the caller authenticated, which is only known once withUser
	// has run.
	return s.logRequests(s.securityHeaders(s.withUser(s.withCSRF(h))))
}

// withUser attaches the signed-in user (if any) to the request context. It
// never rejects: endpoints decide for themselves whether anonymous access is
// allowed, because public playlists are editable without an account.
//
// Two credential forms are accepted: the session cookie the web app uses, and
// an "Authorization: Bearer <token>" header for clients that cannot hold a
// cookie — the browser extension (see docs/API.md). The header is checked
// first; a request presenting both is unusual enough that which one wins is
// not worth over-specifying.
func (s *Server) withUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if raw, ok := bearerToken(r); ok {
			hash := auth.HashToken(raw)
			u, err := s.st.UserByAPIToken(r.Context(), hash)
			if err != nil {
				if !errors.Is(err, store.ErrNotFound) {
					log.Printf("api token lookup: %v", err)
				}
				next.ServeHTTP(w, r)
				return
			}
			// Best-effort and off the request's own context, which is
			// cancelled the moment the response is written — this write
			// should not race that.
			go func() {
				if err := s.st.TouchAPIToken(context.Background(), hash); err != nil {
					log.Printf("touch api token: %v", err)
				}
			}()

			ctx := context.WithValue(r.Context(), userCtxKey, u)
			ctx = context.WithValue(ctx, bearerAuthCtxKey, true)
			next.ServeHTTP(w, r.WithContext(ctx))
			return
		}

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

// bearerToken extracts the token from "Authorization: Bearer <token>",
// case-insensitively on the scheme name per RFC 6750.
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) <= len(prefix) || !strings.EqualFold(h[:len(prefix)], prefix) {
		return "", false
	}
	return strings.TrimSpace(h[len(prefix):]), true
}

func userFrom(ctx context.Context) *store.User {
	u, _ := ctx.Value(userCtxKey).(*store.User)
	return u
}

// authenticatedByBearer reports whether the current request's user (if any)
// was authenticated via an API token rather than the session cookie.
func authenticatedByBearer(ctx context.Context) bool {
	v, _ := ctx.Value(bearerAuthCtxKey).(bool)
	return v
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

		switch {
		case r.Method == http.MethodGet, r.Method == http.MethodHead, r.Method == http.MethodOptions:
		case authenticatedByBearer(r.Context()):
			// A CSRF token defends against a browser silently attaching
			// ambient credentials (the session cookie) to a request the
			// user never made. A bearer token is never ambient — the
			// caller has to already hold it and set the header itself —
			// so a third-party page cannot forge this request regardless
			// of CSRF protection either way.
		case r.URL.Path == "/api/auth/tokens" && r.Method == http.MethodPost:
			// The one request that mints a bearer token cannot itself be
			// bearer-authenticated. It is exempt for the same reason: it is
			// gated on a password in the request body, not on anything a
			// browser attaches automatically, so there is nothing here for
			// a forged cross-site request to ride along on either.
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

// Unwrap lets http.ResponseController reach the underlying ResponseWriter's
// Flush (used by the SSE stream in events.go) — embedding the
// http.ResponseWriter interface only promotes the methods that interface
// declares, which does not include Flush.
func (w *statusRecorder) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}
