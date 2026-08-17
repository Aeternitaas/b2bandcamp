package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// limiter is a fixed-window counter keyed by caller. It exists to blunt
// credential-stuffing against the login endpoint; it is deliberately simple
// because this is a single-instance, self-hosted service.
type limiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	limit  int
	window time.Duration
}

func newLimiter(limit int, window time.Duration) *limiter {
	l := &limiter{hits: make(map[string][]time.Time), limit: limit, window: window}
	go func() {
		for range time.Tick(window) {
			l.mu.Lock()
			cutoff := time.Now().Add(-l.window)
			for k, ts := range l.hits {
				if len(ts) == 0 || ts[len(ts)-1].Before(cutoff) {
					delete(l.hits, k)
				}
			}
			l.mu.Unlock()
		}
	}()
	return l
}

// allow records an attempt and reports whether it is within budget.
func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := time.Now().Add(-l.window)
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.limit {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, time.Now())
	return true
}

// clientIP identifies the caller for rate-limiting purposes.
//
// X-Forwarded-For is only consulted when the immediate peer is a configured
// trusted proxy — the header is trivially forged, so believing it from an
// arbitrary client would let anyone sidestep the limiters entirely by sending a
// different value each request. Conversely, ignoring it behind a real proxy
// lumps every user into one bucket, so one person's failed logins would lock
// out everybody.
func (s *Server) clientIP(r *http.Request) string {
	peer := directPeer(r)
	if len(s.cfg.TrustedProxies) == 0 || !s.isTrustedProxy(peer) {
		return peer
	}

	// Walk right to left and take the first address that is not itself a proxy
	// we trust: that is the outermost hop we have any reason to believe.
	forwarded := r.Header.Get("X-Forwarded-For")
	parts := strings.Split(forwarded, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		candidate := strings.TrimSpace(parts[i])
		if candidate == "" {
			continue
		}
		if net.ParseIP(candidate) == nil {
			continue
		}
		if !s.isTrustedProxy(candidate) {
			return candidate
		}
	}

	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" && net.ParseIP(real) != nil {
		return real
	}
	return peer
}

func (s *Server) isTrustedProxy(addr string) bool {
	ip := net.ParseIP(addr)
	if ip == nil {
		return false
	}
	for _, network := range s.cfg.TrustedProxies {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func directPeer(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
