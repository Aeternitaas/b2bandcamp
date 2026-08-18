package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

const playlistSelect = `
SELECT p.id, p.owner_id, u.username, p.title, COALESCE(p.description, ''),
       COALESCE(p.cover_url, ''), p.visibility, p.share_token_hash IS NOT NULL,
       (SELECT ft.art_id FROM playlist_tracks ft
         WHERE ft.playlist_id = p.id AND ft.art_id IS NOT NULL
         ORDER BY ft.position ASC, ft.id ASC LIMIT 1) AS cover_art_id,
       p.sort_index,
       COALESCE(t.cnt, 0), COALESCE(t.dur, 0), p.created_at, p.updated_at
  FROM playlists p
  JOIN users u ON u.id = p.owner_id
  LEFT JOIN (
        SELECT playlist_id, COUNT(*) AS cnt, SUM(duration) AS dur
          FROM playlist_tracks GROUP BY playlist_id
  ) t ON t.playlist_id = p.id`

func scanPlaylist(row interface{ Scan(...any) error }) (*Playlist, error) {
	var p Playlist
	err := row.Scan(&p.ID, &p.OwnerID, &p.OwnerName, &p.Title, &p.Description,
		&p.CoverURL, &p.Visibility, &p.HasShareLink, &p.CoverArtID, &p.SortIndex,
		&p.TrackCount, &p.DurationSeconds, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// ListPlaylistsForUser returns playlists the user owns plus the ones they have
// been invited to collaborate on, ordered by the user's manual sort.
func (s *Store) ListPlaylistsForUser(ctx context.Context, userID int64) ([]*Playlist, error) {
	rows, err := s.DB.QueryContext(ctx, playlistSelect+`
 WHERE p.owner_id = ?
    OR p.id IN (SELECT playlist_id FROM playlist_collaborators WHERE user_id = ?)
 ORDER BY p.sort_index ASC, p.updated_at DESC`, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*Playlist
	for rows.Next() {
		p, err := scanPlaylist(rows)
		if err != nil {
			return nil, err
		}
		if p.OwnerID == userID {
			p.Role = "owner"
		} else {
			p.Role = "collaborator"
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// PublicPlaylistsByOwner backs a user's profile page. Only playlists the owner
// marked public are listed — private and shared ones stay invisible to anyone
// browsing the profile.
func (s *Store) PublicPlaylistsByOwner(ctx context.Context, username string) ([]*Playlist, error) {
	rows, err := s.DB.QueryContext(ctx, playlistSelect+`
 WHERE u.username = ? AND p.visibility = 'public'
 ORDER BY p.sort_index ASC, p.updated_at DESC`, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*Playlist{}
	for rows.Next() {
		p, err := scanPlaylist(rows)
		if err != nil {
			return nil, err
		}
		p.Role = "viewer"
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) PlaylistByID(ctx context.Context, id int64) (*Playlist, error) {
	return scanPlaylist(s.DB.QueryRowContext(ctx, playlistSelect+` WHERE p.id = ?`, id))
}

// PlaylistByShareHash resolves a share link. Private playlists are excluded:
// switching to private is how an owner turns an already-distributed link off.
func (s *Store) PlaylistByShareHash(ctx context.Context, hash string) (*Playlist, error) {
	return scanPlaylist(s.DB.QueryRowContext(ctx, playlistSelect+
		` WHERE p.share_token_hash = ? AND p.visibility <> 'private'`, hash))
}

func (s *Store) CreatePlaylist(ctx context.Context, ownerID int64, title, description string) (*Playlist, error) {
	now := time.Now().UTC()

	// New playlists land at the top of the owner's manual ordering.
	var minIdx sql.NullInt64
	if err := s.DB.QueryRowContext(ctx,
		`SELECT MIN(sort_index) FROM playlists WHERE owner_id = ?`, ownerID).Scan(&minIdx); err != nil {
		return nil, err
	}
	idx := 0
	if minIdx.Valid {
		idx = int(minIdx.Int64) - 1
	}

	res, err := s.DB.ExecContext(ctx,
		`INSERT INTO playlists (owner_id, title, description, visibility, sort_index, created_at, updated_at)
		 VALUES (?, ?, ?, 'private', ?, ?, ?)`,
		ownerID, title, description, idx, now, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return s.PlaylistByID(ctx, id)
}

// PlaylistUpdate carries partial edits; nil fields are left untouched.
type PlaylistUpdate struct {
	Title           *string
	Description     *string
	CoverURL        *string
	Visibility      *Visibility
}

func (s *Store) UpdatePlaylist(ctx context.Context, id int64, up PlaylistUpdate) error {
	sets := []string{"updated_at = ?"}
	args := []any{time.Now().UTC()}

	if up.Title != nil {
		sets = append(sets, "title = ?")
		args = append(args, *up.Title)
	}
	if up.Description != nil {
		sets = append(sets, "description = ?")
		args = append(args, *up.Description)
	}
	if up.CoverURL != nil {
		sets = append(sets, "cover_url = ?")
		args = append(args, *up.CoverURL)
	}
	if up.Visibility != nil {
		sets = append(sets, "visibility = ?")
		args = append(args, string(*up.Visibility))
	}
	args = append(args, id)
	_, err := s.DB.ExecContext(ctx,
		`UPDATE playlists SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	return err
}

func (s *Store) TouchPlaylist(ctx context.Context, id int64) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE playlists SET updated_at = ? WHERE id = ?`, time.Now().UTC(), id)
}

func (s *Store) DeletePlaylist(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM playlists WHERE id = ?`, id)
	return err
}

// ReorderPlaylists writes a new manual ordering, scoped to the playlists the
// user actually owns so a crafted id list cannot touch anyone else's rows.
func (s *Store) ReorderPlaylists(ctx context.Context, ownerID int64, ids []int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx,
		`UPDATE playlists SET sort_index = ? WHERE id = ? AND owner_id = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for i, id := range ids {
		if _, err := stmt.ExecContext(ctx, i, id, ownerID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetShareToken stores a share link, or clears it when both arguments are nil.
// The hash is what lookups match on; the raw token exists purely so the owner
// can be shown the link again later.
func (s *Store) SetShareToken(ctx context.Context, id int64, token, hash *string) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE playlists SET share_token_hash = ?, share_token = ?, updated_at = ? WHERE id = ?`,
		hash, token, time.Now().UTC(), id)
	return err
}

// ShareToken returns the playlist's current raw share token, if any. Callers
// must have already established that the requester owns the playlist.
func (s *Store) ShareToken(ctx context.Context, id int64) (string, error) {
	var token sql.NullString
	err := s.DB.QueryRowContext(ctx,
		`SELECT share_token FROM playlists WHERE id = ?`, id).Scan(&token)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return token.String, nil
}

// SharesByOwner lists every live share link belonging to one user, newest
// first. Callers must have established that this is the owner: the rows carry
// the raw tokens.
func (s *Store) SharesByOwner(ctx context.Context, ownerID int64) ([]*ShareLink, error) {
	rows, err := s.DB.QueryContext(ctx, `
SELECT p.id, p.title, p.visibility, p.share_token, COALESCE(p.cover_url, ''),
       (SELECT ft.art_id FROM playlist_tracks ft
         WHERE ft.playlist_id = p.id AND ft.art_id IS NOT NULL
         ORDER BY ft.position ASC, ft.id ASC LIMIT 1),
       COALESCE(t.cnt, 0),
       COALESCE(c.cnt, 0),
       p.updated_at
  FROM playlists p
  LEFT JOIN (SELECT playlist_id, COUNT(*) AS cnt FROM playlist_tracks GROUP BY playlist_id) t
         ON t.playlist_id = p.id
  LEFT JOIN (SELECT playlist_id, COUNT(*) AS cnt FROM playlist_collaborators GROUP BY playlist_id) c
         ON c.playlist_id = p.id
 WHERE p.owner_id = ? AND p.share_token IS NOT NULL AND p.share_token <> ''
 ORDER BY p.updated_at DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*ShareLink{}
	for rows.Next() {
		var l ShareLink
		if err := rows.Scan(&l.PlaylistID, &l.Title, &l.Visibility, &l.Token, &l.CoverURL,
			&l.CoverArtID, &l.TrackCount, &l.Collaborators, &l.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &l)
	}
	return out, rows.Err()
}

// ---------- tracks ----------

func (s *Store) Tracks(ctx context.Context, playlistID int64) ([]*Track, error) {
	// The adder and the cached analysis are joined in so the playlist view can
	// show attribution, tempo and key without a round trip per row.
	rows, err := s.DB.QueryContext(ctx,
		`SELECT t.id, t.playlist_id, t.position, t.bc_track_id, t.bc_album_id, t.bc_band_id,
		        t.title, t.artist, COALESCE(t.album_title, ''), t.duration, t.bpm,
		        COALESCE(t.key_override, ''), COALESCE(t.note, ''), t.art_id,
		        t.track_url, t.added_by, t.added_at,
		        COALESCE(u.username, ''), COALESCE(u.avatar_url, ''),
		        a.bpm, COALESCE(a.key_camelot, ''), COALESCE(a.key_name, '')
		   FROM playlist_tracks t
		   LEFT JOIN users u ON u.id = t.added_by
		   LEFT JOIN track_analysis a
		          ON a.bc_track_id = t.bc_track_id
		         AND a.analyzer_version >= ?
		  WHERE t.playlist_id = ? ORDER BY t.position ASC, t.id ASC`,
		AnalyzerVersion, playlistID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*Track{}
	for rows.Next() {
		var t Track
		if err := rows.Scan(&t.ID, &t.PlaylistID, &t.Position, &t.TrackID, &t.AlbumID,
			&t.BandID, &t.Title, &t.Artist, &t.AlbumTitle, &t.Duration, &t.BPM,
			&t.KeyOverride, &t.Note, &t.ArtID,
			&t.TrackURL, &t.AddedBy, &t.AddedAt, &t.AddedByName, &t.AddedByAvatar,
			&t.DetectedBPM, &t.KeyCamelot, &t.KeyName); err != nil {
			return nil, err
		}
		out = append(out, &t)
	}
	return out, rows.Err()
}

// AddTracks appends tracks to the end of the playlist in one transaction.
func (s *Store) AddTracks(ctx context.Context, playlistID int64, addedBy *int64, tracks []*Track) (int, error) {
	if len(tracks) == 0 {
		return 0, nil
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var maxPos sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT MAX(position) FROM playlist_tracks WHERE playlist_id = ?`, playlistID).Scan(&maxPos); err != nil {
		return 0, err
	}
	next := 0
	if maxPos.Valid {
		next = int(maxPos.Int64) + 1
	}

	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO playlist_tracks
		   (playlist_id, position, bc_track_id, bc_album_id, bc_band_id, title, artist,
		    album_title, duration, art_id, track_url, added_by, added_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()

	now := time.Now().UTC()
	added := 0
	for _, t := range tracks {
		if _, err := stmt.ExecContext(ctx, playlistID, next, t.TrackID, t.AlbumID, t.BandID,
			trunc(t.Title, 300), trunc(t.Artist, 300), trunc(t.AlbumTitle, 300), t.Duration,
			t.ArtID, trunc(t.TrackURL, 500), addedBy, now); err != nil {
			return 0, err
		}
		next++
		added++
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE playlists SET updated_at = ? WHERE id = ?`, now, playlistID); err != nil {
		return 0, err
	}
	return added, tx.Commit()
}

func (s *Store) DeleteTrack(ctx context.Context, playlistID, trackRowID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?`, trackRowID, playlistID)
	if err == nil {
		s.TouchPlaylist(ctx, playlistID)
	}
	return err
}

// DeleteTracks removes several tracks in one statement, so a bulk delete either
// lands entirely or not at all. The playlist_id predicate keeps ids belonging to
// other playlists inert.
func (s *Store) DeleteTracks(ctx context.Context, playlistID int64, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	args = append(args, playlistID)
	for _, id := range ids {
		args = append(args, id)
	}

	res, err := s.DB.ExecContext(ctx,
		`DELETE FROM playlist_tracks WHERE playlist_id = ? AND id IN (`+placeholders+`)`, args...)
	if err != nil {
		return 0, err
	}
	s.TouchPlaylist(ctx, playlistID)
	return res.RowsAffected()
}

// ReorderTracks rewrites positions from an ordered list of track row ids. The
// playlist_id predicate keeps ids from other playlists inert.
func (s *Store) ReorderTracks(ctx context.Context, playlistID int64, ids []int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx,
		`UPDATE playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for i, id := range ids {
		if _, err := stmt.ExecContext(ctx, i, id, playlistID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE playlists SET updated_at = ? WHERE id = ?`, time.Now().UTC(), playlistID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetTrackBPM records a hand-entered tempo override for one playlist row. A nil
// value clears the override, so the detected value takes over again.
func (s *Store) SetTrackBPM(ctx context.Context, playlistID, trackRowID int64, bpm *float64) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE playlist_tracks SET bpm = ? WHERE id = ? AND playlist_id = ?`,
		bpm, trackRowID, playlistID)
	return err
}

// SetTrackKey records a hand-entered Camelot code, or clears it when empty.
func (s *Store) SetTrackKey(ctx context.Context, playlistID, trackRowID int64, camelot string) error {
	var value any
	if camelot != "" {
		value = camelot
	}
	_, err := s.DB.ExecContext(ctx,
		`UPDATE playlist_tracks SET key_override = ? WHERE id = ? AND playlist_id = ?`,
		value, trackRowID, playlistID)
	return err
}

// SetTrackNote records a hand-written note against one playlist row, or
// clears it when empty.
func (s *Store) SetTrackNote(ctx context.Context, playlistID, trackRowID int64, note string) error {
	var value any
	if note != "" {
		value = note
	}
	_, err := s.DB.ExecContext(ctx,
		`UPDATE playlist_tracks SET note = ? WHERE id = ? AND playlist_id = ?`,
		value, trackRowID, playlistID)
	return err
}

// SetTrackAddedBy reassigns attribution for one playlist row, or clears it to
// anonymous when userID is nil. The caller is responsible for checking that
// userID actually belongs to this playlist (owner or collaborator) before
// calling this — the update itself does not re-derive that.
func (s *Store) SetTrackAddedBy(ctx context.Context, playlistID, trackRowID int64, userID *int64) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE playlist_tracks SET added_by = ? WHERE id = ? AND playlist_id = ?`,
		userID, trackRowID, playlistID)
	return err
}

// ---------- collaborators ----------

func (s *Store) Collaborators(ctx context.Context, playlistID int64) ([]*Collaborator, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT c.user_id, u.username, COALESCE(u.avatar_url, ''), c.added_at
		   FROM playlist_collaborators c JOIN users u ON u.id = c.user_id
		  WHERE c.playlist_id = ? ORDER BY c.added_at ASC`, playlistID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*Collaborator{}
	for rows.Next() {
		var c Collaborator
		if err := rows.Scan(&c.UserID, &c.Username, &c.AvatarURL, &c.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

func (s *Store) AddCollaborator(ctx context.Context, playlistID, userID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO playlist_collaborators (playlist_id, user_id, added_at)
		 VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE added_at = added_at`,
		playlistID, userID, time.Now().UTC())
	return err
}

func (s *Store) RemoveCollaborator(ctx context.Context, playlistID, userID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM playlist_collaborators WHERE playlist_id = ? AND user_id = ?`, playlistID, userID)
	return err
}

func (s *Store) IsCollaborator(ctx context.Context, playlistID, userID int64) (bool, error) {
	var n int
	err := s.DB.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM playlist_collaborators WHERE playlist_id = ? AND user_id = ?`,
		playlistID, userID).Scan(&n)
	return n > 0, err
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
