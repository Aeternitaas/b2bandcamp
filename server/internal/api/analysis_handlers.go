package api

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"

	"github.com/aeternitaas/b2bandcamp/server/internal/store"
)

// The version lives in the store package so the playlist join and these
// handlers can never disagree about which cached rows are still valid.
const analyzerVersion = store.AnalyzerVersion

// maxPeaksBytes caps the stored waveform. One byte per bucket, and the client
// asks for 400, so this leaves generous headroom without letting a caller
// stuff arbitrary data into the column.
const maxPeaksBytes = 2048

// handleGetAnalysis serves a cached analysis so the client can skip downloading
// and decoding the audio entirely.
func (s *Server) handleGetAnalysis(w http.ResponseWriter, r *http.Request) {
	trackID, ok := pathInt(r, "trackId")
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid track id")
		return
	}

	a, err := s.st.AnalysisByTrack(r.Context(), trackID, analyzerVersion)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not analysed yet")
			return
		}
		fail(w, err)
		return
	}

	a.PeaksB64 = base64.StdEncoding.EncodeToString(a.Peaks)
	// The audio behind a Bandcamp track id never changes, so this is safe to
	// hold on to; a version bump changes the answer, not the URL.
	w.Header().Set("Cache-Control", "private, max-age=300")
	writeJSON(w, http.StatusOK, a)
}

// handleSaveAnalysis stores an analysis the client just computed, so nobody has
// to compute it again.
//
// Writing requires an account. The results are objective, but they drive a
// visible BPM column, and an unauthenticated write endpoint would let anyone
// poison it for every user of the instance.
func (s *Server) handleSaveAnalysis(w http.ResponseWriter, r *http.Request) {
	if s.requireUser(w, r) == nil {
		return
	}
	if !s.throttle(w, r) {
		return
	}

	trackID, ok := pathInt(r, "trackId")
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid track id")
		return
	}

	var req struct {
		BPM           *float64 `json:"bpm"`
		BPMConfidence *float64 `json:"bpm_confidence"`
		KeyName       string   `json:"key_name"`
		KeyCamelot    string   `json:"key_camelot"`
		KeyTonic      *int     `json:"key_tonic"`
		KeyScale      string   `json:"key_scale"`
		KeyConfidence *float64 `json:"key_confidence"`
		Peaks         string   `json:"peaks"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if req.BPM != nil && (*req.BPM <= 0 || *req.BPM > 400) {
		writeErr(w, http.StatusBadRequest, "bpm out of range")
		return
	}
	if req.KeyTonic != nil && (*req.KeyTonic < 0 || *req.KeyTonic > 11) {
		writeErr(w, http.StatusBadRequest, "key tonic must be a pitch class 0-11")
		return
	}

	peaks, err := base64.StdEncoding.DecodeString(req.Peaks)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "peaks must be base64")
		return
	}
	if len(peaks) > maxPeaksBytes {
		writeErr(w, http.StatusBadRequest, "waveform is too large")
		return
	}

	record := &store.TrackAnalysis{
		TrackID:         trackID,
		AnalyzerVersion: analyzerVersion,
		BPM:             req.BPM,
		BPMConfidence:   req.BPMConfidence,
		KeyName:         trimTo(req.KeyName, 24),
		KeyCamelot:      trimTo(req.KeyCamelot, 8),
		KeyTonic:        req.KeyTonic,
		KeyScale:        trimTo(req.KeyScale, 8),
		KeyConfidence:   req.KeyConfidence,
		Peaks:           peaks,
	}
	if err := s.st.SaveAnalysis(r.Context(), record); err != nil {
		fail(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "analyzer_version": analyzerVersion})
}

// handleAnalysisVersion lets the client learn which analyzer the server expects
// without hard-coding the number in two places.
func (s *Server) handleAnalysisVersion(w http.ResponseWriter, r *http.Request) {
	_ = r
	writeJSON(w, http.StatusOK, map[string]int{"analyzer_version": analyzerVersion})
}

var _ = strconv.Itoa
