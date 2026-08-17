package api

import (
	"net"
	"net/http"
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

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
