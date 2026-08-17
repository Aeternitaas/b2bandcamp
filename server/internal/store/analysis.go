package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// AnalyzerVersion must be bumped whenever the detection algorithm changes, so
// cached rows produced by an older analyzer are recomputed rather than served.
//
//	2 - autocorrelation over an RMS-energy onset envelope
//	3 - mel-band spectral flux envelope with a tuned log-Gaussian tempo prior,
//	    which fixed tracks being reported at half their real tempo
const AnalyzerVersion = 3

// AnalysisByTrack returns the cached analysis for a Bandcamp track, or
// ErrNotFound. Rows produced by an older analyzer are treated as absent so a
// change to the detection algorithm re-derives rather than serving stale data.
func (s *Store) AnalysisByTrack(ctx context.Context, trackID int64, minVersion int) (*TrackAnalysis, error) {
	var a TrackAnalysis
	var keyName, keyCamelot, keyScale sql.NullString

	err := s.DB.QueryRowContext(ctx,
		`SELECT bc_track_id, analyzer_version, bpm, bpm_confidence,
		        key_name, key_camelot, key_tonic, key_scale, key_confidence,
		        peaks, analyzed_at
		   FROM track_analysis
		  WHERE bc_track_id = ? AND analyzer_version >= ?`, trackID, minVersion).
		Scan(&a.TrackID, &a.AnalyzerVersion, &a.BPM, &a.BPMConfidence,
			&keyName, &keyCamelot, &a.KeyTonic, &keyScale, &a.KeyConfidence,
			&a.Peaks, &a.AnalyzedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	a.KeyName = keyName.String
	a.KeyCamelot = keyCamelot.String
	a.KeyScale = keyScale.String
	return &a, nil
}

// SaveAnalysis upserts a track's analysis. Re-analysing simply overwrites.
func (s *Store) SaveAnalysis(ctx context.Context, a *TrackAnalysis) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO track_analysis
		   (bc_track_id, analyzer_version, bpm, bpm_confidence, key_name, key_camelot,
		    key_tonic, key_scale, key_confidence, peaks, analyzed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE
		   analyzer_version = VALUES(analyzer_version),
		   bpm              = VALUES(bpm),
		   bpm_confidence   = VALUES(bpm_confidence),
		   key_name         = VALUES(key_name),
		   key_camelot      = VALUES(key_camelot),
		   key_tonic        = VALUES(key_tonic),
		   key_scale        = VALUES(key_scale),
		   key_confidence   = VALUES(key_confidence),
		   peaks            = VALUES(peaks),
		   analyzed_at      = VALUES(analyzed_at)`,
		a.TrackID, a.AnalyzerVersion, a.BPM, a.BPMConfidence,
		nullable(a.KeyName), nullable(a.KeyCamelot), a.KeyTonic, nullable(a.KeyScale),
		a.KeyConfidence, a.Peaks, time.Now().UTC())
	return err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
