package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

var ErrNotFound = errors.New("store: not found")

// Columns shared by every user lookup, so adding a field means touching one
// place rather than five queries.
const userColumns = `u.id, u.username, u.email, u.created_at,
       u.bandcamp_username, u.bandcamp_fan_id, u.avatar_url`

func scanUser(row interface{ Scan(...any) error }, extra ...any) (*User, error) {
	var u User
	var bcName, avatar sql.NullString

	dest := []any{&u.ID, &u.Username, &u.Email, &u.CreatedAt, &bcName, &u.BandcampFanID, &avatar}
	dest = append(dest, extra...)

	if err := row.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	u.BandcampUsername = bcName.String
	u.AvatarURL = avatar.String
	return &u, nil
}

func (s *Store) CreateUser(ctx context.Context, username, email, passwordHash string) (*User, error) {
	now := time.Now().UTC()
	res, err := s.DB.ExecContext(ctx,
		`INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		username, email, passwordHash, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return &User{ID: id, Username: username, Email: email, CreatedAt: now}, nil
}

// UserByLogin looks a user up by either username or email so the login form can
// accept both. It also returns the stored password hash.
func (s *Store) UserByLogin(ctx context.Context, login string) (*User, string, error) {
	var hash string
	u, err := scanUser(s.DB.QueryRowContext(ctx,
		`SELECT `+userColumns+`, u.password_hash
		   FROM users u WHERE u.username = ? OR u.email = ? LIMIT 1`, login, login), &hash)
	if err != nil {
		return nil, "", err
	}
	return u, hash, nil
}

func (s *Store) UserByID(ctx context.Context, id int64) (*User, error) {
	return scanUser(s.DB.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users u WHERE u.id = ?`, id))
}

func (s *Store) UserByUsername(ctx context.Context, username string) (*User, error) {
	return scanUser(s.DB.QueryRowContext(ctx,
		`SELECT `+userColumns+` FROM users u WHERE u.username = ?`, username))
}

// SearchUsers finds accounts by username prefix, for the collaborator invite
// field. Email is never matched or returned — inviting someone should not be a
// way to confirm which addresses have accounts.
func (s *Store) SearchUsers(ctx context.Context, query string, limit int) ([]*User, error) {
	if limit <= 0 || limit > 25 {
		limit = 10
	}
	// Escape LIKE wildcards so a query of "%" does not match every user.
	esc := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(query)

	rows, err := s.DB.QueryContext(ctx,
		`SELECT u.id, u.username, u.created_at, u.avatar_url FROM users u
		  WHERE u.username LIKE ? ORDER BY u.username ASC LIMIT ?`, esc+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*User{}
	for rows.Next() {
		var u User
		var avatar sql.NullString
		if err := rows.Scan(&u.ID, &u.Username, &u.CreatedAt, &avatar); err != nil {
			return nil, err
		}
		u.AvatarURL = avatar.String
		out = append(out, &u)
	}
	return out, rows.Err()
}

// ---------- account changes ----------

func (s *Store) PasswordHashByID(ctx context.Context, id int64) (string, error) {
	var hash string
	err := s.DB.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = ?`, id).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return hash, err
}

func (s *Store) UpdateUserEmail(ctx context.Context, id int64, email string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE users SET email = ? WHERE id = ?`, email, id)
	return err
}

func (s *Store) UpdateUserPassword(ctx context.Context, id int64, hash string) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, hash, id)
	return err
}

// SetBandcampLink stores (or clears, when username is empty) the user's linked
// Bandcamp profile.
func (s *Store) SetBandcampLink(ctx context.Context, id int64, username string, fanID *int64) error {
	if username == "" {
		_, err := s.DB.ExecContext(ctx,
			`UPDATE users SET bandcamp_username = NULL, bandcamp_fan_id = NULL WHERE id = ?`, id)
		return err
	}
	_, err := s.DB.ExecContext(ctx,
		`UPDATE users SET bandcamp_username = ?, bandcamp_fan_id = ? WHERE id = ?`, username, fanID, id)
	return err
}

// SetAvatarURL sets the picture shown beside this user's contributions. An
// empty string falls the UI back to generated initials.
func (s *Store) SetAvatarURL(ctx context.Context, id int64, url string) error {
	var value any
	if url != "" {
		value = url
	}
	_, err := s.DB.ExecContext(ctx, `UPDATE users SET avatar_url = ? WHERE id = ?`, value, id)
	return err
}

// ---------- sessions ----------

func (s *Store) CreateSession(ctx context.Context, tokenHash string, userID int64, userAgent string, ttl time.Duration) error {
	now := time.Now().UTC()
	if len(userAgent) > 255 {
		userAgent = userAgent[:255]
	}
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		tokenHash, userID, userAgent, now, now.Add(ttl))
	return err
}

// UserBySession resolves a session token hash to its user, rejecting expired
// rows in the same query.
func (s *Store) UserBySession(ctx context.Context, tokenHash string) (*User, error) {
	return scanUser(s.DB.QueryRowContext(ctx,
		`SELECT `+userColumns+`
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = ? AND s.expires_at > ?`,
		tokenHash, time.Now().UTC()))
}

// DeleteOtherSessions signs out every device except the one making the change.
// Changing a password should not leave an attacker's existing session alive.
func (s *Store) DeleteOtherSessions(ctx context.Context, userID int64, keepTokenHash string) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?`, userID, keepTokenHash)
	return err
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}
