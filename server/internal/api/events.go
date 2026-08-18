package api

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// playlistHub fans out a "something changed" signal to everyone currently
// watching a playlist's track list. It carries no payload and no history — a
// client that receives a signal just refetches the track list itself, so a
// coalesced or dropped signal is harmless, and the hub never has to agree
// with the database about what actually changed.
type playlistHub struct {
	mu   sync.Mutex
	subs map[int64]map[chan struct{}]struct{}
}

func newPlaylistHub() *playlistHub {
	return &playlistHub{subs: make(map[int64]map[chan struct{}]struct{})}
}

func (h *playlistHub) subscribe(playlistID int64) (ch chan struct{}, cancel func()) {
	ch = make(chan struct{}, 1)

	h.mu.Lock()
	if h.subs[playlistID] == nil {
		h.subs[playlistID] = make(map[chan struct{}]struct{})
	}
	h.subs[playlistID][ch] = struct{}{}
	h.mu.Unlock()

	return ch, func() {
		h.mu.Lock()
		delete(h.subs[playlistID], ch)
		if len(h.subs[playlistID]) == 0 {
			delete(h.subs, playlistID)
		}
		h.mu.Unlock()
	}
}

// broadcast wakes every subscriber watching playlistID. Delivery is
// best-effort: a subscriber that has not yet drained the previous signal
// simply skips this one, since its next refetch already covers it.
func (h *playlistHub) broadcast(playlistID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[playlistID] {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// handleTrackEvents streams a signal over Server-Sent Events every time this
// playlist's track list changes, so an open tab updates without polling.
//
// View access is enough to subscribe — the stream carries no data, only a
// cue to refetch — but subscribing still goes through the session cookie
// only: EventSource cannot attach the X-Share-Token header a guest link
// relies on, so anonymous share-link viewers keep the plain fetch-on-load
// behavior instead of live updates.
func (s *Server) handleTrackEvents(w http.ResponseWriter, r *http.Request) {
	p, _, ok := s.requireView(w, r)
	if !ok {
		return
	}

	rc := http.NewResponseController(w)

	ch, cancel := s.hub.subscribe(p.ID)
	defer cancel()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// Reverse proxies buffer responses by default; this opts the stream out
	// so events reach the client as they are sent rather than in batches.
	h.Set("X-Accel-Buffering", "no")

	if _, err := fmt.Fprint(w, ": connected\n\n"); err != nil {
		return
	}
	if err := rc.Flush(); err != nil {
		return // the deployment in front of us does not support streaming
	}

	// Keeps the connection alive through proxies that time out an idle
	// stream, and bounds how long a client waits to notice its connection
	// dropped and reconnect.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			_ = rc.Flush()
		case <-ch:
			if _, err := fmt.Fprint(w, "data: changed\n\n"); err != nil {
				return
			}
			_ = rc.Flush()
		}
	}
}
