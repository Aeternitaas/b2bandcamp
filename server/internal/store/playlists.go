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
       p.base_fan_id, COALESCE(p.base_fan_username, ''), p.sort_index,
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
		&p.CoverURL, &p.Visibility, &p.HasShareLink, &p.BaseFanID, &p.BaseFanUsername,
		&p.SortIndex, &p.TrackCount, &p.DurationSeconds, &p.CreatedAt, &p.UpdatedAt)
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
	BaseFanID       *int64
	BaseFanUsername *string
	ClearBaseFan    bool
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
	if up.ClearBaseFan {
		sets = append(sets, "base_fan_id = NULL", "base_fan_username = NULL")
	} else if up.BaseFanID != nil {
		sets = append(sets, "base_fan_id = ?", "base_fan_username = ?")
		name := ""
		if up.BaseFanUsername != nil {
			name = *up.BaseFanUsername
		}
		args = append(args, *up.BaseFanID, name)
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

func (s *Store) SetShareTokenHash(ctx context.Context, id int64, hash *string) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE playlists SET share_token_hash = ?, updated_at = ? WHERE id = ?`,
		hash, time.Now().UTC(), id)
	return err
}

// ---------- tracks ----------

func (s *Store) Tracks(ctx context.Context, playlistID int64) ([]*Track, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id, playlist_id, position, bc_track_id, bc_album_id, bc_band_id,
		        title, artist, COALESCE(album_title, ''), duration, art_id,
		        track_url, added_by, added_at
		   FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, id ASC`,
		playlistID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*Track{}
	for rows.Next() {
		var t Track
		if err := rows.Scan(&t.ID, &t.PlaylistID, &t.Position, &t.TrackID, &t.AlbumID,
			&t.BandID, &t.Title, &t.Artist, &t.AlbumTitle, &t.Duration, &t.ArtID,
			&t.TrackURL, &t.AddedBy, &t.AddedAt); err != nil {
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

// ---------- collaborators ----------

func (s *Store) Collaborators(ctx context.Context, playlistID int64) ([]*Collaborator, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT c.user_id, u.username, c.added_at
		   FROM playlist_collaborators c JOIN users u ON u.id = c.user_id
		  WHERE c.playlist_id = ? ORDER BY c.added_at ASC`, playlistID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*Collaborator{}
	for rows.Next() {
		var c Collaborator
		if err := rows.Scan(&c.UserID, &c.Username, &c.AddedAt); err != nil {
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
